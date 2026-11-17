/**
 * Context GC: keeps long conversations small by taking what the model no longer needs out of older turns.
 *
 * - In every turn older than the last ten assistant messages, it removes the thinking of the response, shortens long
 *   tool inputs (a written file, a long script) and replaces long tool outputs and images with a stub that names the
 *   command or file and keeps the first and last lines. The session file keeps everything: the cuts are Pi's own
 *   context_edit entries, so the transcript, /tree, exports, and session totals stay complete, and navigating to a point
 *   before a cut brings the full text back.
 * - Every cut makes the provider write its prompt cache anew from the first changed message, so it cuts in batches:
 *   when at least 100k tokens can go, at the end of a turn. And when the cache is cold anyway, after an hour without
 *   a request or after a switch to another model (/model, Ctrl+P), it cuts whatever it can before the first request,
 *   so the cache is built from the smaller context only. That request carries the cuts itself; they are stored at
 *   the end of its turn.
 * - The system prompt carries a section that tells the model about the stubs. Its text stays the same, so the prompt
 *   cache keeps everything before the first cut. pi-claude-subscription up to 0.2.4 is the exception: after an edit
 *   in older messages it resumes its own transcript at the last unchanged message and leaves out every later
 *   response. For it the section names the pass, appears with the first cut, and changes with every cut, which makes
 *   the provider synthesize the conversation instead, at the price of writing all of it to the cache again. The
 *   fixes of its pull request #4 ("Resume correctly after edited history") make that unnecessary; with "forceRebuild":
 *   "auto" the extension looks for them in the installed package.
 * - /gc cuts at the next request, regardless of the thresholds; /gc status shows what was cut and what could go now.
 * - Settings in ~/.pi/agent/context-gc.json, every key optional: {"enabled": true, "keepRecent": 10,
 *   "minResultChars": 4000, "minArgChars": 2000, "batchTokens": 100000, "coldMinutes": 60, "coldMinTokens": 5000,
 *   "thinking": true, "toolResults": true, "toolArgs": true, "keepTools": ["Agent", "AskUserQuestion"],
 *   "forceRebuild": "auto"} (true or false override the detection).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
	DefaultPackageManager,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = path.join(getAgentDir(), "context-gc.json");
const ENTRY_TYPE = "context-gc";
const SECTION = "context_gc";
const STUB = "[context-gc:";
/** Characters per token for estimates; code and German text run below 4. */
const CHARS_PER_TOKEN = 3.5;
const IMAGE_TOKENS = 1600;
const HEAD_CHARS = 500;
const TAIL_CHARS = 300;
const LINE_CHARS = 200;
const ARG_HEAD = 400;
const ARG_TAIL = 150;

interface Config {
	enabled: boolean;
	keepRecent: number;
	minResultChars: number;
	minArgChars: number;
	batchTokens: number;
	coldMinutes: number;
	coldMinTokens: number;
	thinking: boolean;
	toolResults: boolean;
	toolArgs: boolean;
	keepTools: string[];
	forceRebuild: "auto" | boolean;
}

const DEFAULTS: Config = {
	enabled: true,
	keepRecent: 10,
	minResultChars: 4000,
	minArgChars: 2000,
	batchTokens: 100_000,
	coldMinutes: 60,
	coldMinTokens: 5_000,
	thinking: true,
	toolResults: true,
	toolArgs: true,
	keepTools: ["Agent", "AskUserQuestion"],
	forceRebuild: "auto",
};

function loadConfig(): { config: Config; problem?: string } {
	let raw: any;
	try {
		raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: DEFAULTS };
		return { config: DEFAULTS, problem: `${CONFIG_FILE} is not valid JSON; the defaults apply` };
	}
	const config: Config = { ...DEFAULTS };
	const wrong: string[] = [];
	for (const key of Object.keys(DEFAULTS) as (keyof Config)[]) {
		const value = raw?.[key];
		if (value === undefined) continue;
		const fallback = DEFAULTS[key];
		const ok = Array.isArray(fallback)
			? Array.isArray(value) && value.every((v) => typeof v === "string")
			: key === "forceRebuild"
				? value === "auto" || typeof value === "boolean"
				: typeof value === typeof fallback && (typeof value !== "number" || (Number.isFinite(value) && value >= 0));
		if (ok) (config as any)[key] = value;
		else wrong.push(key);
	}
	return { config, problem: wrong.length ? `${CONFIG_FILE}: ignored ${wrong.join(", ")} (wrong type)` : undefined };
}

type Block = { type: string; [key: string]: any };
type Message = { role: string; content?: any; [key: string]: any };
type Entry = { sourceEntry: { id: string; type: string; message?: Message; customType?: string; data?: any }; messages: Message[] };

interface Edit {
	targetId: string;
	/** Matches the message in a request: role and tool call id or timestamp. */
	key: string;
	content: Block[];
}

interface Plan {
	edits: Edit[];
	tokens: number;
	thinking: number;
	results: number;
	images: number;
	args: number;
}

interface Pending extends Plan {
	pass: number;
	reason: "cold" | "model" | "manual";
}

const messageKey = (m: Message) => `${m.role}:${m.role === "toolResult" ? m.toolCallId : m.timestamp}`;
const textLength = (blocks: Block[]) => blocks.reduce((n, b) => n + (b.type === "text" ? (b.text?.length ?? 0) : 0), 0);
const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const fmtTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

/** First and last lines of a text, within HEAD_CHARS and TAIL_CHARS, each line cut at LINE_CHARS. */
function excerpt(text: string): string {
	const lines = text.split("\n").map((l) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}…` : l));
	const head: string[] = [];
	let used = 0;
	let i = 0;
	for (; i < lines.length && used + lines[i].length <= HEAD_CHARS; i++) {
		head.push(lines[i]);
		used += lines[i].length + 1;
	}
	const tail: string[] = [];
	used = 0;
	for (let j = lines.length - 1; j >= i && used + lines[j].length <= TAIL_CHARS; j--) {
		tail.unshift(lines[j]);
		used += lines[j].length + 1;
	}
	const skipped = lines.length - head.length - tail.length;
	return [...head, ...(skipped > 0 ? [`… (${skipped} lines removed) …`] : []), ...tail].join("\n");
}

/** What the stub says the output came from. */
function origin(call: { name: string; arguments: any } | undefined, toolName: string): string {
	const args = call?.arguments ?? {};
	if (typeof args.command === "string") return `command: ${oneLine(args.command, 160)}`;
	if (typeof args.path === "string") {
		const range = args.offset || args.limit ? ` (offset ${args.offset ?? 1}, limit ${args.limit ?? "-"})` : "";
		return `${toolName} ${args.path}${range}`;
	}
	return `${toolName} ${oneLine(JSON.stringify(args), 160)}`;
}

/** Arguments with every long string cut to its start and end; returns the characters removed. */
function shrinkArgs(value: any, minChars: number): { value: any; removed: number } {
	if (typeof value === "string") {
		if (value.length <= Math.max(minChars / 2, ARG_HEAD + ARG_TAIL + 100)) return { value, removed: 0 };
		const cut = value.length - ARG_HEAD - ARG_TAIL;
		return { value: `${value.slice(0, ARG_HEAD)}\n${STUB} ${cut} characters removed]\n${value.slice(-ARG_TAIL)}`, removed: cut - 40 };
	}
	if (Array.isArray(value)) {
		let removed = 0;
		const out = value.map((v) => {
			const r = shrinkArgs(v, minChars);
			removed += r.removed;
			return r.value;
		});
		return { value: out, removed };
	}
	if (value && typeof value === "object") {
		let removed = 0;
		const out: Record<string, any> = {};
		for (const [k, v] of Object.entries(value)) {
			const r = shrinkArgs(v, minChars);
			removed += r.removed;
			out[k] = r.value;
		}
		return { value: out, removed };
	}
	return { value, removed: 0 };
}

/** Tokens of hidden thinking in a response: its output minus what it shows. */
function thinkingTokens(m: Message, blocks: Block[]): number {
	const shown = blocks.reduce(
		(n, b) => n + (b.type === "text" ? (b.text?.length ?? 0) : b.type === "toolCall" ? JSON.stringify(b.arguments ?? {}).length : 0),
		0,
	);
	const output = m.usage?.output;
	if (typeof output === "number" && output > 0) return Math.max(0, output - shown / CHARS_PER_TOKEN);
	return blocks.reduce((n, b) => n + (b.type === "thinking" ? (b.thinking?.length ?? 0) / CHARS_PER_TOKEN : 0), 0);
}

/** The cuts that can be made in the projected context: everything before the last keepRecent responses. */
function plan(entries: readonly Entry[], config: Config): Plan {
	const result: Plan = { edits: [], tokens: 0, thinking: 0, results: 0, images: 0, args: 0 };
	// The latest response always stays whole: a tool loop needs its thinking.
	const keepRecent = Math.max(1, Math.floor(config.keepRecent));
	const assistants: number[] = [];
	entries.forEach((e, i) => {
		if (e.messages.some((m) => m.role === "assistant")) assistants.push(i);
	});
	if (assistants.length <= keepRecent) return result;
	const boundary = assistants[assistants.length - keepRecent] ?? entries.length;
	const calls = new Map<string, { name: string; arguments: any }>();
	for (const e of entries) {
		for (const m of e.messages) {
			if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
			for (const b of m.content) if (b.type === "toolCall") calls.set(b.id, { name: b.name, arguments: b.arguments });
		}
	}
	for (let i = 0; i < boundary; i++) {
		const entry = entries[i];
		if (entry.sourceEntry.type !== "message" || entry.messages.length !== 1) continue;
		const m = entry.messages[0];
		if (!Array.isArray(m.content)) continue;
		const blocks = m.content as Block[];
		if (m.role === "assistant") {
			if (m.stopReason === "error" || m.stopReason === "aborted") continue;
			let tokens = 0;
			let changed = false;
			const hasThinking = config.thinking && blocks.some((b) => b.type === "thinking");
			if (hasThinking) {
				tokens += thinkingTokens(m, blocks);
				changed = true;
				result.thinking++;
			}
			const content: Block[] = [];
			for (const b of blocks) {
				if (b.type === "thinking" && config.thinking) continue;
				if (b.type === "toolCall" && config.toolArgs && JSON.stringify(b.arguments ?? {}).length > config.minArgChars) {
					const shrunk = shrinkArgs(b.arguments, config.minArgChars);
					if (shrunk.removed > 0) {
						content.push({ ...b, arguments: shrunk.value });
						tokens += shrunk.removed / CHARS_PER_TOKEN;
						changed = true;
						result.args++;
						continue;
					}
				}
				content.push(b);
			}
			if (!changed) continue;
			if (!content.some((b) => (b.type === "text" && b.text) || b.type === "toolCall")) {
				content.push({ type: "text", text: `${STUB} thinking removed]` });
			}
			result.edits.push({ targetId: entry.sourceEntry.id, key: messageKey(m), content });
			result.tokens += tokens;
		} else if (m.role === "toolResult" && config.toolResults) {
			if (config.keepTools.includes(m.toolName)) continue;
			const text = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
			if (text.startsWith(STUB)) continue;
			const images = blocks.filter((b) => b.type === "image").length;
			const long = text.length >= config.minResultChars;
			if (!long && images === 0) continue;
			const call = calls.get(m.toolCallId);
			const notes: string[] = [];
			let body = text;
			if (long) notes.push(`output of ${text.length} characters cut to its first and last lines`);
			if (images) notes.push(`${images} image${images > 1 ? "s" : ""} removed`);
			if (long) body = excerpt(text);
			const stub = `${STUB} ${notes.join(", ")}; ${origin(call, m.toolName)}]${body ? `\n${body}` : ""}`;
			result.edits.push({ targetId: entry.sourceEntry.id, key: messageKey(m), content: [{ type: "text", text: stub }] });
			result.tokens += Math.max(0, textLength(blocks) - stub.length) / CHARS_PER_TOKEN + images * IMAGE_TOKENS;
			if (long) result.results++;
			result.images += images;
		}
	}
	return result;
}

/** The highest pass recorded on the branch. */
function passes(ctx: ExtensionContext): { pass: number; tokens: number } {
	let pass = 0;
	let tokens = 0;
	for (const e of ctx.sessionManager.getBranch() as any[]) {
		if (e.type === "custom" && e.customType === ENTRY_TYPE) {
			pass = Math.max(pass, Number(e.data?.pass) || 0);
			tokens += Number(e.data?.tokens) || 0;
		}
	}
	return { pass, tokens };
}

/** When the last request of the branch started (assistant messages carry the start of their request), and its model. */
function lastRequest(ctx: ExtensionContext): { at: number; model: string } | undefined {
	const branch = ctx.sessionManager.getBranch() as any[];
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i].type === "message" ? branch[i].message : undefined;
		if (m?.role === "assistant" && typeof m.timestamp === "number") return { at: m.timestamp, model: `${m.provider}/${m.model}` };
	}
	return undefined;
}

/** The section for the system prompt; with a pass it changes with every cut, without one it never changes. */
function sectionText(pass?: number): string {
	return [
		`<${SECTION}>`,
		pass === undefined
			? "Older parts of this conversation may be cut to keep the context small: the thinking of older responses, long inputs of older tool calls, and long outputs and images of older tool results."
			: `Older parts of this conversation were cut to keep the context small (pass ${pass}): the thinking of older responses, long inputs of older tool calls, and long outputs and images of older tool results.`,
		`A cut output reads "${STUB} …]" and keeps its first and last lines; a cut input keeps its start and end. When you need a cut output again, run the command or read the file again instead of guessing what it said.`,
		`</${SECTION}>`,
	].join("\n");
}

let resumeFix: boolean | undefined;

/**
 * Whether the configured pi-claude-subscription carries the fixes of its pull request #4: fix 1 writes the responses
 * after an edit into a fork of Claude Code's transcript (appendToSession), fix 5 finds an anchor in history the
 * provider wrote itself (rememberWritten). Looked up once per process. The package listing is the same as in
 * claude-marketplaces.ts.
 */
function providerResumesEdits(): boolean {
	if (resumeFix !== undefined) return resumeFix;
	resumeFix = false;
	try {
		const cwd = process.cwd();
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		for (const pkg of new DefaultPackageManager({ cwd, agentDir, settingsManager }).listConfiguredPackages()) {
			if (!pkg.installedPath) continue;
			const dir = path.resolve(pkg.installedPath);
			let name: unknown;
			try {
				name = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name;
			} catch {
				continue;
			}
			if (name !== "pi-claude-subscription") continue;
			const sessions = readFileSync(path.join(dir, "src", "cc-sessions.ts"), "utf8");
			const provider = readFileSync(path.join(dir, "src", "provider.ts"), "utf8");
			resumeFix = sessions.includes("appendToSession") && provider.includes("rememberWritten");
			break;
		}
	} catch {
		// Unreadable package or settings: keep forcing the rebuild, which is safe with every version.
	}
	return resumeFix;
}

/** Whether the section has to change with every cut, so the provider rebuilds its transcript. */
function forceRebuild(ctx: ExtensionContext, config: Config): boolean {
	if (typeof config.forceRebuild === "boolean") return config.forceRebuild;
	return ctx.model?.provider === "claude-sdk" && !providerResumesEdits();
}

function describe(p: Plan): string {
	const parts = [
		p.results && `${p.results} output${p.results > 1 ? "s" : ""}`,
		p.thinking && `${p.thinking} thinking block${p.thinking > 1 ? "s" : ""}`,
		p.args && `${p.args} tool input${p.args > 1 ? "s" : ""}`,
		p.images && `${p.images} image${p.images > 1 ? "s" : ""}`,
	].filter(Boolean);
	return `~${fmtTokens(p.tokens)} tokens (${parts.join(", ")})`;
}

export default function (pi: ExtensionAPI) {
	let pending: Pending | undefined;
	let manual = false;
	let warned = false;
	/** Set by /model or Ctrl+P; the cache of the new model holds nothing of this conversation. */
	let switched = false;

	const settings = (ctx: ExtensionContext): Config => {
		const { config, problem } = loadConfig();
		if (problem && !warned && ctx.hasUI) {
			warned = true;
			ctx.ui.notify(`context-gc: ${problem}`, "warning");
		}
		return config;
	};

	const drafts = (p: Plan, pass: number, reason: string) => [
		...p.edits.map((e) => ({ type: "context_edit" as const, targetId: e.targetId, replacement: { content: e.content as any } })),
		{ type: "custom" as const, customType: ENTRY_TYPE, data: { pass, reason, tokens: Math.round(p.tokens), edits: p.edits.length } },
	];

	pi.on("session_start", () => {
		pending = undefined;
		manual = false;
		switched = false;
	});

	pi.on("model_select", (event) => {
		const before = event.previousModel;
		if (before && (before.provider !== event.model.provider || before.id !== event.model.id)) switched = true;
	});

	// Store the cuts a request carried, or cut a batch when enough has piled up.
	pi.on("turn_end", (event, ctx) => {
		const config = settings(ctx);
		if (pending) {
			const stored = pending;
			pending = undefined;
			return { entries: [...event.entries, ...drafts(stored, stored.pass, stored.reason)] };
		}
		if (!config.enabled || event.outcome !== "completed") return undefined;
		const p = plan(event.context.contextEntries as unknown as Entry[], config);
		if (p.edits.length === 0 || p.tokens < config.batchTokens) return undefined;
		const pass = passes(ctx).pass + 1;
		if (ctx.hasUI) ctx.ui.notify(`context-gc: cut ${describe(p)} from older turns (pass ${pass})`, "info");
		return { entries: [...event.entries, ...drafts(p, pass, "batch")] };
	});

	// Cut before the request when the cache is cold anyway or /gc asked for it, and mark the prompt with the pass.
	pi.on("context_with_system", (event, ctx) => {
		const config = settings(ctx);
		if (!config.enabled && !pending) return undefined;
		const done = passes(ctx).pass;
		if (!pending && config.enabled) {
			const last = lastRequest(ctx);
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			// Switching back and forth before the next request is no switch.
			const newModel = switched && last !== undefined && current !== undefined && last.model !== current;
			switched = false;
			const cold = last !== undefined && Date.now() - last.at >= config.coldMinutes * 60_000;
			if (cold || newModel || manual) {
				const p = plan(ctx.sessionManager.buildSessionProjection().entries as unknown as Entry[], config);
				if (p.edits.length > 0 && p.tokens >= (manual ? 1 : config.coldMinTokens)) {
					const next: Pending = { ...p, pass: done + 1, reason: manual ? "manual" : newModel ? "model" : "cold" };
					pending = next;
					if (ctx.hasUI) {
						const why = manual
							? "as /gc asked"
							: newModel
								? `the cache of ${current} holds nothing of this conversation yet`
								: `the cache expired after ${Math.round((Date.now() - (last?.at ?? 0)) / 60_000)} min`;
						ctx.ui.notify(`context-gc: cut ${describe(p)} before this request, ${why} (pass ${next.pass})`, "info");
					}
				}
				manual = false;
			}
		}
		const pass = pending ? pending.pass : done;
		const rebuild = forceRebuild(ctx, config);
		// A stable section is there from the first request on, so the prompt never changes; the other one only after cuts.
		if (pass === 0 && (rebuild || !config.enabled)) return undefined;
		const section = sectionText(rebuild ? pass : undefined);
		const byKey = new Map((pending?.edits ?? []).map((e) => [e.key, e]));
		let marked = false;
		const messages = (event.messages as Message[]).map((m) => {
			if (m.role === "system" && !marked) {
				marked = true;
				return { ...m, sections: { ...(m.sections ?? {}), [SECTION]: section } };
			}
			const edit = byKey.get(messageKey(m));
			return edit ? { ...m, content: edit.content } : m;
		});
		return { messages: messages as any };
	});

	pi.registerCommand("gc", {
		description: "Cut older tool outputs and thinking from the context at the next request (/gc status shows what was cut)",
		handler: async (args, ctx) => {
			const config = loadConfig().config;
			const p = plan(ctx.sessionManager.buildSessionProjection().entries as unknown as Entry[], config);
			const done = passes(ctx);
			if (args.trim() === "status") {
				const usage = ctx.getContextUsage();
				const last = lastRequest(ctx);
				const age = last === undefined ? "no request yet" : `last request ${Math.round((Date.now() - last.at) / 60_000)} min ago`;
				ctx.ui.notify(
					[
						`context-gc ${config.enabled ? "on" : "off"}: ${done.pass} pass${done.pass === 1 ? "" : "es"} cut ~${fmtTokens(done.tokens)} tokens so far.`,
						`Context now: ${usage?.tokens != null ? `~${fmtTokens(usage.tokens)} tokens` : "unknown"}; ${age}.`,
						p.edits.length ? `Could go now: ${describe(p)}.` : "Nothing older than the last responses to cut.",
						`Batch cut from ${fmtTokens(config.batchTokens)} tokens, cold cut after ${config.coldMinutes} min; settings in ${CONFIG_FILE}.`,
						forceRebuild(ctx, config)
							? "Every cut rebuilds the provider's transcript and writes the whole context to the cache again."
							: "The cache keeps everything before the first cut.",
					].join("\n"),
					"info",
				);
				return;
			}
			if (p.edits.length === 0) {
				ctx.ui.notify(`context-gc: nothing older than the last ${config.keepRecent} responses to cut`, "info");
				return;
			}
			manual = true;
			ctx.ui.notify(`context-gc: will cut ${describe(p)} at the next request`, "info");
		},
	});
}
