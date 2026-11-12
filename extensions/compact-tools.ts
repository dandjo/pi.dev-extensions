/**
 * Compact tools: draws every tool call as a teaser, the way Claude Code does, instead of Pi's tall boxed rows.
 *
 *   ● Bash(git status --short)
 *     ⎿  M src/index.ts
 *        M README.md
 *        … +4 lines (ctrl+o to expand)
 *
 *   ● Read(src/index.ts)
 *     ⎿  Read 212 lines
 *
 * - One line names the call: a bullet, the tool, and the argument that matters (the command, the path, the URL), cut
 *   after CALL_LINES terminal lines.
 * - The row keeps the background of Pi's rows, which shows the state: pending while the tool runs, then success or
 *   error, in the theme's toolPendingBg, toolSuccessBg and toolErrorBg. The bullet takes the matching colour. The
 *   blank lines of padding above and below are gone.
 * - Below it the result as a teaser: a summary where one says more than the output ("Read 212 lines", "Found 14
 *   matches", "Added 3 lines, removed 1 line"), else the first PREVIEW_LINES lines and how many more there are. A
 *   failed call shows its last lines instead, since that is where the error stands. An edit shows its diff up to
 *   DIFF_PREVIEW_LINES lines.
 * - Expanding (ctrl+o, or a click on the row) shows everything: the full arguments and the tool's own full result,
 *   drawn by its own renderer (highlighted file content, the whole diff, a subagent's report).
 * - It applies to every tool: Pi's own, those of other extensions, and MCP tools, through pi.registerToolRenderer().
 *   Nothing changes in what the model sees, and nothing is stored: remove this file and the rows are Pi's again.
 */

import * as os from "node:os";
import * as path from "node:path";
import {
	type ExtensionAPI,
	formatReadLineRange,
	getLanguageFromPath,
	highlightCode,
	renderDiff,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Lines of output a collapsed row shows before "… +N lines". */
const PREVIEW_LINES = 3;
/** Lines of a diff a collapsed edit shows; 0 leaves the summary line alone. */
const DIFF_PREVIEW_LINES = 10;
/** Terminal lines the call line of a collapsed row may take: a long shell command is cut after that many. */
const CALL_LINES = 2;
/** Tools whose own result renderer is a teaser already: collapsed rows show it as it is. */
const OWN_RESULT = new Set(["AskUserQuestion", "CronCreate"]);

const BULLET = "●";
const ELBOW = "⎿";
/** Columns before the result text: two spaces, the elbow, two spaces. */
const GUTTER = 5;

type Args = Record<string, unknown>;
type Content = { type: string; text?: string };
type Result = { content: Content[]; details?: unknown };
type RenderOptions = { expanded: boolean; isPartial: boolean };

/** What Pi passes to a tool's renderers; only the fields used here. */
interface RenderContext {
	args: unknown;
	state: Record<string, unknown>;
	lastComponent?: Component;
	cwd: string;
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	executionStarted: boolean;
	outputPad: number;
	keyText(keybinding: string): string;
}

interface Renderers {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: Theme, context: any) => Component;
	renderResult?: (result: any, options: RenderOptions, theme: Theme, context: any) => Component;
}

/** A component drawn by a function of the width, so a line can be cut to the terminal instead of wrapped. */
class Lines implements Component {
	build: (width: number) => string[] = () => [];
	bg: Background = (text) => text;
	render(width: number): string[] {
		return shade(fit(this.build(Math.max(1, width)), width), width, this.bg);
	}
	invalidate(): void {}
}

/** Another renderer's component behind the result gutter, without the blank lines it leads and ends with. */
class Gutter implements Component {
	inner: Component | undefined;
	pad = 0;
	style: (text: string) => string = (text) => text;
	bg: Background = (text) => text;
	render(width: number): string[] {
		if (!this.inner) return [];
		const lines = this.inner.render(Math.max(1, width - this.pad - GUTTER));
		let start = 0;
		let end = lines.length;
		while (start < end && isBlank(lines[start])) start++;
		while (end > start && isBlank(lines[end - 1])) end--;
		return shade(fit(gutter(lines.slice(start, end), this.pad, this.style), width), width, this.bg);
	}
	invalidate(): void {
		this.inner?.invalidate?.();
	}
}

/** No line may be wider than the terminal, however narrow it is. */
function fit(lines: string[], width: number): string[] {
	return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, Math.max(1, width), "") : line));
}

type Background = (text: string) => string;

/** The background of a row by its state, as Pi's boxed rows have it. */
function background(theme: Theme, isPartial: boolean, isError: boolean): Background {
	const token = isPartial ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg";
	return (text) => theme.bg(token, text);
}

/** Lines on a background over the full width. A full reset inside a line would end it there, so it starts anew. */
function shade(lines: string[], width: number, bg: Background): string[] {
	const open = bg("").replace(/\x1b\[49m$/, "");
	return lines.map((line) => {
		const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		return bg(open ? padded.replace(/\x1b\[0?m/g, (reset) => reset + open) : padded);
	});
}

function isBlank(line: string): boolean {
	return visibleWidth(line) === 0 || line.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
}

/** Prefix lines with the result gutter: the elbow before the first, spaces before the rest. */
function gutter(lines: string[], pad: number, style: (text: string) => string): string[] {
	const indent = " ".repeat(pad);
	return lines.map((line, i) => (i === 0 ? `${indent}  ${style(ELBOW)}  ${line}` : `${indent}${" ".repeat(GUTTER)}${line}`));
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function clean(text: string): string {
	return text.replace(/\r/g, "").replace(/\t/g, "   ");
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A path as the user would type it: relative to the working directory when it is inside, else with ~. */
function shortPath(raw: unknown, cwd: string): string {
	const file = str(raw);
	if (!file) return "…";
	if (path.isAbsolute(file)) {
		const relative = path.relative(cwd, file);
		if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
		const home = os.homedir();
		if (file === home || file.startsWith(home + path.sep)) return `~${file.slice(home.length)}`;
	}
	return file;
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The text of a result, without the escape sequences a command may have printed. */
function textOf(result: Result): string {
	return clean(
		(result.content ?? [])
			.filter((block) => block.type === "text")
			.map((block) => (block.text ?? "").replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ""))
			.join("\n"),
	);
}

function outputLines(result: Result): string[] {
	const lines = textOf(result).split("\n");
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	while (lines.length > 0 && lines[0].trim() === "") lines.shift();
	return lines;
}

/** A teaser has no room for blank lines: they count as hidden. */
function visible(lines: string[]): string[] {
	return lines.filter((line) => line.trim() !== "");
}

function hasImage(result: Result): boolean {
	return (result.content ?? []).some((block) => block.type === "image");
}

/** The tool's name as the row shows it. */
function displayName(tool: string, args: Args): string {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
	if (mcp) return `${mcp[1]} - ${mcp[2]} (MCP)`;
	switch (tool) {
		case "bash":
			return "Bash";
		case "powershell":
			return "PowerShell";
		case "read":
			return "Read";
		case "edit":
			return "Update";
		case "write":
			return "Write";
		case "grep":
		case "find":
			return "Search";
		case "ls":
			return "List";
		case "web_fetch":
			return "Fetch";
		case "web_search":
			return "Web Search";
		case "codemode":
			return "Script";
		case "Agent": {
			const type = str(args.subagent_type);
			return type && type !== "general-purpose" ? type : "Agent";
		}
		default:
			return tool;
	}
}

/** `key: value` pairs on one line, strings quoted, as Claude Code shows the arguments of a tool it has no form for. */
function pairs(args: Args): string {
	return Object.entries(args)
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => `${key}: ${clean(JSON.stringify(value) ?? String(value))}`)
		.join(", ");
}

/** The argument that says what the call does, and a dim note beside it. `complete` when it leaves nothing out. */
function callSummary(tool: string, args: Args, cwd: string): { text: string; note?: string; complete?: boolean } {
	switch (tool) {
		case "bash":
		case "powershell": {
			const timeout = typeof args.timeout === "number" ? `timeout ${args.timeout}s` : undefined;
			return { text: clean(str(args.command)).trim() || "…", note: timeout, complete: true };
		}
		case "read": {
			const range = formatReadLineRange(args.offset as number | undefined, args.limit as number | undefined) ?? "";
			return { text: shortPath(args.file_path ?? args.path, cwd) + range, complete: true };
		}
		case "edit": {
			const edits = Array.isArray(args.edits) ? args.edits.length : 0;
			return { text: shortPath(args.file_path ?? args.path, cwd), note: edits > 1 ? `${edits} edits` : undefined, complete: true };
		}
		case "write": {
			const content = str(args.content);
			const note = content ? plural(content.replace(/\n$/, "").split("\n").length, "line") : undefined;
			return { text: shortPath(args.file_path ?? args.path, cwd), note, complete: true };
		}
		case "ls":
			return { text: shortPath(args.path || ".", cwd), complete: true };
		case "grep":
		case "find":
			return { text: pairs({ ...args, path: args.path ? shortPath(args.path, cwd) : undefined }), complete: true };
		case "web_fetch":
			return { text: str(args.url) || "…" };
		case "web_search": {
			const queries = Array.isArray(args.queries) ? args.queries.map((query) => `"${String(query)}"`).join(", ") : "";
			return { text: queries || `"${str(args.query)}"` };
		}
		case "gitlab":
		case "openproject":
			return { text: [str(args.host), str(args.method) || "GET", str(args.path)].filter(Boolean).join(" ") };
		case "Agent": {
			const notes = [args.resume ? `resume ${str(args.resume)}` : "", args.run_in_background ? "background" : "", str(args.model)];
			return { text: str(args.description) || "…", note: notes.filter(Boolean).join(", ") || undefined };
		}
		case "SendMessage": {
			const message = str(args.message).split("\n")[0];
			return { text: message ? `${str(args.to)}: ${message}` : str(args.to) };
		}
		case "AskUserQuestion": {
			const questions = Array.isArray(args.questions) ? (args.questions as Args[]) : [];
			return { text: questions.map((question) => str(question.header)).filter(Boolean).join(", ") || plural(questions.length, "question") };
		}
		case "codemode": {
			const code = clean(str(args.code)).trim();
			return { text: code ? plural(code.split("\n").length, "line") : "…" };
		}
		case "clipboard":
			return { text: str(args.action) || "…" };
		case "tool_search":
			return { text: `"${str(args.query)}"` };
		default:
			return { text: pairs(args) };
	}
}

/** The arguments an expanded row lists below its call line, one `key: value` each. */
function argumentLines(tool: string, args: Args, theme: Theme): string[] {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null) continue;
		if (tool === "codemode" && key === "code") continue;
		const text = clean(typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value)));
		const [first, ...rest] = text.split("\n");
		lines.push(theme.fg("muted", `${key}: ${first}`), ...rest.map((line) => theme.fg("muted", `  ${line}`)));
	}
	if (tool === "codemode" && str(args.code)) lines.push(...highlightCode(clean(str(args.code)).trimEnd(), "javascript"));
	return lines;
}

/** What a collapsed row shows of a result: lines as they are (cut to the width later) and how many it leaves out. */
interface Teaser {
	lines: string[];
	hidden?: number;
	/** The lines left out come before those shown (a tail), not after. */
	hiddenBefore?: boolean;
}

function head(lines: string[], limit: number, style: (text: string) => string): Teaser {
	const shown = visible(lines).slice(0, limit);
	return { lines: shown.map(style), hidden: lines.length - shown.length };
}

function tail(lines: string[], limit: number, style: (text: string) => string): Teaser {
	const shown = visible(lines).slice(-limit);
	return { lines: shown.map(style), hidden: lines.length - shown.length, hiddenBefore: true };
}

interface AgentDetails {
	agentId?: string;
	status?: string;
	toolCount?: number;
	tokens?: number;
	durationMs?: number;
	error?: string;
	output?: string;
	toolCalls?: Array<{ summary?: string; error?: unknown }>;
}

function agentTeaser(details: AgentDetails, isPartial: boolean, theme: Theme): Teaser {
	const stats = [
		plural(details.toolCount ?? 0, "tool use"),
		details.tokens ? `${formatTokens(details.tokens)} tokens` : "",
		details.durationMs ? formatDuration(details.durationMs) : "",
	].filter(Boolean);
	const dim = (text: string) => theme.fg("muted", text);
	if (details.status === "background") return { lines: [dim(`Running in the background (${details.agentId})`)] };
	if (details.status === "running" || isPartial) {
		const calls = (details.toolCalls ?? []).slice(-PREVIEW_LINES).map((call) => dim(str(call.summary)));
		return { lines: [...calls, dim(`Running… (${stats.join(" · ")})`)] };
	}
	if (details.status !== "completed") {
		const error = str(details.error) || details.status || "failed";
		return { lines: [theme.fg("error", `${error.split("\n")[0]} (${stats.join(" · ")})`)] };
	}
	return { lines: [dim(`Done (${stats.join(" · ")})`)] };
}

function teaser(tool: string, args: Args, result: Result, options: RenderOptions, theme: Theme, context: RenderContext): Teaser {
	const dim = (text: string) => theme.fg("muted", text);
	const lines = outputLines(result);

	if (tool === "Agent" && (result.details as AgentDetails | undefined)?.agentId) {
		return agentTeaser(result.details as AgentDetails, options.isPartial, theme);
	}
	if (context.isError) {
		return lines.length > 0 ? tail(lines, PREVIEW_LINES, (text) => theme.fg("error", text)) : { lines: [theme.fg("error", "Failed")] };
	}
	// While a tool runs, its latest output is the news.
	if (options.isPartial) return lines.length > 0 ? tail(lines, PREVIEW_LINES, dim) : { lines: [dim("Running…")] };

	switch (tool) {
		case "read": {
			if (hasImage(result)) return { lines: [dim("Read image")] };
			const truncated = (result.details as { truncation?: { truncated?: boolean } } | undefined)?.truncation?.truncated;
			return { lines: [dim(`Read ${plural(lines.length, "line")}${truncated ? " (truncated)" : ""}`)] };
		}
		case "write": {
			const count = clean(str(args.content)).replace(/\n$/, "").split("\n").length;
			return { lines: [dim(`Wrote ${plural(count, "line")}`)] };
		}
		case "edit": {
			const diff = str((result.details as { diff?: unknown } | undefined)?.diff);
			if (!diff) return head(lines, PREVIEW_LINES, dim);
			const diffLines = diff.split("\n");
			const added = diffLines.filter((line) => line.startsWith("+")).length;
			const removed = diffLines.filter((line) => line.startsWith("-")).length;
			const summary = [added ? `Added ${plural(added, "line")}` : "", removed ? `${added ? "removed" : "Removed"} ${plural(removed, "line")}` : ""];
			const shown = renderDiff(diffLines.slice(0, DIFF_PREVIEW_LINES).join("\n")).split("\n");
			return {
				lines: [dim(summary.filter(Boolean).join(", ") || "No changes"), ...(DIFF_PREVIEW_LINES > 0 ? shown : [])],
				hidden: Math.max(0, diffLines.length - DIFF_PREVIEW_LINES),
			};
		}
		case "grep":
			if (lines.length <= 1 && !/^[^:]+:\d+/.test(lines[0] ?? "")) return { lines: [dim(lines[0] || "No matches")] };
			return { lines: [dim(`Found ${plural(lines.length, "line")}`)] };
		case "find":
			if (lines.length <= 1 && /^no /i.test(lines[0] ?? "No files")) return { lines: [dim(lines[0] || "No files")] };
			return { lines: [dim(`Found ${plural(lines.length, "file")}`)] };
		case "ls":
			return { lines: [dim(`Listed ${plural(lines.length, "path")}`)] };
		case "codemode": {
			// "Script completed", "Wall time …", "Output:" head the output; the calls the script made say more.
			const calls = ((result.details as { calls?: unknown[] } | undefined)?.calls ?? []).length;
			const output = /^Script (completed|failed)$/.test(lines[0] ?? "") ? lines.slice(3) : lines;
			const shown = head(output, PREVIEW_LINES, dim);
			return calls > 0 ? { ...shown, lines: [dim(plural(calls, "tool call")), ...shown.lines] } : shown;
		}
		default:
			if (lines.length === 0) {
				return { lines: [dim(hasImage(result) ? "Image" : tool === "bash" || tool === "powershell" ? "(No output)" : "Done")] };
			}
			return head(lines, PREVIEW_LINES, dim);
	}
}

/** Pi's renderers for one tool, replaced by the compact row. `base` are the renderers Pi would have used. */
function compact(tool: string, base: Renderers | undefined): Renderers {
	return {
		renderShell: "self",

		renderCall(rawArgs: unknown, theme: Theme, context: RenderContext): Component {
			const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Args;
			const component = context.lastComponent instanceof Lines ? context.lastComponent : new Lines();
			const pad = " ".repeat(context.outputPad);
			const bullet = theme.fg(context.isPartial ? "muted" : context.isError ? "error" : "success", BULLET);
			const name = theme.fg("toolTitle", theme.bold(displayName(tool, args)));
			const summary = callSummary(tool, args, context.cwd);
			const note = summary.note ? theme.fg("dim", ` ${summary.note}`) : "";
			const expanded = context.expanded;

			component.bg = background(theme, context.isPartial, context.isError);
			component.build = (width) => {
				const room = Math.max(10, width - context.outputPad * 2 - 2);
				if (expanded) {
					const text = summary.text.split("\n").join("\n  ");
					const call = wrapTextWithAnsi(`${name}(${theme.fg("toolTitle", text)})${note}`, room);
					const detail = summary.complete ? [] : argumentLines(tool, args, theme).flatMap((line) => wrapTextWithAnsi(line, room - 2));
					return [...call.map((line, i) => `${pad}${i === 0 ? bullet : " "} ${line}`), ...detail.map((line) => `${pad}    ${line}`)];
				}
				// One logical line: a command over several lines shows its first and says that more follows.
				const [first, ...rest] = summary.text.split("\n");
				const text = rest.length > 0 ? `${first} …` : first;
				let call = wrapTextWithAnsi(`${name}(${theme.fg("toolTitle", text)})${note}`, room);
				if (call.length > CALL_LINES) {
					const end = `${theme.fg("toolTitle", "…")})${note}`;
					call = call.slice(0, CALL_LINES);
					call[CALL_LINES - 1] = truncateToWidth(call[CALL_LINES - 1], Math.max(1, room - visibleWidth(end)), "") + end;
				}
				return call.map((line, i) => `${pad}${i === 0 ? bullet : " "} ${line}`);
			};
			return component;
		},

		renderResult(result: Result, options: RenderOptions, theme: Theme, context: RenderContext): Component {
			const args = (context.args && typeof context.args === "object" ? context.args : {}) as Args;
			const elbow = (text: string) => theme.fg("muted", text);
			const bg = background(theme, options.isPartial, context.isError);

			// Expanded, and for tools that tease already: the tool's own renderer, behind the gutter.
			const own = options.expanded || (OWN_RESULT.has(tool) && !context.isError);
			if (own && tool !== "write" && base?.renderResult) {
				try {
					const inner = base.renderResult(result, options, theme, { ...context, lastComponent: context.state.compactInner });
					context.state.compactInner = inner;
					const wrapper = context.lastComponent instanceof Gutter ? context.lastComponent : new Gutter();
					wrapper.inner = inner;
					wrapper.pad = context.outputPad;
					wrapper.style = elbow;
					wrapper.bg = bg;
					return wrapper;
				} catch {
					// Fall through to the plain text below.
				}
			}

			const component = context.lastComponent instanceof Lines ? context.lastComponent : new Lines();
			component.bg = bg;
			if (options.expanded) {
				// A write's result says only that it happened: the content written is the detail.
				const content = tool === "write" && !context.isError ? clean(str(args.content)).trimEnd() : "";
				const language = content ? getLanguageFromPath(str(args.file_path ?? args.path)) : undefined;
				const lines = content
					? language
						? highlightCode(content, language)
						: content.split("\n").map((line) => theme.fg("toolOutput", line))
					: outputLines(result).map((line) => theme.fg(context.isError ? "error" : "toolOutput", line));
				component.build = (width) => {
					const room = Math.max(10, width - context.outputPad * 2 - GUTTER);
					const empty = theme.fg("muted", options.isPartial ? "Running…" : "Done");
					return gutter(lines.length > 0 ? lines.flatMap((line) => wrapTextWithAnsi(line, room)) : [empty], context.outputPad, elbow);
				};
				return component;
			}

			const shown = teaser(tool, args, result, options, theme, context);
			const key = context.keyText("app.tools.expand") || "ctrl+o";
			const hint =
				shown.hidden && shown.hidden > 0
					? theme.fg("dim", `… +${plural(shown.hidden, shown.hiddenBefore ? "earlier line" : "line")} (${key} to expand)`)
					: undefined;
			const lines = hint ? (shown.hiddenBefore ? [hint, ...shown.lines] : [...shown.lines, hint]) : shown.lines;
			component.build = (width) => {
				const room = Math.max(10, width - context.outputPad * 2 - GUTTER);
				return gutter(lines.map((line) => truncateToWidth(line, room, "…")), context.outputPad, elbow);
			};
			return component;
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => compact(toolName, next() as Renderers | undefined) as ReturnType<typeof next>);
}
