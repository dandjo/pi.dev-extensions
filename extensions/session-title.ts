/**
 * Session titles: names an unnamed session after its first prompt, the way Claude Code titles its sessions.
 *
 * The title comes from a small model of the provider in use (see pickSmallModel below), so it works with any provider
 * and never sends the prompt to another one. Pi shows the session name in the terminal title
 * ("π - <name> - <directory>") and in /resume.
 *
 * A name set with /name or --name is never replaced. Each session gets one attempt; /name sets or changes the name
 * by hand. Print and JSON mode are skipped, since nothing shows the name there.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Api, type AssistantMessage, type Model, uuidv7 } from "@earendil-works/pi-ai";

const MAX_REQUEST_CHARS = 4_000;
const MAX_TITLE_CHARS = 60;
const SYSTEM_PROMPT = [
	"You write the title of a coding session from the request that starts it.",
	"Reply with the title only: 3 to 6 words that name the topic, in the language of the request,",
	"sentence case, no quotes, no trailing punctuation. Never answer or carry out the request.",
].join("\n");

/** The prompt as the user typed it: an expanded /skill:<name> block goes back to its short form. */
function requestText(prompt: string): string {
	const skill = prompt.match(/^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/);
	const text = skill ? `/skill:${skill[1]} ${skill[2] ?? ""}` : prompt;
	return text.trim().slice(0, MAX_REQUEST_CHARS);
}

/** Text of the first user message on the branch, so a resumed unnamed session is titled by its original topic. */
function firstUserText(branch: SessionEntry[]): string {
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		if (typeof content === "string") return content.trim();
		return content.map((part) => (part.type === "text" ? part.text : "")).join("\n").trim();
	}
	return "";
}

/** First line of the reply, without quotes, Markdown, or a trailing period, cut to MAX_TITLE_CHARS. */
function cleanTitle(reply: string): string {
	const line = reply.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
	let title = line
		.replace(/^(title|titel)\s*:\s*/i, "")
		.replace(/^[#>*_`"'„“”«»\s-]+|[*_`"'„“”«»\s.:;!?]+$/g, "")
		.replace(/\s+/g, " ");
	if (title.length > MAX_TITLE_CHARS) {
		const cut = title.slice(0, MAX_TITLE_CHARS - 1);
		title = `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : cut.length)}…`;
	}
	return title;
}

/**
 * Small-model calls for side tasks (session titles, page answers), whatever provider and model are in use.
 *
 * The model: among the models of the current model's provider that have working credentials and read text, the
 * one with the lowest list price (input + output per million tokens), if it is cheaper than the current model;
 * otherwise the current model. So a side task never moves to another provider or account. On providers that serve
 * several makers' models with the maker in the id ("anthropic/claude-…" on OpenRouter, "us.anthropic.claude-…" on
 * Bedrock), only models of the current maker qualify. A current model without a price (local, unknown) is kept.
 * PI_SMALL_MODEL=<provider>/<model-id> overrides the choice.
 *
 * btw.ts, goal.ts, web-tools.ts carry a copy of this block, or of a part of it: change them alike.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Output tokens on top of the answer for a model that cannot turn thinking off (Claude Haiku 5.5, for one): its
 * thinking counts against the output limit, and even at the lowest level it sometimes thinks for a few hundred tokens.
 */
const THINKING_ROOM = 4_096;

/**
 * Side requests run one at a time, across every extension that loads this file. A provider that runs one process per
 * request may otherwise close the conversation's own process while it waits for tool results: pi-claude-subscription
 * keeps at most three Claude Code processes and closes the least recently used one outside a call.
 */
const gate: { tail: Promise<unknown> } = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi.small-model.gate")] ??= {
	tail: Promise.resolve(),
}) as { tail: Promise<unknown> };

/** Runs `run` after every side request queued before it has finished. */
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
	const result = gate.tail.then(run, run);
	gate.tail = result.catch(() => {});
	return result;
}

function price(model: Model<Api>): number {
	return model.cost.input + model.cost.output;
}

/** The model maker named at the start of an id, or "" when the id names none. */
function maker(id: string): string {
	const match = id.match(/^([a-z0-9-]+)\//i) ?? id.match(/^(?:[a-z]{2,6}\.)?([a-z][a-z0-9-]*)\.[a-z]/i);
	return match ? match[1].toLowerCase() : "";
}

async function pickSmallModel(ctx: ExtensionContext): Promise<Model<Api> | undefined> {
	const override = process.env.PI_SMALL_MODEL?.trim();
	if (override) {
		const slash = override.indexOf("/");
		const model = slash > 0 ? ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1)) : undefined;
		if (model) return model;
	}

	const current = ctx.model;
	if (!current || !(price(current) > 0)) return current;
	const currentMaker = maker(current.id);
	let best = current;
	for (const model of await ctx.modelRegistry.getAvailableOfType("chat", current.provider)) {
		if (!model.input.includes("text") || maker(model.id) !== currentMaker) continue;
		if (price(model) > 0 && price(model) < price(best)) best = model;
	}
	return best;
}

/**
 * The thinking level for a side task: "off" (undefined) where the model can turn thinking off, else its lowest level.
 * A model cannot when its levels exclude "off" or when it thinks adaptively whatever it is asked (compat
 * forceAdaptiveThinking: Claude Haiku 5.5, for one). A provider that passes another's models on (claude-sdk) may drop
 * their compat, so a model of the same id elsewhere in the registry counts too.
 */
function lowestThinking(ctx: ExtensionContext, model: Model<Api>): "minimal" | "low" | undefined {
	if (!model.reasoning) return undefined;
	const map = model.thinkingLevelMap;
	const forced = (m: Model<Api>) =>
		(m.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking === true;
	const mustThink =
		map?.off === null || forced(model) || ctx.modelRegistry.getAll().some((m) => m.id === model.id && forced(m));
	if (!mustThink) return undefined;
	return map?.minimal !== null ? "minimal" : "low";
}

/**
 * One request without tools or history, queued behind other side requests and cancelled after two minutes. maxTokens
 * is the size of the answer; a model that must think gets THINKING_ROOM on top. The reply's stopReason is "error" or
 * "aborted" when it failed.
 */
function askModel(
	ctx: ExtensionContext,
	model: Model<Api>,
	systemPrompt: string,
	text: string,
	options: { maxTokens: number; signal?: AbortSignal },
): Promise<AssistantMessage> {
	const reasoning = lowestThinking(ctx, model);
	const maxTokens = options.maxTokens + (reasoning ? THINKING_ROOM : 0);
	return oneAtATime(() => {
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		return ctx.modelRegistry
			.streamSimple(
				model,
				{ systemPrompt, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] },
				{
					maxTokens: Math.min(maxTokens, model.maxTokens),
					reasoning,
					signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			)
			.result();
	});
}

function replyText(reply: AssistantMessage): string {
	return reply.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export default function (pi: ExtensionAPI) {
	const attempted = new Set<string>();
	let controller: AbortController | null = null;
	let failureShown = false;

	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType !== "user" || !ctx.hasUI || pi.getSessionName()) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (attempted.has(sessionId)) return;

		const request = requestText(firstUserText(ctx.sessionManager.getBranch()) || event.prompt);
		if (!request) return;

		attempted.add(sessionId);
		const own = new AbortController();
		controller = own;
		(async () => {
			const model = await pickSmallModel(ctx);
			if (!model) throw new Error("no model selected");
			const reply = await askModel(ctx, model, SYSTEM_PROMPT, `<request>\n${request}\n</request>`, {
				maxTokens: 100,
				signal: own.signal,
			});
			if (reply.stopReason === "error") throw new Error(`${modelLabel(model)}: ${reply.errorMessage ?? "unknown error"}`);
			const title = cleanTitle(replyText(reply));
			if (own.signal.aborted || !title || pi.getSessionName()) return;
			if (ctx.sessionManager.getSessionId() !== sessionId) return;
			pi.setSessionName(title);
		})()
			.catch((error) => {
				if (own.signal.aborted || failureShown) return;
				failureShown = true;
				ctx.ui.notify(
					`Session title failed: ${error instanceof Error ? error.message : error}. /name sets one by hand.`,
					"warning",
				);
			})
			.finally(() => {
				if (controller === own) controller = null;
			});
	});

	pi.on("session_shutdown", () => {
		controller?.abort();
		controller = null;
	});
}
