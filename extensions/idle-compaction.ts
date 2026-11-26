/**
 * Idle compaction, as the Claude Code desktop app does it: a long conversation left idle is summarised in the
 * background, and the summary replaces it on the next message only if the prompt cache has expired by then.
 *
 * - Every request keeps the provider's prompt cache warm; Claude's lives an hour. A message after that writes the
 *   whole context to the cache anew, at the price of the whole context. A conversation of at least minTokens that
 *   stays idle for prepareMinutes after its last request is summarised in the background with Pi's own summariser,
 *   on the session's model, while the session stays free.
 * - The next message after coldMinutes since the last request compacts the session with that summary before it goes
 *   out, so it is sent with the small context only. A summary still being written by then is dropped, and the
 *   message goes out at once as it is: a message never waits for it. A message within coldMinutes, while the cache
 *   still holds the conversation, drops the summary unused.
 * - The summary covers the whole conversation; Pi keeps its recent messages (keepRecentTokens) as they are, as with
 *   /compact. A summary written for a conversation that changed meanwhile (a background result, a message) is
 *   dropped. The file lists go into the summary text; Pi carries those of a summary from an extension no further in
 *   the entry's details.
 * - After a start or /reload, the time of the last request comes from the session: a conversation idle for
 *   prepareMinutes is summarised at once, but only while its cache is still warm. Once coldMinutes have passed, a
 *   summary would cost a full read of the conversation, as much as the next message, so none is written.
 * - Only in the interactive session: a subagent and print mode end with their run.
 * - Settings, all optional, in ~/.pi/agent/idle-compaction.json: {"enabled": true, "minTokens": 100000,
 *   "prepareMinutes": 50, "coldMinutes": 60}. Under "providers", every key can be set for one provider and wins there
 *   over the top level, for a provider whose cache lives shorter ({"providers": {"openai": {"coldMinutes": 10,
 *   "prepareMinutes": 5}}}).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	generateSummaryWithUsage,
	getAgentDir,
	getLatestCompactionEntry,
} from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = path.join(getAgentDir(), "idle-compaction.json");

interface Settings {
	enabled: boolean;
	minTokens: number;
	prepareMinutes: number;
	coldMinutes: number;
}

const DEFAULTS: Settings = { enabled: true, minTokens: 100_000, prepareMinutes: 50, coldMinutes: 60 };

interface Summary {
	text: string;
	usage: Awaited<ReturnType<typeof generateSummaryWithUsage>>["usage"];
}

interface Prepared {
	/** The last entry of the conversation the summary covers. */
	anchor: string;
	abort: AbortController;
	result: Promise<Summary | undefined>;
	/** Set once the summary request has ended, with or without a summary. */
	settled: boolean;
}

function readSettings(provider: string | undefined): Settings {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
	} catch {
		// No file, or not JSON: the defaults.
	}
	const providers = (raw.providers ?? {}) as Record<string, Record<string, unknown>>;
	const merged = { ...raw, ...(provider ? providers[provider] : undefined) };
	const num = (key: keyof Settings): number => {
		const value = merged[key];
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : (DEFAULTS[key] as number);
	};
	return {
		enabled: merged.enabled !== false,
		minTokens: num("minTokens"),
		prepareMinutes: num("prepareMinutes"),
		coldMinutes: num("coldMinutes"),
	};
}

/** The id of the last entry that adds to what the model sees, or undefined for an empty conversation. */
function conversationAnchor(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.buildSessionProjection().entries;
	for (let i = entries.length - 1; i >= 0; i--) if (entries[i].messages.length > 0) return entries[i].sourceEntry.id;
	return undefined;
}

/** Time of the last request, from the last response of the conversation. */
function lastResponseTime(ctx: ExtensionContext): number | undefined {
	const messages = ctx.sessionManager.buildSessionProjection().messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return message.timestamp;
	}
	return undefined;
}

function fileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }): string {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const read = [...fileOps.read].filter((file) => !modified.has(file)).sort();
	const sections: string[] = [];
	if (read.length > 0) sections.push(`<read-files>\n${read.join("\n")}\n</read-files>`);
	if (modified.size > 0) sections.push(`<modified-files>\n${[...modified].sort().join("\n")}\n</modified-files>`);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

export default function (pi: ExtensionAPI) {
	let lastRequestAt: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let prepared: Prepared | undefined;
	/** Handed to session_before_compact while this extension compacts. */
	let applying: Summary | undefined;

	function drop(): void {
		prepared?.abort.abort();
		prepared = undefined;
	}

	function stopTimer(): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	function prepare(ctx: ExtensionContext): void {
		timer = undefined;
		const model = ctx.model;
		if (!model || !ctx.isIdle() || prepared) return;
		const settings = readSettings(model.provider);
		// A timer that fires late (a suspended machine) finds the cache cold: a summary would cost the full context.
		if (lastRequestAt === undefined || Date.now() - lastRequestAt >= settings.coldMinutes * 60_000) return;
		const tokens = ctx.getContextUsage()?.tokens;
		if (!settings.enabled || tokens == null || tokens < settings.minTokens) return;
		const anchor = conversationAnchor(ctx);
		if (!anchor) return;

		const branch = ctx.sessionManager.getBranch();
		const previousSummary = getLatestCompactionEntry(branch)?.summary;
		const messages: AgentMessage[] = ctx.sessionManager
			.buildSessionProjection()
			.messages.filter((message) => message.role !== "compactionSummary");
		const abort = new AbortController();
		const thinkingLevel = pi.getThinkingLevel();
		// The model registry's stream resolves the provider's login itself, as Pi's own requests do.
		const result: Promise<Summary | undefined> = generateSummaryWithUsage(
			messages,
			model,
			undefined,
			undefined,
			undefined,
			abort.signal,
			undefined,
			previousSummary,
			thinkingLevel,
			(m, context, options) => ctx.modelRegistry.streamSimple(m, context, options),
		).catch((error: unknown) => {
			if (!abort.signal.aborted && prepared?.abort === abort) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Idle compaction: the summary failed (${reason}); the next message goes out as it is.`, "warning");
			}
			return undefined;
		});
		const pending: Prepared = { anchor, abort, result, settled: false };
		void result.finally(() => {
			pending.settled = true;
		});
		prepared = pending;
	}

	function schedule(ctx: ExtensionContext): void {
		stopTimer();
		if (ctx.mode !== "tui" || lastRequestAt === undefined || prepared) return;
		const settings = readSettings(ctx.model?.provider);
		if (!settings.enabled) return;
		// The cache expired already (a session resumed after hours): no summary, see prepare().
		if (Date.now() - lastRequestAt >= settings.coldMinutes * 60_000) return;
		const delay = Math.max(0, lastRequestAt + settings.prepareMinutes * 60_000 - Date.now());
		timer = setTimeout(() => prepare(ctx), delay);
		timer.unref?.();
	}

	pi.on("session_start", (_event, ctx) => {
		stopTimer();
		drop();
		lastRequestAt = lastResponseTime(ctx);
		schedule(ctx);
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		drop();
	});

	pi.on("agent_start", () => {
		stopTimer();
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") lastRequestAt = Date.now();
	});

	pi.on("agent_settled", (_event, ctx) => {
		// The conversation went on: a summary written before covers too little.
		drop();
		schedule(ctx);
	});

	pi.on("input", async (_event, ctx) => {
		stopTimer();
		const pending = prepared;
		if (!pending) return { action: "continue" };
		prepared = undefined;
		const settings = readSettings(ctx.model?.provider);
		const cold = lastRequestAt !== undefined && Date.now() - lastRequestAt >= settings.coldMinutes * 60_000;
		// An unfinished summary is dropped: the message must not wait for it, which can take minutes on a long session.
		if (!cold || !pending.settled || !ctx.isIdle() || conversationAnchor(ctx) !== pending.anchor) {
			pending.abort.abort();
			return { action: "continue" };
		}
		const summary = await pending.result;
		if (!summary || conversationAnchor(ctx) !== pending.anchor) return { action: "continue" };
		applying = summary;
		const done = await new Promise<boolean>((resolve) =>
			ctx.compact({ onComplete: () => resolve(true), onError: () => resolve(false) }),
		);
		applying = undefined;
		if (done) {
			const idle = Math.round((Date.now() - (lastRequestAt ?? Date.now())) / 60_000);
			ctx.ui.notify(
				`Idle compaction: the prompt cache expired after ${idle} min; the summary written meanwhile replaced the conversation.`,
				"info",
			);
		}
		return { action: "continue" };
	});

	pi.on("session_before_compact", (event) => {
		const summary = applying;
		if (!summary || event.reason !== "manual") return undefined;
		const { preparation } = event;
		return {
			compaction: {
				summary: summary.text + fileLists(preparation.fileOps),
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage: summary.usage,
			},
		};
	});
}
