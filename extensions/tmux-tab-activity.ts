/**
 * tmux tab activity: while Pi or one of its subagents works, or a background wait runs, a block swings back and forth
 * over the number and name of its tmux tab, one character at a time, 20 frames a second, whatever the name's length.
 *
 * Pi shows the session in the terminal title, "π - <name> - <directory>", or "π - <directory>" while the session has
 * no name. During a run, a compaction, while a subagent works (subagents.ts, "subagents:state" on the event bus; not
 * one that waits for an instruction or an answer), or while a background wait runs (wait.ts and gitlab.ts,
 * "background-waits:state"), this extension writes it as "π - ␟ <name> - <directory>" (an unnamed session's
 * directory as its name), where ␟ stands for the window number and the tab formats below put the number in its place.
 * The title carries tmux style tokens that draw one character like the active tab, in window-status-current-style,
 * undimmed (in reverse video while that style is tmux's default, which sets nothing), and the block moves on by one
 * character per frame over the number, the space, and the name; at either end it turns without a pause. It stops when
 * Pi settles, no subagent works, and no background wait runs, pauses while an ask_user_question dialog waits (the tab's
 * bell shows then), and puts Pi's own title back. A run that waits for a usage limit to reset (auto-continue.ts,
 * "auto-continue:state") does not count as work meanwhile. The tokens take no room, so the tab keeps its width.
 *
 * The block shows on the inactive tabs. The active tab, drawn in the same style, shows it only through its format:
 * the setup below turns it into a gap there (#[noreverse]), a letter in the tab colour that runs through the tab's
 * block, as long as the active tab is drawn in reverse video.
 *
 * A window with several panes shows the pane whose Pi works: the active pane's while it works, else the first other
 * pane's that works, else the active pane's. While another pane works, the tab shows that pane's name, so its width
 * changes when that run starts and ends. A window renamed by hand keeps its name, and the block runs over its number
 * and that name: tmux puts it on the character at the same share of their length as in the title, so it swings in the
 * same time, skips characters of a longer name and lingers on those of a shorter one, and the tab keeps its width.
 *
 * tmux setup. tmux takes a title as the pane title at once, but names the window (#W) after it at most every 500 ms,
 * so the tab has to show the pane title itself. In ~/.tmux.conf or ~/.config/tmux/tmux.conf (tmux 3.2 or later):
 *
 *   # The window name: the session name from Pi's title without the block's tokens and the ␟ for the number, else
 *   # the command.
 *   set -g automatic-rename on
 *   set -g automatic-rename-format '#{?#{m:π - *,#{pane_title}},#{s/^␟ //:#{s/#\[[^]]*\]//:#{s/^π - (.*) - .*$/\1/:pane_title}}},#{pane_current_command}}'
 *   # The tab: the number and session name from a pane's title, block included, the number in place of ␟; the
 *   # active pane's while it works, else the first other pane's that works (␞ separates their names, the first
 *   # stays), else the active pane's.
 *   %hidden PI_NAME='#{s/^π - (.*) - .*$/\1/:pane_title}'
 *   %hidden PI_BUSY='#{m:*[[]nodim*,#{pane_title}}'
 *   %hidden PI_OTHERS='#{s/␞.*$//:#{P:#{?#{m:*[[]nodim*,#{pane_title}},#{s/^π - (.*) - .*$/\1/:pane_title}␞,}}}'
 *   %hidden PI_LIVE="#{?$PI_BUSY,$PI_NAME,$PI_OTHERS}"
 *   # A window renamed by hand keeps its name (#W); while a pane works, the block runs over its number and name, on
 *   # the character at the same share of their length (PI_AT). The ␞ marks keep regsub's groups from being empty:
 *   # tmux writes the digit of an empty \1 or \3 as text.
 *   %hidden PI_AT="#{e|/:#{e|*:#{w:#{s/[#][[]nodim,.*$//:$PI_LIVE}},#{e|-:#{w:#I #{window_name}},1}},#{?#{e|>:#{w:$PI_LIVE},1},#{e|-:#{w:$PI_LIVE},1},1}}"
 *   %hidden PI_HAND="#{s/␞//:#{s/^(␞#{R:.,$PI_AT})(.)(.*␞)$/\\1#{s/^.*([#][[]nodim,[^]]*[]]).*$/\\1/:$PI_LIVE}\\2#[default]\\3/:#{l:␞}#I #{window_name}#{l:␞}}}"
 *   %hidden PI_TAB="#{?$PI_LIVE,#{?#{automatic-rename},#{s/␟/#I/:$PI_LIVE},$PI_HAND},#I #{?#{&&:#{automatic-rename},#{m:π - *,#{pane_title}}},$PI_NAME,#W}}"
 *   set -g window-status-format " $PI_TAB"
 *   # The active tab: the same, with the block turned into a gap (its token starts with nodim,).
 *   set -g window-status-current-format " #{s/[#][[]nodim,[^]]*[]]/#[noreverse]/:$PI_TAB}"
 *
 * Then `tmux source-file` the configuration, and /reload in running Pi sessions. The extension checks the setup, and
 * reads the active tab's style, when a run starts: it animates only while window-status-format or
 * window-status-current-format shows the pane title (pane_title or #T) and puts the number in place of ␟, and not
 * while set-titles hands the pane title
 * on to the outer terminal, whose title would show the tokens as text. Elsewhere it does nothing: outside tmux ($TMUX
 * unset), in subagents and other modes than Pi's terminal UI, and for a name with a #, which tmux would read as the
 * start of a token.
 *
 * Side effects of the tokens in the pane title: tmux's tree view (prefix s or w) shows them as text while a run goes on,
 * and tmux-resurrect saves the title as it is; a restored tab shows the frame it saved until Pi starts there again.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The block moves on by one letter per frame, at the same pace for every name. */
const FRAME_MS = 1000 / 20;
/** Pi's title starts with this; a Pi build with a name of its own (piConfig.name) is not covered. */
const APP_TITLE = "π";
const DARK = "#[default]";
/** Stands for the window number in the title; the tab formats of the setup put #I in its place. */
const NUMBER = "␟";
/** The block's style while the active tab has none of its own. */
const PLAIN_BLOCK = "nodim,reverse";
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

function tmuxOption(name: string): Promise<string> {
	return new Promise((resolve) => {
		execFile("tmux", ["show-options", "-gv", name], { timeout: 3_000 }, (error, stdout) => resolve(error ? "" : stdout.trim()));
	});
}

const showsPaneTitle = (format: string) => /pane_title|#T/.test(format);
const takesNumber = (format: string) => showsPaneTitle(format) && format.includes(NUMBER);

/**
 * The block's style: the active tab's, undimmed. A style that is empty, tmux's default, or more than plain attributes
 * and colours (a format, say) gives the plain block. Either starts with "nodim,", which the active tab's format of the
 * setup matches to turn the block into a gap.
 */
function blockStyle(currentStyle: string): string {
	const style = currentStyle.trim();
	if (!style || style === "default" || !/^[A-Za-z0-9_,=#-]+$/.test(style)) return PLAIN_BLOCK;
	return `nodim,${style}`;
}

/**
 * The block's token while tmux shows the pane title in its tabs and keeps it out of the outer terminal's title, else
 * null.
 */
async function tmuxBlock(): Promise<string | null> {
	const options = [
		"window-status-format",
		"window-status-current-format",
		"set-titles",
		"set-titles-string",
		"window-status-current-style",
	];
	const [inactive, current, setTitles, titlesString, currentStyle] = await Promise.all(options.map(tmuxOption));
	if (!takesNumber(inactive) && !takesNumber(current)) return null;
	if (setTitles === "on" && showsPaneTitle(titlesString)) return null;
	return `#[default]#[${blockStyle(currentStyle)}]`;
}

/** Pi's own title, as Pi builds it. */
function plainTitle(name: string | undefined, dir: string): string {
	return name ? `${APP_TITLE} - ${name} - ${dir}` : `${APP_TITLE} - ${dir}`;
}

/**
 * The title with the block on character `at` of the number, the space, and the name, the part tmux shows in the tab;
 * outside them, no block. An unnamed session's directory stands in for the name.
 */
function frameTitle(name: string | undefined, dir: string, at: number, block: string): string {
	const label = [...(name ?? dir)];
	if (label.includes("#")) return plainTitle(name, dir);
	const letters = [NUMBER, " ", ...label];
	const shown =
		at >= 0 && at < letters.length
			? `${DARK}${letters.slice(0, at).join("")}${block}${letters[at]}${DARK}${letters.slice(at + 1).join("")}`
			: `${DARK}${letters.join("")}`;
	return `${APP_TITLE} - ${shown} - ${dir}`;
}

export default function (pi: ExtensionAPI) {
	if (!process.env.TMUX) return;

	let ctx: ExtensionContext | null = null;
	let running = false;
	/** The run waits for a usage limit to reset. */
	let limitWait = false;
	let compacting = false;
	/** The subagents that work now: running, and not waiting for an instruction or an answer. */
	let agents = 0;
	/** The background waits running now, by the tool that waits. */
	const waits = new Map<string, number>();
	/** The ask_user_question dialogs open now, by tool call id. */
	const asking = new Set<string>();
	let timer: ReturnType<typeof setInterval> | null = null;
	/** The letter the block is on, -1 before the first frame of a run, and the way it moves: 1 right, -1 left. */
	let at = -1;
	let step = 1;
	/** The setup check of the current run, made once per run: the block's token, or null where tmux cannot show it. */
	let setup: Promise<string | null> | null = null;
	let block = "";
	/** Counts the calls of update(), so one that waited for the setup check does nothing once a later one came. */
	let generation = 0;

	const waiting = () => [...waits.values()].some((count) => count > 0);
	const working = () => ((running && !limitWait) || compacting || agents > 0 || waiting()) && asking.size === 0;
	const dir = (context: ExtensionContext) => path.basename(context.cwd);

	function frame(): void {
		if (!ctx) return;
		const name = pi.getSessionName()?.trim() || undefined;
		// The number and the space come first.
		const last = [...(name ?? dir(ctx))].length + 1;
		if (at < 0) {
			at = 0;
			step = 1;
		} else {
			// A name that got shorter meanwhile (session-title names the session during its first run): from its end.
			if (at > last) [at, step] = [last, -1];
			if (at + step > last || at + step < 0) step = -step;
			at = Math.max(0, Math.min(last, at + step));
		}
		ctx.ui.setTitle(frameTitle(name, dir(ctx), at, block));
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
		setup ??= tmuxBlock();
		const token = await setup;
		if (call !== generation || !token || !ctx || !working() || timer) return;
		block = token;
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
		pi.events.on(SUBAGENTS_STATE, (data) => {
			const list = Array.isArray(data) ? (data as { status?: unknown; waiting?: unknown }[]) : [];
			const now = list.filter((agent) => agent?.status === "running" && !agent.waiting).length;
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
			const now = Array.isArray(list) ? list.length : 0;
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
