/**
 * Compact tools: cuts each collapsed tool row to MAX_LINES lines and leaves everything else as Pi draws it.
 *
 * - A row whose content fits in MAX_LINES lines stays exactly as Pi draws it. A longer one first loses its blank
 *   lines. If it still does not fit, it shows its first lines (the call, then the result) and, as its last line, how
 *   many lines are hidden, in Pi's form "... (N more lines, ctrl+o to expand)". Shell output shows its last lines
 *   instead, as Pi's own preview does, with that line between the command and the output, where the hidden lines
 *   are. The time a shell command took is left out of a cut row.
 * - Expanding (ctrl+o, or a click on the row) shows the row as Pi does, in full.
 * - The tools in UNCUT keep Pi's row as it is: codemode, whose own preview already limits the script, its calls and
 *   its output.
 * - It applies to Pi's tools, those of other extensions, and MCP tools, through pi.registerToolRenderer(). Pi draws
 *   edit in a box of its own; here it sits in Pi's default box, which looks the same.
 * - Nothing changes in what the model sees, and nothing is stored: remove this file and the rows are Pi's again.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";

/** Lines of content a collapsed row shows, the line with the number of hidden lines included. */
const MAX_LINES = 4;
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
	call: string[];
	result: string[];
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
}

/** The part of a row that Pi holds as a component: the call or the result. */
class Part implements Component {
	constructor(
		readonly row: Row,
		readonly part: "call" | "result",
	) {}
	render(width: number): string[] {
		return layout(this.row, Math.max(1, width))[this.part];
	}
	invalidate(): void {
		this.row.layout = undefined;
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
function linesOf(component: Component | undefined, width: number, ownShell: boolean): string[] {
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
	const done = (call: string[], result: string[]): Layout => {
		row.layout = { width, call, result };
		return row.layout;
	};
	const lines = (component: Component | undefined) => linesOf(component, width, row.ownShell);

	if (row.expanded) return done(lines(full(row.call)), lines(full(row.result)));

	// Pi's row as it is when it fits, then without its blank lines.
	const call = lines(row.call.collapsed);
	const result = lines(row.result?.collapsed);
	if (call.length + result.length <= MAX_LINES) return done(call, result);
	const compactCall = call.filter((line) => !isBlank(line));
	const compactResult = result.filter((line) => !isBlank(line));
	if (compactCall.length + compactResult.length <= MAX_LINES) return done(compactCall, compactResult);

	// Cut: the content without blank lines and the shell timer. Where Pi's collapsed form is too long for its share,
	// the full content is cut instead, so that Pi's own "more lines" notes do not stand in the middle and the count of
	// hidden lines is right.
	const content = (from: string[]) => from.filter((line) => !isBlank(line) && !isTimer(line));
	let callLines = content(compactCall);
	let resultLines = content(compactResult);
	if (callLines.length + resultLines.length <= MAX_LINES) return done(callLines, resultLines);

	const room = MAX_LINES - 1;
	// The call takes at most two lines while there is a result, so that a line of the result shows.
	const callRoom = resultLines.length > 0 ? room - 1 : room;
	if (callLines.length > callRoom) callLines = content(lines(full(row.call)));
	const shownCall = callLines.slice(0, callRoom);
	const resultRoom = room - shownCall.length;
	if (resultLines.length > resultRoom) resultLines = content(lines(full(row.result)));
	const shownResult = row.fromEnd ? resultLines.slice(-resultRoom || resultLines.length) : resultLines.slice(0, resultRoom);
	const hidden = callLines.length - shownCall.length + (resultLines.length - shownResult.length);
	if (hidden === 0) return done(shownCall, shownResult);

	// The note stands where the lines are hidden: before the end of shell output, else at the end.
	const tail = row.fromEnd && shownResult.length > 0;
	const earlier = tail && shownCall.length === callLines.length;
	const hint = truncateToWidth(row.hint(hidden, earlier), width, "");
	if (!row.result) return done([...shownCall, hint], []);
	return done(shownCall, tail ? [hint, ...shownResult] : [...shownResult, hint]);
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

	const rowOf = (theme: Theme, context: RenderContext, expanded: boolean): Row => {
		const row = ((context.state.compactRow as Row | undefined) ??= {
			call: {},
			expanded,
			ownShell,
			fromEnd: FROM_END.has(tool),
			hint: () => "",
		});
		row.expanded = expanded;
		row.layout = undefined;
		row.hint = (hidden, earlier) =>
			`${theme.fg("muted", `... (${hidden} ${earlier ? "earlier" : "more"} lines,`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		return row;
	};

	/** Draws a slot with the tool's own renderer: collapsed at once, expanded when needed (always, when expanded). */
	const draw = (slot: Slot, context: RenderContext, expanded: boolean, render: (context: RenderContext, expanded: boolean) => Component) => {
		// A tool with a box of its own sits in Pi's box here, which brings the padding.
		const inner = { ...context, outputPad: ownShell ? 0 : context.outputPad };
		slot.drawExpanded = () => {
			slot.expanded = render({ ...inner, expanded: true, lastComponent: slot.expanded }, true);
		};
		slot.stale = true;
		if (expanded) full(slot);
		else slot.collapsed = render({ ...inner, expanded: false, lastComponent: slot.collapsed }, false);
	};

	return {
		...base,
		// Pi's box for every tool, edit included, so that a cut row keeps Pi's padding and background.
		renderShell: "default",

		renderCall(args: unknown, theme: Theme, context: RenderContext): Component {
			const row = rowOf(theme, context, context.expanded);
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
	pi.registerToolRenderer((toolName, next) => {
		const base = next() as Renderers | undefined;
		// A tool Pi has no definition for keeps Pi's plain row.
		if (!base || UNCUT.has(toolName)) return base as ReturnType<typeof next>;
		return compact(toolName, base) as ReturnType<typeof next>;
	});
}
