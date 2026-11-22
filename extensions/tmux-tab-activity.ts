/**
 * tmux tab activity: while Pi or one of its subagents works, or a background wait runs, Pi's spinner turns in its tmux
 * tab in place of the π between the window number and the session name, in step with the spinners of the other tabs.
 *
 * Pi shows the session in the terminal title, "π - <name> - <directory>", or "π - <directory>" while the session has
 * no name. During a run, a compaction, while a subagent works (subagents.ts, "subagents:state" on the event bus; not
 * one that waits for an instruction, an answer, or a usage limit), or while a background wait runs (wait.ts and
 * gitlab.ts, "background-waits:state"; not a repeating one, such as a keepalive), this extension writes it as
 * "π - ␟⠹ <name> - <directory>" (an unnamed session's directory as its name): ␟ marks the title of a working session,
 * and the spinner's frame follows it, which the tab formats below put in place of the π. The frames are those of Pi's
 * own spinner (pi-tui's Loader), ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏, one every 80 ms, each taken from the clock, so all tabs show the same frame. It stops when Pi settles,
 * no subagent works, and no background wait runs, pauses while an ask_user_question dialog waits (its mark, the pane
 * option @pi_ask, shows then), and puts Pi's own title back. A run that waits for a usage limit to reset (auto-continue.ts,
 * "auto-continue:state") does not count as work meanwhile, nor does a run that only waits in agent calls of its own
 * whose subagents all wait (for an instruction, an answer, or a usage limit).
 *
 * A window with several panes shows the pane whose Pi works: the active pane's while it works, else the first other
 * pane's that works, else the active pane's. While another pane works, the tab shows that pane's name, so its width
 * changes when that run starts and ends. A window renamed by hand keeps its name, with π or the spinner before it; a
 * window without Pi shows its number and command.
 *
 * tmux setup. tmux takes a title as the pane title at once, but names the window (#W) after it at most every 500 ms,
 * so the tab has to show the pane title itself. In ~/.tmux.conf or ~/.config/tmux/tmux.conf (tmux 3.2 or later):
 *
 *   # The window name: the session name from Pi's title without the spinner, else the command.
 *   set -g automatic-rename on
 *   set -g automatic-rename-format '#{?#{m:π - *,#{pane_title}},#{s/^␟. //:#{s/^π - (.*) - .*$/\1/:pane_title}},#{pane_current_command}}'
 *   # The tab: its number, then π for a window with Pi, which the spinner takes the place of while a pane's Pi works,
 *   # then the session name from a pane's title; the active pane's while it works, else the first other pane's that
 *   # works (␞ separates their names, the first stays), else the active pane's. A window renamed by hand keeps its
 *   # name (#W).
 *   %hidden PI_NAME='#{s/^π - (.*) - .*$/\1/:pane_title}'
 *   %hidden PI_BUSY='#{m:π - ␟*,#{pane_title}}'
 *   %hidden PI_OTHERS='#{s/␞.*$//:#{P:#{?#{m:π - ␟*,#{pane_title}},#{s/^π - (.*) - .*$/\1/:pane_title}␞,}}}'
 *   %hidden PI_LIVE="#{?$PI_BUSY,$PI_NAME,$PI_OTHERS}"
 *   # The spinner, undimmed (#[nodim fg=blue] gives it a colour); π and the frames are one column each, so the tab
 *   # keeps its width.
 *   %hidden PI_SPIN="#{s/^␟(.).*$/#[nodim]\\1#[default]/:$PI_LIVE}"
 *   %hidden PI_MARK="#{?$PI_LIVE,$PI_SPIN ,#{?#{m:π - *,#{pane_title}},π ,}}"
 *   %hidden PI_TAB="#I $PI_MARK#{?$PI_LIVE,#{?#{automatic-rename},#{s/^␟. //:$PI_LIVE},#W},#{?#{&&:#{automatic-rename},#{m:π - *,#{pane_title}}},$PI_NAME,#W}}"
 *   set -g window-status-format " $PI_TAB"
 *   set -g window-status-current-format " $PI_TAB"
 *
 * Then `tmux source-file` the configuration, and /reload in running Pi sessions. The extension checks the setup when
 * a run starts: it turns the spinner only while window-status-format or window-status-current-format shows the pane
 * title (pane_title or #T) and takes the spinner from behind ␟, and not while set-titles hands the pane title on to
 * the outer terminal, whose title would change with every frame. Elsewhere it does nothing: outside tmux ($TMUX
 * unset), in subagents, and in other modes than Pi's terminal UI.
 *
 * Side effects of the frames in the pane title: tmux's tree view (prefix s or w) shows ␟ and a frame before the name
 * while a run goes on, and tmux-resurrect saves the title as it is; a tab restored from such a save shows a still
 * spinner until Pi starts there again.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Pi's spinner (pi-tui's Loader): its frames, and how long each shows. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
/** Pi's title starts with this; a Pi build with a name of its own (piConfig.name) is not covered. */
const APP_TITLE = "π";
/** Marks a working session's title; the spinner's frame follows, which the tab formats put in place of the π. */
const MARK = "␟";
/** subagents.ts: the subagents of this session, whenever something changes, and the request for that list. */
const SUBAGENTS_STATE = "subagents:state";
const SUBAGENTS_REQUEST = "subagents:request";
/** wait.ts, gitlab.ts: the background waits of a tool ({ tool, waits }), whenever they change, and the request for them. */
const WAITS_STATE = "background-waits:state";
const WAITS_REQUEST = "background-waits:request";
/** ask-user-question.ts: a dialog opens and closes (answered, declined, or withdrawn), with its tool call id. */
const QUESTIONS_OPEN = "ask-user-question:open";
const QUESTIONS_CLOSE = "ask-user-question:close";
/** auto-continue.ts: whether the run waits for a usage limit to reset ({ waiting }), and the request for it. */
const LIMIT_STATE = "auto-continue:state";
const LIMIT_REQUEST = "auto-continue:state-request";
/** The tool of subagents.ts: a call of it in the foreground waits for its subagent. */
const AGENT_TOOL = "agent";

function tmuxOption(name: string): Promise<string> {
	return new Promise((resolve) => {
		execFile("tmux", ["show-options", "-gv", name], { timeout: 3_000 }, (error, stdout) => resolve(error ? "" : stdout.trim()));
	});
}

const showsPaneTitle = (format: string) => /pane_title|#T/.test(format);
const takesSpinner = (format: string) => showsPaneTitle(format) && format.includes(MARK);

/** Whether tmux takes the spinner from the pane title for its tabs and keeps that title out of the outer terminal's. */
async function tmuxReady(): Promise<boolean> {
	const options = ["window-status-format", "window-status-current-format", "set-titles", "set-titles-string"];
	const [inactive, current, setTitles, titlesString] = await Promise.all(options.map(tmuxOption));
	if (!takesSpinner(inactive) && !takesSpinner(current)) return false;
	return !(setTitles === "on" && showsPaneTitle(titlesString));
}

/** Pi's own title, as Pi builds it. */
function plainTitle(name: string | undefined, dir: string): string {
	return name ? `${APP_TITLE} - ${name} - ${dir}` : `${APP_TITLE} - ${dir}`;
}

/** The title with the spinner's frame at `now`, the same in every Pi; an unnamed session shows its directory. */
function spinnerTitle(name: string | undefined, dir: string, now: number): string {
	const frame = FRAMES[Math.floor(now / FRAME_MS) % FRAMES.length];
	return `${APP_TITLE} - ${MARK}${frame} ${name ?? dir} - ${dir}`;
}

export default function (pi: ExtensionAPI) {
	if (!process.env.TMUX) return;

	let ctx: ExtensionContext | null = null;
	let running = false;
	/** The run waits for a usage limit to reset. */
	let limitWait = false;
	let compacting = false;
	/** The subagents that work now: running, and not waiting for an instruction, an answer, or a usage limit. */
	let agents = 0;
	/** The foreground subagents running now, and how many of them wait. */
	let foreground = 0;
	let foregroundWaiting = 0;
	/** The tool calls of the run that execute now: tool call id -> tool name. */
	const tools = new Map<string, string>();
	/** The background waits running now, by the tool that waits. */
	const waits = new Map<string, number>();
	/** The ask_user_question dialogs open now, by tool call id. */
	const asking = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** The setup check of the current run, made once per run: whether tmux shows the spinner. */
	let setup: Promise<boolean> | null = null;
	/** Counts the calls of update(), so one that waited for the setup check does nothing once a later one came. */
	let generation = 0;

	const waiting = () => [...waits.values()].some((count) => count > 0);
	// The run only waits in its agent calls, and each of their subagents waits.
	const held = () =>
		tools.size > 0 &&
		[...tools.values()].every((name) => name === AGENT_TOOL) &&
		foreground > 0 &&
		foregroundWaiting === foreground;
	const working = () =>
		((running && !limitWait && !held()) || compacting || agents > 0 || waiting()) && asking.size === 0;
	const dir = (context: ExtensionContext) => path.basename(context.cwd);

	function frame(): void {
		if (!ctx) return;
		const now = Date.now();
		ctx.ui.setTitle(spinnerTitle(pi.getSessionName()?.trim() || undefined, dir(ctx), now));
		// The next frame starts on the clock's next multiple of FRAME_MS, as in every other Pi.
		timer = setTimeout(frame, FRAME_MS - (now % FRAME_MS) + 1);
		timer.unref?.();
	}

	function stop(): void {
		if (!timer) return;
		clearTimeout(timer);
		timer = null;
		if (ctx) ctx.ui.setTitle(plainTitle(pi.getSessionName()?.trim() || undefined, dir(ctx)));
	}

	async function update(): Promise<void> {
		const call = ++generation;
		if (!ctx || ctx.mode !== "tui" || !working()) {
			stop();
			return;
		}
		if (timer) return;
		setup ??= tmuxReady();
		const ready = await setup;
		if (call !== generation || !ready || !ctx || !working() || timer) return;
		frame();
	}

	const unsubscribe = [
		pi.events.on(QUESTIONS_OPEN, (data) => {
			const id = (data as { toolCallId?: unknown } | undefined)?.toolCallId;
			asking.add(typeof id === "string" ? id : "");
			void update();
		}),
		pi.events.on(QUESTIONS_CLOSE, (data) => {
			const id = (data as { toolCallId?: unknown } | undefined)?.toolCallId;
			asking.delete(typeof id === "string" ? id : "");
			void update();
		}),
		pi.events.on(SUBAGENTS_STATE, (data) => {
			const list = Array.isArray(data) ? (data as { status?: unknown; waiting?: unknown; background?: unknown }[]) : [];
			const now = list.filter((agent) => agent?.status === "running" && !agent.waiting).length;
			const held = list.filter((agent) => agent?.status === "running" && agent.background !== true);
			foreground = held.length;
			foregroundWaiting = held.filter((agent) => agent.waiting).length;
			// Work that starts while nothing moves checks the setup again, as a run of Pi's does.
			if (agents === 0 && now > 0 && !timer) setup = null;
			agents = now;
			void update();
		}),
		pi.events.on(LIMIT_STATE, (data) => {
			const now = (data as { waiting?: unknown } | undefined)?.waiting === true;
			if (now === limitWait) return;
			if (!now && !timer) setup = null;
			limitWait = now;
			void update();
		}),
		pi.events.on(WAITS_STATE, (data) => {
			const { tool, waits: list } = (data ?? {}) as { tool?: unknown; waits?: unknown };
			if (typeof tool !== "string") return;
			// A repeating wait (a keepalive, say) runs for hours without anyone waiting for it: it does not count as work.
			const now = Array.isArray(list) ? list.filter((wait) => (wait as { repeat?: unknown } | null)?.repeat !== true).length : 0;
			if (!waiting() && now > 0 && !timer) setup = null;
			waits.set(tool, now);
			void update();
		}),
	];

	pi.on("session_start", (_event, context) => {
		ctx = context;
		running = false;
		compacting = false;
		agents = 0;
		foreground = 0;
		foregroundWaiting = 0;
		tools.clear();
		waits.clear();
		asking.clear();
		setup = null;
		limitWait = false;
		pi.events.emit(SUBAGENTS_REQUEST, undefined);
		pi.events.emit(WAITS_REQUEST, undefined);
		pi.events.emit(LIMIT_REQUEST, undefined);
	});

	pi.on("agent_start", () => {
		running = true;
		// The setup is checked once per run, so a changed tmux configuration counts from the next run on.
		if (!timer) setup = null;
		void update();
	});

	pi.on("agent_settled", () => {
		running = false;
		tools.clear();
		void update();
	});

	pi.on("tool_execution_start", (event) => {
		tools.set(event.toolCallId, event.toolName);
		void update();
	});

	pi.on("tool_execution_end", (event) => {
		tools.delete(event.toolCallId);
		void update();
	});

	pi.on("session_before_compact", () => {
		compacting = true;
		void update();
	});

	const compactionOver = () => {
		compacting = false;
		void update();
	};
	pi.on("session_compact", compactionOver);
	pi.on("session_compact_failed", compactionOver);

	pi.on("session_shutdown", () => {
		generation++;
		stop();
		ctx = null;
		for (const off of unsubscribe) off();
	});
}
