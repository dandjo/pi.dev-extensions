/**
 * tmux tab activity: while Pi or one of its subagents works, the number of its tmux tab blinks on a block.
 *
 * During a run, a compaction, or while a subagent works (subagents.ts, "subagents:state" on the event bus; not one that
 * waits for an instruction or an answer), this extension sets the pane option @pi-working on Pi's tmux pane. It unsets
 * it when Pi settles and no subagent works, while an AskUserQuestion dialog waits (the tab's bell shows then), and when
 * Pi quits. tmux redraws its tabs when the option changes, and the tab formats below draw the window's number as a
 * block in reverse video with the blink attribute while one of the window's panes has it. The terminal does the
 * blinking: no timer runs, and Pi's title stays as Pi writes it. A terminal that does not blink text (Konsole: the
 * profile's "Allow blinking text") shows the block steady.
 *
 * tmux setup, in ~/.tmux.conf or ~/.config/tmux/tmux.conf (tmux 3.2 or later):
 *
 *   # One of the window's panes works (P loops over them).
 *   %hidden PI_WORKS='#{P:#{?#{@pi-working},1,}}'
 *   # The number: a block in reverse video that blinks; fg=<colour> after reverse gives it a colour.
 *   set -g window-status-format " #{?$PI_WORKS,#[nodim reverse blink],}#I#[default] #W"
 *   # The active tab, a block itself while drawn in reverse video: a gap there.
 *   set -g window-status-current-format " #{?$PI_WORKS,#[noreverse blink],}#I#[default] #W"
 *   # Optional: the window name follows the session name in Pi's title, "π - <name> - <directory>".
 *   set -g automatic-rename on
 *   set -g automatic-rename-format '#{?#{m:π - *,#{pane_title}},#{s/^π - (.*) - .*$/\1/:pane_title},#{pane_current_command}}'
 *
 * Then `tmux source-file` the configuration. The styles in the tab formats are separated by spaces: a comma would end
 * the branch of #{?...}. Outside tmux ($TMUX or $TMUX_PANE unset), in subagents, and in other modes than Pi's terminal
 * UI the extension does nothing. A Pi that ends without shutting down (killed, crashed) leaves the option set until Pi
 * starts in that pane again, which unsets it.
 */

import { execFile, execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The pane option the tab formats test. */
const OPTION = "@pi-working";
const TMUX_TIMEOUT_MS = 3_000;
/** subagents.ts: the subagents of this session, whenever something changes, and the request for that list. */
const SUBAGENTS_STATE = "subagents:state";
const SUBAGENTS_REQUEST = "subagents:request";
/** ask-user-question.ts: a dialog opens and closes (answered, declined, or withdrawn), with its tool call id. */
const QUESTIONS_OPEN = "ask-user-question:open";
const QUESTIONS_CLOSE = "ask-user-question:close";

const optionArgs = (pane: string, on: boolean) =>
	on ? ["set-option", "-p", "-t", pane, OPTION, "1"] : ["set-option", "-p", "-u", "-t", pane, OPTION];

export default function (pi: ExtensionAPI) {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;

	/** Pi's terminal UI runs: only then the extension touches the pane (a subagent shares its parent's $TMUX_PANE). */
	let tui = false;
	let running = false;
	let compacting = false;
	/** The subagents that work now: running, and not waiting for an instruction or an answer. */
	let agents = 0;
	/** The AskUserQuestion dialogs open now, by tool call id. */
	const asking = new Set<string>();
	/** The state last sent to tmux, null before the first; the calls run one after another. */
	let sent: boolean | null = null;
	let writes: Promise<void> = Promise.resolve();

	const working = () => (running || compacting || agents > 0) && asking.size === 0;

	function update(): void {
		if (!tui) return;
		const on = working();
		if (on === sent) return;
		sent = on;
		writes = writes.then(
			() =>
				new Promise((resolve) => {
					execFile("tmux", optionArgs(pane!, on), { timeout: TMUX_TIMEOUT_MS }, () => resolve());
				}),
		);
	}

	const unsubscribe = [
		pi.events.on(QUESTIONS_OPEN, (data) => {
			const id = (data as { toolCallId?: unknown } | undefined)?.toolCallId;
			asking.add(typeof id === "string" ? id : "");
			update();
		}),
		pi.events.on(QUESTIONS_CLOSE, (data) => {
			const id = (data as { toolCallId?: unknown } | undefined)?.toolCallId;
			asking.delete(typeof id === "string" ? id : "");
			update();
		}),
		pi.events.on(SUBAGENTS_STATE, (data) => {
			const list = Array.isArray(data) ? (data as { status?: unknown; waiting?: unknown }[]) : [];
			agents = list.filter((agent) => agent?.status === "running" && !agent.waiting).length;
			update();
		}),
	];

	pi.on("session_start", (_event, context) => {
		tui = context.mode === "tui";
		running = false;
		compacting = false;
		agents = 0;
		asking.clear();
		// The first update sends the state whatever tmux has: an option a killed Pi left in this pane goes.
		sent = null;
		update();
		pi.events.emit(SUBAGENTS_REQUEST, undefined);
	});

	pi.on("agent_start", () => {
		running = true;
		update();
	});

	pi.on("agent_settled", () => {
		running = false;
		update();
	});

	pi.on("session_before_compact", () => {
		compacting = true;
		update();
	});

	const compactionOver = () => {
		compacting = false;
		update();
	};
	pi.on("session_compact", compactionOver);
	pi.on("session_compact_failed", compactionOver);

	pi.on("session_shutdown", (event) => {
		for (const off of unsubscribe) off();
		// A reload leaves the option to the next runtime, which sends its state at session_start; anything else ends
		// the session here, and the process may exit before an asynchronous call would run.
		if (tui && event.reason !== "reload" && sent !== false) {
			try {
				execFileSync("tmux", optionArgs(pane, false), { timeout: TMUX_TIMEOUT_MS, stdio: "ignore" });
			} catch {
				// tmux is gone or does not answer: nothing left to unset.
			}
		}
		tui = false;
	});
}
