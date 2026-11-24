/**
 * Compact: a tool with which the model compacts the session on its own, as /compact does for the user — when a part of
 * the work is done and its details are no longer needed, before the next part fills the context further.
 *
 * - The guidelines make the call binding at two points: the user turns to a new task unrelated to the finished one,
 *   and a finished part of a long task leaves outputs behind that the next part does not need. Worded as an option,
 *   the tool went almost unused (one call against about 180 compactions by the threshold or /compact by hand).
 *
 * - compact (focus: what the summary must keep, optional) ends the run after its tool batch (terminate), as Pi's
 *   compaction would abort a run that goes on. Once Pi has settled, the extension compacts the session with focus as
 *   the custom instructions, and a message then starts a turn in which the model continues the task from the summary.
 * - A compaction that fails (nothing to compact yet, a usage limit, …) lets the model continue all the same, with the
 *   error in the message. A compaction cancelled with Esc, a run aborted with Esc, and a message from the user
 *   meanwhile drop the continuation: the user takes over.
 * - The tool works in the interactive session only: a subagent (RPC mode) settles once its run ends, so it could not
 *   continue, and print mode ends with the run.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MESSAGE_TYPE = "compact";

/** due: asked for, compacts once Pi settles; running: compacting. */
type Stage = "due" | "running";

export default function (pi: ExtensionAPI) {
	let pending: { stage: Stage; focus?: string } | undefined;

	function continueRun(error?: string): void {
		pending = undefined;
		const content = error
			? `The compaction you asked for (compact tool) failed: ${error}. Continue the task you were working on without it.`
			: "The session was compacted at your request (compact tool). Continue the task you were working on from the summary " +
				"above; do not repeat work that is already done.";
		try {
			pi.sendMessage(
				{ customType: MESSAGE_TYPE, content, display: true },
				{ triggerTurn: true },
			);
		} catch {
			// The session was replaced meanwhile.
		}
	}

	function start(ctx: ExtensionContext): void {
		if (!pending) return;
		pending.stage = "running";
		// session_compact and session_compact_failed take the outcome.
		ctx.compact({ customInstructions: pending.focus, onComplete: () => {}, onError: () => {} });
	}

	pi.on("agent_settled", (event, ctx) => {
		if (pending?.stage !== "due") return;
		if (event.aborted) {
			pending = undefined;
			return;
		}
		start(ctx);
	});

	pi.on("session_compact", () => {
		if (!pending) return;
		// A compaction before the run ended (the context threshold) did the work already; the run goes on by itself.
		if (pending.stage === "due") pending = undefined;
		else continueRun();
	});

	pi.on("session_compact_failed", (event) => {
		if (pending?.stage !== "running") return;
		if (event.aborted) pending = undefined;
		else continueRun((event.errorMessage ?? "unknown error").replace(/^Compaction failed: /, ""));
	});

	pi.on("input", (event) => {
		if (event.source !== "extension") pending = undefined;
		return { action: "continue" };
	});

	pi.on("session_start", () => {
		pending = undefined;
	});

	pi.registerTool({
		name: "compact",
		label: "Compact",
		description:
			"Compact this session: replace the conversation so far with a summary, as the user's /compact does, to free the context. " +
			"It ends your turn; once Pi is idle the session is compacted, and a message then lets you continue the task from the summary. " +
			"focus: what the summary must keep (the task, decisions, open steps, file paths), optional.",
		promptSnippet: "Compact the session whenever a finished task or part of the work no longer needs its details",
		promptGuidelines: [
			"compact: you MUST call it, before anything else, when the user turns to a new task unrelated to the one finished before it, and when a finished part of a long task leaves outputs behind (logs, file contents, search results, diffs) that the next part does not need. Do not leave it to Pi's automatic compaction: that comes only at a fixed size and summarises without knowing what matters next.",
			"compact: skip it only while the session is still short (a few exchanges) or in the middle of a step whose details you still need.",
			"compact: say in focus what you need afterwards (task, decisions, open steps, paths; for a new task, the user's request in their words), call it alone, and write nothing after it: it ends your turn.",
		],
		parameters: Type.Object({
			focus: Type.Optional(Type.String({ description: "What the summary must keep, as instructions for it" })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") throw new Error("compact works in the interactive session only, not in a subagent or print mode");
			const focus = params.focus?.trim() || undefined;
			pending = { stage: "due", focus };
			const usage = ctx.getContextUsage();
			const size =
				usage?.tokens != null ? ` The context holds ${Math.round(usage.tokens / 1000)}k tokens (${Math.round(usage.percent ?? 0)}%).` : "";
			return {
				content: [{ type: "text", text: `The session is compacted once this run ends; a message then lets you continue.${size}` }],
				details: { focus },
				terminate: true,
			};
		},

		renderCall(args, theme) {
			const focus = typeof args.focus === "string" && args.focus.trim() ? theme.fg("muted", ` ${args.focus.trim()}`) : "";
			return new Text(theme.fg("toolTitle", theme.bold("compact")) + focus, 0, 0);
		},
	});
}
