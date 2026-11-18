/**
 * tmux tab activity: while Pi works, a block swings back and forth over the name in its tmux tab, one letter at a
 * time, 16 frames a second.
 *
 * Pi shows the session in the terminal title, "π - <name> - <directory>", or "π - <directory>" while the session has
 * no name. During a run or a compaction this extension writes that title with tmux style tokens that draw one letter
 * in reverse video, undimmed (#[nodim,reverse]), and moves the block on by one letter per frame; at either end it
 * turns without a pause. It stops when Pi settles, pauses while an AskUserQuestion dialog waits (the tab's bell shows
 * then), and puts Pi's own title back. The tokens take no room, so the tab keeps its width.
 *
 * The block shows on every tab that is not drawn in reverse video itself; a tab style with reverse (an active tab drawn
 * as a block, say) hides it.
 *
 * tmux setup. tmux takes a title as the pane title at once, but names the window (#W) after it at most every 500 ms,
 * so the tab has to show the pane title itself. In ~/.tmux.conf or ~/.config/tmux/tmux.conf (tmux 3.2 or later):
 *
 *   # The window name: the session name from Pi's title without the block's tokens, else the command.
 *   set -g automatic-rename on
 *   set -g automatic-rename-format '#{?#{m:π - *,#{pane_title}},#{s/#\[[^]]*\]//:#{s/^π - (.*) - .*$/\1/:pane_title}},#{pane_current_command}}'
 *   # The tab: the session name from the active pane's title, block included, while tmux names the window;
 *   # a window renamed by hand keeps its name (#W).
 *   set -g window-status-format ' #I #{?#{&&:#{automatic-rename},#{m:π - *,#{pane_title}}},#{s/^π - (.*) - .*$/\1/:pane_title},#W}'
 *   set -g window-status-current-format ' #I #{?#{&&:#{automatic-rename},#{m:π - *,#{pane_title}}},#{s/^π - (.*) - .*$/\1/:pane_title},#W}'
 *
 * Then `tmux source-file` the configuration, and /reload in running Pi sessions. The extension checks the setup when a
 * run starts: it animates only while window-status-format or window-status-current-format shows the pane title
 * (pane_title or #T), and not while set-titles hands the pane title on to the outer terminal, whose title would show
 * the tokens as text. Elsewhere it does nothing: outside tmux ($TMUX unset), in subagents and other modes than Pi's
 * terminal UI, and for a name with a #, which tmux would read as the start of a token.
 *
 * Side effects of the tokens in the pane title: tmux's tree view (prefix s or w) shows them as text while a run goes on,
 * and tmux-resurrect saves the title as it is; a restored tab shows the frame it saved until Pi starts there again.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FRAME_MS = 1000 / 16;
/** Pi's title starts with this; a Pi build with a name of its own (piConfig.name) is not covered. */
const APP_TITLE = "π";
const DARK = "#[default]";
const BLOCK = "#[default]#[nodim,reverse]";
/** ask-user-question.ts: a dialog opens and closes (answered, declined, or withdrawn), with its tool call id. */
const QUESTIONS_OPEN = "ask-user-question:open";
const QUESTIONS_CLOSE = "ask-user-question:close";

function tmuxOption(name: string): Promise<string> {
	return new Promise((resolve) => {
		execFile("tmux", ["show-options", "-gv", name], { timeout: 3_000 }, (error, stdout) => resolve(error ? "" : stdout.trim()));
	});
}

const showsPaneTitle = (format: string) => /pane_title|#T/.test(format);

/** Whether tmux shows the pane title in its tabs and keeps it out of the outer terminal's title. */
async function tmuxShowsFrames(): Promise<boolean> {
	const [inactive, current, setTitles, titlesString] = await Promise.all(
		["window-status-format", "window-status-current-format", "set-titles", "set-titles-string"].map(tmuxOption),
	);
	if (!showsPaneTitle(inactive) && !showsPaneTitle(current)) return false;
	return !(setTitles === "on" && showsPaneTitle(titlesString));
}

/** Pi's own title, as Pi builds it. */
function plainTitle(name: string | undefined, dir: string): string {
	return name ? `${APP_TITLE} - ${name} - ${dir}` : `${APP_TITLE} - ${dir}`;
}

/** The title with the block on letter `at` of the part tmux shows in the tab; outside the letters, no block. */
function frameTitle(name: string | undefined, dir: string, at: number): string {
	const letters = [...(name ?? dir)];
	if (letters.includes("#")) return plainTitle(name, dir);
	const shown =
		at >= 0 && at < letters.length
			? `${DARK}${letters.slice(0, at).join("")}${BLOCK}${letters[at]}${DARK}${letters.slice(at + 1).join("")}`
			: `${DARK}${letters.join("")}`;
	return name ? `${APP_TITLE} - ${shown} - ${dir}` : `${APP_TITLE} - ${shown}`;
}

export default function (pi: ExtensionAPI) {
	if (!process.env.TMUX) return;

	let ctx: ExtensionContext | null = null;
	let running = false;
	let compacting = false;
	/** The AskUserQuestion dialogs open now, by tool call id. */
	const asking = new Set<string>();
	let timer: ReturnType<typeof setInterval> | null = null;
	/** The letter the block is on, -1 before the first frame of a run, and the way it moves: 1 right, -1 left. */
	let at = -1;
	let step = 1;
	/** The setup check of the current run, made once per run. */
	let setup: Promise<boolean> | null = null;
	/** Counts the calls of update(), so one that waited for the setup check does nothing once a later one came. */
	let generation = 0;

	const working = () => (running || compacting) && asking.size === 0;
	const dir = (context: ExtensionContext) => path.basename(context.cwd);

	function frame(): void {
		if (!ctx) return;
		const name = pi.getSessionName()?.trim() || undefined;
		const last = [...(name ?? dir(ctx))].length - 1;
		if (at < 0) {
			at = 0;
			step = 1;
		} else {
			// A name that got shorter meanwhile (session-title names the session during its first run): from its end.
			if (at > last) [at, step] = [last, -1];
			if (at + step > last || at + step < 0) step = -step;
			at = Math.max(0, Math.min(last, at + step));
		}
		ctx.ui.setTitle(frameTitle(name, dir(ctx), at));
	}

	function stop(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = null;
		at = -1;
		if (ctx) ctx.ui.setTitle(plainTitle(pi.getSessionName()?.trim() || undefined, dir(ctx)));
	}

	async function update(): Promise<void> {
		const call = ++generation;
		if (!ctx || ctx.mode !== "tui" || !working()) {
			stop();
			return;
		}
		if (timer) return;
		setup ??= tmuxShowsFrames();
		const shows = await setup;
		if (call !== generation || !shows || !ctx || !working() || timer) return;
		timer = setInterval(frame, FRAME_MS);
		timer.unref?.();
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
	];

	pi.on("session_start", (_event, context) => {
		ctx = context;
		running = false;
		compacting = false;
		asking.clear();
		setup = null;
	});

	pi.on("agent_start", () => {
		running = true;
		// The setup is checked once per run, so a changed tmux configuration counts from the next run on.
		if (!timer) setup = null;
		void update();
	});

	pi.on("agent_settled", () => {
		running = false;
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
