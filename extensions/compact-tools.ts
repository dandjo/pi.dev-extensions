/**
 * Compact tools: cuts each collapsed tool row to one line, or to the lines compact-tools.json sets, and leaves
 * everything else as Pi draws it.
 *
 * One line (the default):
 * - A collapsed row is the call as the tool draws it, its first line cut to fit, and on the right how many lines the
 *   result has and how long the tool ran ("17 lines · 0.4s"; while it runs the time counts up). Pi's padding lines
 *   above and below the row go too, so that a row takes one line of the screen; its background keeps Pi's colours
 *   for running, done, and failed.
 * - A failed tool (an error result) shows its count in the error colour, a shell command's exit code with it
 *   ("exit 2 · …"), and below the row the last line of its output, so that the reason shows without expanding.
 * - Expanded, the row is Pi's, in Pi's padding.
 *
 * {"lines": n} in ~/.pi/agent/compact-tools.json with n of 2 or more keeps up to n lines instead:
 * - A row whose content fits in n lines stays exactly as Pi draws it. A longer one first loses its blank
 *   lines. If it still does not fit, it shows its first lines (the call, then the result) and, as its last line, how
 *   many lines are hidden, in Pi's form "... (N more lines, ctrl+o to expand)". Shell output shows its last lines
 *   instead, as Pi's own preview does, with that line between the command and the output, where the hidden lines
 *   are. The line with the time a shell command took stays below as the last line and does not count.
 *
 * Either way:
 * - Expanding (ctrl+o, or a click on the row) shows the row as Pi does, in full. The file is read at load (/reload).
 * - The tools in UNCUT keep Pi's row as it is: codemode, whose own preview already limits the script, its calls and
 *   its output.
 * - It applies to Pi's tools, those of other extensions, and MCP tools, through pi.registerToolRenderer(). Pi draws
 *   edit in a box of its own; here it sits in Pi's default box, which looks the same.
 * - Nothing changes in what the model sees, and nothing is stored: remove this file and the rows are Pi's again.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { type ExtensionAPI, getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const CONFIG_FILE = path.join(getAgentDir(), "compact-tools.json");
/** Lines of content a collapsed row shows, the line with the number of hidden lines included; 1 is the one-line row. */
let MAX_LINES = 1;
/** A running tool's row is redrawn this often for its time; a row not drawn for STALE_MS stops it. */
const TICK_MS = 1_000;
const STALE_MS = 5_000;
/** The width a one-line row draws the call at before cutting it. */
const WIDE = 1_000;

function loadLines(): number {
	try {
		const lines = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))?.lines;
		return Number.isInteger(lines) && lines >= 1 ? lines : 1;
	} catch {
		return 1;
	}
}
/** Tools whose row is left as Pi draws it. */
const UNCUT = new Set(["codemode"]);
/** Tools whose cut result shows its last lines, as Pi's preview of them does. */
const FROM_END = new Set(["bash", "powershell"]);
/** What Pi shows of a tool without renderers of its own: lines of output collapsed, characters of arguments. */
const FALLBACK_PREVIEW_LINES = 10;
const FALLBACK_ARGS_CHARS = 100;

type RenderOptions = { expanded: boolean; isPartial: boolean };
type Result = { content: Array<{ type: string; text?: string }>; details?: unknown };

/** What Pi passes to a tool's renderers; only the fields used here. */
interface RenderContext {
	state: Record<string, unknown>;
	lastComponent?: Component;
	expanded: boolean;
	outputPad: number;
	executionStarted: boolean;
	isError: boolean;
	durationMs?: number;
	invalidate(): void;
	keyHint(keybinding: string, description: string): string;
}

interface Renderers {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: Theme, context: any) => Component;
	renderResult?: (result: any, options: RenderOptions, theme: Theme, context: any) => Component;
}

/**
 * One slot of a row, the call or the result, as the tool's own renderer draws it. A collapsed row draws the collapsed
 * form at once and the expanded one only when it has to be cut: highlighting a whole file for a row that shows only
 * its path would be wasted.
 */
interface Slot {
	collapsed?: Component;
	expanded?: Component;
	drawExpanded?: () => void;
	/** `expanded` was drawn before the content last changed. */
	stale?: boolean;
}

/** The lines of a row at one width: those the call's component draws and those the result's draws. */
interface Layout {
	width: number;
	call: readonly string[];
	result: readonly string[];
}

/**
 * The state of a row, shared by its call and result components. Pi asks both for their lines in turn; the first one
 * asked lays out the whole row, since how much of the call fits depends on the result.
 */
interface Row {
	call: Slot;
	result?: Slot;
	expanded: boolean;
	/** Pi draws the tool in a box of its own: its lines lose that box's padding and background here. */
	ownShell: boolean;
	fromEnd: boolean;
	hint: (hidden: number, earlier: boolean) => string;
	layout?: Layout;
	/** The one-line form: the row draws its own frame (renderShell "self"), and the call's part draws all of it. */
	oneLine?: OneLine;
}

/** What the one-line form of a row needs besides the drawn parts. */
interface OneLine {
	theme: Theme;
	pad: number;
	partial: boolean;
	error: boolean;
	/** Lines of the result's text, or the total the tool reports for output it cut. */
	count?: number;
	/** Lines an edit added and removed, from its diff. */
	diff?: { added: number; removed: number };
	/** A shell command's exit code, from "Command exited with code N". */
	exitCode?: number;
	/** The last line of a failed tool's output. */
	errorLine?: string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	timer?: ReturnType<typeof setInterval>;
	drawnAt: number;
	invalidate?: () => void;
	frame?: { width: number; lines: readonly string[] };
}

/** The part of a row that Pi holds as a component: the call or the result. */
class Part implements Component {
	constructor(
		readonly row: Row,
		readonly part: "call" | "result",
	) {}
	render(width: number): readonly string[] {
		const one = this.row.oneLine;
		if (!one) return layout(this.row, Math.max(1, width))[this.part];
		if (this.part === "result") return [];
		one.drawnAt = Date.now();
		return frame(this.row, one, Math.max(1, width));
	}
	invalidate(): void {
		this.row.layout = undefined;
		if (this.row.oneLine) this.row.oneLine.frame = undefined;
		const slot = this.part === "call" ? this.row.call : this.row.result;
		slot?.collapsed?.invalidate?.();
		slot?.expanded?.invalidate?.();
	}
}

const BACKGROUND = /\x1b\[(?:48;2;\d+;\d+;\d+|48;5;\d+|4[0-79]|10[0-7])m/g;
const STYLE = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

function plain(line: string): string {
	return line.replace(STYLE, "");
}

function isBlank(line: string): boolean {
	return plain(line).trim() === "";
}

/** The "Took 4.2s" or "Elapsed 1m 3s" line below a shell command's output. */
function isTimer(line: string): boolean {
	return /^(Took|Elapsed) (\d+h )?(\d+m )?\d+(\.\d+)?s$/.test(plain(line).trim());
}

/** The lines a component draws. A tool with a box of its own loses its padding and background, which are the row's. */
function linesOf(component: Component | undefined, width: number, ownShell: boolean): readonly string[] {
	if (!component) return [];
	const lines = component.render(width);
	if (!ownShell) return lines;
	const bare = lines.map((line) => line.replace(BACKGROUND, "").replace(/\s+$/, ""));
	let start = 0;
	let end = bare.length;
	while (start < end && isBlank(bare[start])) start++;
	while (end > start && isBlank(bare[end - 1])) end--;
	return bare.slice(start, end);
}

/** The slot's expanded component, drawn now if it is not there or older than the content. */
function full(slot: Slot | undefined): Component | undefined {
	if (!slot) return undefined;
	if (!slot.expanded || slot.stale) {
		slot.drawExpanded?.();
		slot.stale = false;
	}
	return slot.expanded;
}

function layout(row: Row, width: number): Layout {
	if (row.layout?.width === width) return row.layout;
	const done = (call: readonly string[], result: readonly string[]): Layout => {
		row.layout = { width, call, result };
		return row.layout;
	};
	const lines = (component: Component | undefined) => linesOf(component, width, row.ownShell);

	if (row.expanded) return done(lines(full(row.call)), lines(full(row.result)));

	// Pi's row as it is when it fits, then without its blank lines.
	const call = lines(row.call.collapsed);
	const result = lines(row.result?.collapsed);
	if (call.length + result.length <= MAX_LINES) return done(call, result);
	// The shell timer stays the last line of the row and does not count.
	const compactCall = call.filter((line) => !isBlank(line));
	const compactResult = result.filter((line) => !isBlank(line));
	const timer = compactResult.filter(isTimer);
	const content = (from: readonly string[]) => from.filter((line) => !isBlank(line) && !isTimer(line));
	let callLines = content(compactCall);
	let resultLines = content(compactResult);
	if (callLines.length + resultLines.length <= MAX_LINES) return done(callLines, [...resultLines, ...timer]);

	// Cut. Where Pi's collapsed form is too long for its share, the full content is cut instead, so that Pi's own
	// "more lines" notes do not stand in the middle and the count of hidden lines is right.

	const room = MAX_LINES - 1;
	// The call takes at most two lines while there is a result, so that a line of the result shows.
	const callRoom = resultLines.length > 0 ? room - 1 : room;
	if (callLines.length > callRoom) callLines = content(lines(full(row.call)));
	const shownCall = callLines.slice(0, callRoom);
	const resultRoom = room - shownCall.length;
	if (resultLines.length > resultRoom) resultLines = content(lines(full(row.result)));
	const shownResult = row.fromEnd ? resultLines.slice(-resultRoom || resultLines.length) : resultLines.slice(0, resultRoom);
	const hidden = callLines.length - shownCall.length + (resultLines.length - shownResult.length);
	if (hidden === 0) return done(shownCall, [...shownResult, ...timer]);

	// The note stands where the lines are hidden: before the end of shell output, else at the end.
	const tail = row.fromEnd && shownResult.length > 0;
	const earlier = tail && shownCall.length === callLines.length;
	const hint = truncateToWidth(row.hint(hidden, earlier), width, "");
	if (!row.result) return done([...shownCall, hint], []);
	return done(shownCall, tail ? [hint, ...shownResult, ...timer] : [...shownResult, hint, ...timer]);
}

/** Duration as Pi writes it: `4.2s` below a minute, then `1m 30s` and `2h 3m 4s`. */
function duration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const total = Math.floor(seconds);
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m ${total % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${total % 60}s`;
}

/** The right-hand side of a one-line row: exit code, count, time. */
function summary(one: OneLine): string {
	const { theme } = one;
	const parts: string[] = [];
	if (one.error && one.exitCode !== undefined) parts.push(`exit ${one.exitCode}`);
	if (one.diff) parts.push(`+${one.diff.added} −${one.diff.removed}`);
	else if (one.count !== undefined) parts.push(`${one.count} ${one.count === 1 ? "line" : "lines"}`);
	const ms = !one.partial && one.durationMs !== undefined
		? one.durationMs
		: one.startedAt !== undefined
			? (one.endedAt ?? Date.now()) - one.startedAt
			: undefined;
	if (ms !== undefined) parts.push(duration(ms));
	if (parts.length === 0) return "";
	return theme.fg(one.error ? "error" : "muted", parts.join(" · "));
}

/**
 * The whole row in the one-line form, in the frame Pi would give it: collapsed the call's first line with the summary
 * on the right (and a failed tool's last output line below), without padding lines; expanded Pi's row with them.
 */
function frame(row: Row, one: OneLine, width: number): readonly string[] {
	if (one.frame?.width === width) return one.frame.lines;
	const { theme } = one;
	const pad = Math.min(one.pad, Math.floor((width - 1) / 2));
	const inner = Math.max(1, width - 2 * pad);
	const background = one.partial ? "toolPendingBg" : one.error ? "toolErrorBg" : "toolSuccessBg";
	const paint = (line: string) => {
		const padded = " ".repeat(pad) + line;
		return theme.bg(background as Parameters<Theme["bg"]>[0], padded + " ".repeat(Math.max(0, width - visibleWidth(padded))));
	};

	let lines: string[];
	if (row.expanded) {
		const { call, result } = layout(row, inner);
		lines = [paint(""), ...[...call, ...result].map(paint), paint("")];
	} else {
		// Drawn wide, so that a long command stays on its first line and is cut here instead of wrapped.
		const call = linesOf(row.call.collapsed, Math.max(inner, WIDE), row.ownShell).filter((line) => !isBlank(line));
		// Without the spaces that pad the line to the width, also where styles follow them.
		let left = (call[0] ?? "").replace(/\s+((?:\x1b\[[0-9;]*m)*)$/, "$1");
		// More call lines (a command over several lines) get a mark; an edit's diff is the summary on the right.
		if (call.length > 1 && !one.diff) left += theme.fg("muted", " …");
		let right = summary(one);
		if (visibleWidth(right) > inner - 2) right = truncateToWidth(right, Math.max(0, inner - 2), "");
		const room = Math.max(1, inner - (right ? visibleWidth(right) + 2 : 0));
		left = truncateToWidth(left, room, "…");
		const gap = Math.max(right ? 2 : 0, inner - visibleWidth(left) - visibleWidth(right));
		lines = [paint(left + " ".repeat(gap) + right)];
		if (one.error && one.errorLine) lines.push(paint(truncateToWidth(theme.fg("error", one.errorLine), inner, "…")));
	}
	one.frame = { width, lines };
	return lines;
}

/** What the summary takes from a result: the line count, a shell exit code, and a failed tool's last line. */
function readResult(one: OneLine, result: Result): void {
	const text = (result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => (block.text ?? "").replace(STYLE, "").replace(/\r/g, ""))
		.join("\n")
		.trimEnd();
	const lines = text ? text.split("\n") : [];
	let end = lines.length;
	const exit = end > 0 ? /^Command exited with code (\d+)$/.exec(lines[end - 1].trim()) : null;
	one.exitCode = exit ? Number(exit[1]) : undefined;
	if (exit) end--;
	while (end > 0 && lines[end - 1].trim() === "") end--;
	const details = result.details as { truncation?: { totalLines?: unknown }; diff?: unknown } | undefined;
	const total = details?.truncation?.totalLines;
	one.count = typeof total === "number" ? total : end;
	// Pi's edit diff: "+12 text" for an added line, "-12 text" for a removed one.
	if (typeof details?.diff === "string") {
		const diff = details.diff.split("\n");
		one.diff = {
			added: diff.filter((line) => /^\+\s*\d/.test(line)).length,
			removed: diff.filter((line) => /^-\s*\d/.test(line)).length,
		};
	} else one.diff = undefined;
	one.errorLine = end > 0 ? lines[end - 1].trim() : undefined;
}

/** Redraws a running tool's row every TICK_MS for its time, until it ends or its row is no longer drawn. */
function tick(one: OneLine): void {
	if (one.timer || !one.partial || one.startedAt === undefined) return;
	one.drawnAt = Date.now();
	one.timer = setInterval(() => {
		if (!one.partial || Date.now() - one.drawnAt > STALE_MS) {
			clearInterval(one.timer);
			one.timer = undefined;
			return;
		}
		one.frame = undefined;
		one.invalidate?.();
	}, TICK_MS);
	one.timer.unref?.();
}

/** The call as Pi draws it for a tool without a call renderer: the name and the arguments. */
function fallbackCall(tool: string, args: unknown, theme: Theme, expanded: boolean): Component {
	const header = theme.fg("toolTitle", theme.bold(tool));
	const entries: Array<[string, unknown]> =
		args == null ? [] : typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [["args", args]];
	if (entries.length === 0) return new Text(header, 0, 0);
	if (expanded) {
		const lines = entries.map(([key, value]) => {
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			return `  ${key}: ${text.replace(/\t/g, "   ").replace(/\r/g, "").split("\n").join("\n    ")}`;
		});
		return new Text(`${header}\n${theme.fg("muted", lines.join("\n"))}`, 0, 0);
	}
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	const preview = pairs.length > FALLBACK_ARGS_CHARS ? `${pairs.slice(0, FALLBACK_ARGS_CHARS - 3)}...` : pairs;
	return new Text(`${header} ${theme.fg("muted", preview)}`, 0, 0);
}

/** The result as Pi draws it for a tool without a result renderer: its text, collapsed the first lines of it. */
function fallbackResult(result: Result, theme: Theme, expanded: boolean, context: RenderContext): Component {
	const output = (result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => (block.text ?? "").replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\r/g, ""))
		.join("\n");
	if (!output) return new Container();
	const lines = output.split("\n");
	const shown = expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
	let text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
	const remaining = lines.length - shown.length;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return new Text(text, 0, 0);
}

/** Pi's renderers for one tool, cut to MAX_LINES lines when collapsed. `base` are the renderers Pi would use. */
function compact(tool: string, base: Renderers): Renderers {
	const ownShell = base.renderShell === "self";
	const oneLine = MAX_LINES === 1;

	const rowOf = (theme: Theme, context: RenderContext, expanded: boolean): Row => {
		const row = ((context.state.compactRow as Row | undefined) ??= {
			call: {},
			expanded,
			ownShell,
			fromEnd: FROM_END.has(tool),
			hint: () => "",
			oneLine: oneLine ? { theme, pad: context.outputPad, partial: true, error: false, drawnAt: Date.now() } : undefined,
		});
		row.expanded = expanded;
		row.layout = undefined;
		if (row.oneLine) {
			row.oneLine.theme = theme;
			row.oneLine.pad = context.outputPad;
			row.oneLine.frame = undefined;
		}
		row.hint = (hidden, earlier) =>
			`${theme.fg("muted", `... (${hidden} ${earlier ? "earlier" : "more"} lines,`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		return row;
	};

	/** Draws a slot with the tool's own renderer: collapsed at once, expanded when needed (always, when expanded). */
	const draw = (slot: Slot, context: RenderContext, expanded: boolean, render: (context: RenderContext, expanded: boolean) => Component) => {
		// A tool with a box of its own sits in Pi's box here, or in the one-line frame, which brings the padding.
		const inner = { ...context, outputPad: ownShell || oneLine ? 0 : context.outputPad };
		slot.drawExpanded = () => {
			slot.expanded = render({ ...inner, expanded: true, lastComponent: slot.expanded }, true);
		};
		slot.stale = true;
		if (expanded) full(slot);
		else slot.collapsed = render({ ...inner, expanded: false, lastComponent: slot.collapsed }, false);
	};

	return {
		...base,
		// Pi's box for every tool, edit included, so that a cut row keeps Pi's padding and background; the one-line form
		// draws that frame itself, without the padding lines.
		renderShell: oneLine ? "self" : "default",

		renderCall(args: unknown, theme: Theme, context: RenderContext): Component {
			const row = rowOf(theme, context, context.expanded);
			const one = row.oneLine;
			if (one) {
				one.invalidate = context.invalidate;
				if (context.executionStarted && one.startedAt === undefined) one.startedAt = Date.now();
				tick(one);
			}
			draw(row.call, context, context.expanded, (inner, expanded) => {
				try {
					if (base.renderCall) return base.renderCall(args, theme, inner);
				} catch {
					// Pi shows the arguments then, too.
				}
				return fallbackCall(tool, args, theme, expanded);
			});
			return context.lastComponent instanceof Part ? context.lastComponent : new Part(row, "call");
		},

		renderResult(result: Result, options: RenderOptions, theme: Theme, context: RenderContext): Component {
			const row = rowOf(theme, context, options.expanded);
			const one = row.oneLine;
			if (one) {
				one.invalidate = context.invalidate;
				one.partial = options.isPartial && !context.isError;
				one.error = context.isError;
				readResult(one, result);
				if (one.partial) tick(one);
				else {
					one.endedAt ??= Date.now();
					one.durationMs = context.durationMs;
				}
			}
			const slot = (row.result ??= {});
			draw(slot, context, options.expanded, (inner, expanded) => {
				try {
					if (base.renderResult) return base.renderResult(result, { ...options, expanded }, theme, inner);
				} catch {
					// Pi shows the text then, too.
				}
				return fallbackResult(result, theme, expanded, context);
			});
			return context.lastComponent instanceof Part ? context.lastComponent : new Part(row, "result");
		},
	};
}

export default function (pi: ExtensionAPI) {
	MAX_LINES = loadLines();
	pi.registerToolRenderer((toolName, next) => {
		const base = next() as Renderers | undefined;
		// A tool Pi has no definition for keeps Pi's plain row.
		if (!base || UNCUT.has(toolName)) return base as ReturnType<typeof next>;
		return compact(toolName, base) as ReturnType<typeof next>;
	});
}
