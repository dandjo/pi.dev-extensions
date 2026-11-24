/**
 * Compaction cut: places the cut of a compaction by measured token counts instead of Pi's estimate.
 *
 * - A compaction keeps the most recent keepRecentTokens of the conversation as they are. Pi finds that point with an
 *   estimate: four characters per token, and only the thinking it can see. With Claude, German text, JSON and code
 *   run nearer three characters, and Opus shows next to none of its thinking, which the API counts all the same; Pi's
 *   default of 20,000 kept 75k tokens in a measured session.
 * - Every response carries the real size of the request that produced it. The growth from one response's request to
 *   the next is the real size of what lies between them: the response itself, its thinking included, and the tool
 *   results and messages after it. That growth is shared out over those entries in proportion to their estimates;
 *   the response gets its output tokens as its estimate. Where no such measure holds (a compaction or a model switch
 *   in between, a request that shrank after a context edit), an entry keeps its estimate, and so do the response
 *   last of all and what follows it, except that the response counts its output tokens.
 * - From that it walks back from the end as Pi does, to the cut point where keepRecentTokens is reached, and moves
 *   the cut there when that keeps less than Pi's own cut: it changes the compaction Pi prepared (the kept entries, the
 *   messages to summarise, a split turn, the files read and changed), so Pi's summary, or another extension's from
 *   session_before_compact, covers exactly the part that goes. It never keeps more than Pi would.
 * - It acts on /compact, the compact tool, and the threshold; a compaction to recover from an overflowing context
 *   stays as Pi prepared it.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent";

type Projected = { sourceEntry: { type: string; id: string }; messages: AgentMessage[] };
interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

const CUT_POINT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const TURN_START_ROLES = new Set(["user", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

const isCutPoint = (entry: Projected) =>
	entry.sourceEntry.type !== "compaction" && entry.messages.some((message) => CUT_POINT_ROLES.has(message.role));
const isTurnStart = (entry: Projected) => entry.messages.some((message) => TURN_START_ROLES.has(message.role));

/** Messages of an entry that a summary covers, as Pi takes them: no compaction, no system prompt state. */
const summarised = (entry: Projected): AgentMessage[] =>
	entry.sourceEntry.type === "compaction" ? [] : entry.messages.filter((message) => message.role !== "system");

/** Files read, written and edited by a message's tool calls, as Pi collects them for the summary. */
function addFileOps(message: AgentMessage, fileOps: FileOps): void {
	const add = (name: unknown, args: unknown) => {
		const path = (args as { path?: unknown } | undefined)?.path;
		if (typeof path !== "string" || !path) return;
		if (name === "read") fileOps.read.add(path);
		else if (name === "write") fileOps.written.add(path);
		else if (name === "edit") fileOps.edited.add(path);
	};
	if (message.role === "toolResult") {
		const nested = (message as { nestedCalls?: { calls?: { name: unknown; arguments: unknown }[] } }).nestedCalls;
		for (const call of nested?.calls ?? []) add(call.name, call.arguments);
		return;
	}
	if (message.role !== "assistant") return;
	for (const block of message.content) if (block.type === "toolCall") add(block.name, block.arguments);
}

type Assistant = Extract<AgentMessage, { role: "assistant" }>;

const requestSize = (message: Assistant) => message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
const measured = (message: AgentMessage): message is Assistant =>
	message.role === "assistant" &&
	message.stopReason !== "error" &&
	message.stopReason !== "aborted" &&
	requestSize(message) > 0;

/** Token size of each entry from start on: measured where the requests allow it, estimated elsewhere. */
function entrySizes(entries: Projected[], start: number): number[] {
	const size = (message: AgentMessage) => (measured(message) ? message.usage.output : estimateTokens(message));
	const sizes = entries.map((entry, i) =>
		i < start ? 0 : entry.messages.reduce((sum, message) => sum + size(message), 0),
	);
	const anchors: { index: number; message: Assistant }[] = [];
	for (let i = start; i < entries.length; i++) {
		const message = entries[i].messages.find(measured);
		if (message) anchors.push({ index: i, message });
	}
	for (let k = 0; k + 1 < anchors.length; k++) {
		const from = anchors[k];
		const to = anchors[k + 1];
		const between = entries.slice(from.index + 1, to.index);
		if (from.message.model !== to.message.model || from.message.provider !== to.message.provider) continue;
		if (between.some((entry) => entry.sourceEntry.type === "compaction")) continue;
		const growth = requestSize(to.message) - requestSize(from.message);
		let estimated = 0;
		for (let i = from.index; i < to.index; i++) estimated += sizes[i];
		if (estimated <= 0 || growth <= estimated) continue;
		const scale = growth / estimated;
		for (let i = from.index; i < to.index; i++) sizes[i] *= scale;
	}
	return sizes;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", (event, ctx) => {
		if (event.reason === "overflow") return undefined;
		const preparation = event.preparation;
		const entries = ctx.sessionManager.buildSessionProjection().entries as Projected[];
		const previous = entries.findIndex((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
		const start = previous + 1;
		const piCut = entries.findIndex((entry) => entry.sourceEntry.id === preparation.firstKeptEntryId);
		if (piCut < 0) return undefined;

		const sizes = entrySizes(entries, start);
		const cutPoints: number[] = [];
		for (let i = start; i < entries.length; i++) if (isCutPoint(entries[i])) cutPoints.push(i);
		let kept = 0;
		let cut = -1;
		for (let i = entries.length - 1; i >= start; i--) {
			kept += sizes[i];
			if (kept >= preparation.settings.keepRecentTokens) {
				cut = cutPoints.find((candidate) => candidate >= i) ?? -1;
				break;
			}
		}
		if (cut <= piCut) return undefined;
		while (cut > start) {
			const before = entries[cut - 1];
			if (before.sourceEntry.type === "compaction" || before.messages.length > 0) break;
			cut--;
		}
		if (cut <= piCut) return undefined;

		let turnStart = -1;
		if (!isTurnStart(entries[cut])) {
			for (let i = cut; i >= start; i--) {
				if (isTurnStart(entries[i])) {
					turnStart = i;
					break;
				}
			}
		}
		const split = turnStart !== -1;
		const historyEnd = split ? turnStart : cut;
		preparation.firstKeptEntryId = entries[cut].sourceEntry.id;
		preparation.isSplitTurn = split;
		preparation.messagesToSummarize = entries.slice(start, historyEnd).flatMap(summarised);
		preparation.turnPrefixMessages = split ? entries.slice(turnStart, cut).flatMap(summarised) : [];
		for (const message of [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]) {
			addFileOps(message, preparation.fileOps);
		}

		const sum = (from: number) => sizes.slice(from).reduce((total, size) => total + size, 0);
		const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
		ctx.ui.notify(
			`Compaction cut: keeps about ${k(sum(cut))} measured tokens; Pi's estimate would have kept about ${k(sum(piCut))}.`,
			"info",
		);
		return undefined;
	});
}
