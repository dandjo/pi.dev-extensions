/**
 * File preview: a live view of the file the model edits, or of the command it runs, in a panel beside the conversation.
 *
 * - Shows the whole file with line numbers and syntax highlighting. While the model writes an edit or write call,
 *   before it runs, the place being edited is centred: removed lines red, added lines green, both with an accent bar
 *   in the gutter, and added lines grow as the arguments stream in. A write shows its content as it arrives: for an
 *   existing file the region that differs from the old content, for a new file just the content.
 * - Once the call has run, the removed lines go and the panel shows the file as it now is on disk; the changed lines
 *   keep the gutter bar until the next prompt.
 * - The header holds the path (relative to the working directory), the status of the call — writing…, queued (Claude
 *   Code runs a response's calls once the response is complete), applying…, applied, failed, or not applied — and ✕.
 * - A bash, powershell, or codemode call, or a call of a command tool another extension registers (see RunTool), shows
 *   its command or script instead, with line numbers, syntax highlighting, and the bar in the gutter, as the model
 *   writes it; long lines wrap, each to at most 8 rows (cut with …, or while written showing its end); below a rule
 *   follows the output while it runs, then the final result: for codemode the nested tool calls with their status and
 *   the script's output. Escape sequences are stripped, the last 2000 lines kept. While the command is written the view
 *   keeps its end in sight; once written it stays at the top, the command first and the output below it. An output
 *   longer than the panel shows its start and its end, with a line in between saying how many lines are hidden; the
 *   first wheel turn or key shows all of it to scroll through, until the next call starts. The header names the tool
 *   and the command's first line, and the status: writing…, queued, running…, exit 0 or exit N, timed out, aborted,
 *   failed, or not run (bash); done or failed (codemode). Calls a codemode script makes itself are not followed; the
 *   script's view lists them. Commands the user runs with ! are not shown.
 * - It always shows the call written last: an edit of another file switches the preview to it, a bash call to the
 *   command, an edit after it back to the file.
 * - The mouse wheel scrolls; once the user scrolls, following pauses until the next call starts. alt+g moves the
 *   keyboard into the panel and back; there ↑↓ PgUp/PgDn Home/End scroll, Esc returns, x closes. ✕ closes too.
 * - It opens on its own at the session's first edit, write, bash, or codemode call when the terminal has 144 columns,
 *   or 110 once the user opened it with /preview. Closed by the user, it stays closed, in later sessions too, until
 *   /preview opens it again; that preference is kept in ~/.pi/agent/file-preview.json. /preview opens and closes it.
 * - Only in Pi's fullscreen TUI with at least 110 columns; otherwise there is no preview (/preview says why), and
 *   subagents and print mode do nothing. Files over 2 MB and binary files show a one-line note instead.
 *
 * The live view reads the calls' arguments from the message stream (message_update) and the file as it was before the
 * call; after the call it re-reads the file and marks the lines from the edit tool's patch, or from the lines where old
 * and new content differ. Output comes from tool_execution_update (bash: the tail of the output so far, codemode: its
 * nested calls) and the result; bash's exit code from its structured result or its "Command exited with code N". The
 * panel splits Pi's fullscreen layout through tui.setLayoutRoot(); when that layout is not the one this was built
 * against (a VStack of transcript and dock, Pi 1.6), the preview does not open.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { parseStreamingJson } from "@earendil-works/pi-ai";
import {
	type Component,
	HStack,
	isViewportTUI,
	Key,
	matchesKey,
	ScrollView,
	sliceByColumn,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	VStack,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Larger files are shown without syntax highlighting. */
const MAX_HIGHLIGHT_BYTES = 512 * 1024;
const PANEL_MIN_COLUMNS = 110;
const AUTO_OPEN_COLUMNS = 144;
/** The preview redraws at most this often while a call's arguments arrive. */
const LIVE_FRAME_MS = 80;
const TAB = "    ";
/** Output kept of a bash or codemode call, in lines and characters per line. */
const OUTPUT_MAX_LINES = 2000;
const OUTPUT_MAX_CHARS = 1000;
const PREFS_FILE = path.join(getAgentDir(), "file-preview.json");

interface Prefs {
	panel?: "opened" | "closed";
}

/** A file as read from disk; content null when it is missing, too large, binary, or unreadable. */
interface Snapshot {
	abs: string;
	exists: boolean;
	content: string | null;
	lines: string[];
	note?: string;
	/** The language to highlight in; else taken from the path. */
	lang?: string;
	/** Highlighted lines, computed once per snapshot and theme. */
	hl?: { theme: Theme; lines: string[] };
	/** Highlighted lines cut to the text width, filled as they are drawn. */
	fmt?: { theme: Theme; width: number; lines: string[] };
}

/** A tool's name: edit, write, codemode, a shell, or a tool another extension registered. */
type Tool = string;

/**
 * A tool that runs a command, shown like bash. Other extensions register theirs in the registry below, a Map from the
 * tool's name to this, on globalThis[Symbol.for("pi.file-preview.tools")]; without this extension nothing reads it. A
 * registering extension creates the Map when it is missing and only sets its own entries, e.g.:
 *
 *   const key = Symbol.for("pi.file-preview.tools");
 *   const tools = ((globalThis as Record<symbol, unknown>)[key] ??= new Map()) as Map<string, unknown>;
 *   tools.set("my_run", { code: "command", language: "bash", output: true });
 */
interface RunTool {
	/** The argument that holds the command or script. */
	code: string;
	/** The language to highlight it in, a name highlightCode knows: bash, javascript, python, powershell, … */
	language: string;
	/** Whether the output may be shown: only when the tool's updates and result never carry a secret unmasked. */
	output?: boolean;
	/** From the result's text and error flag: the header's status and the text without the tool's closing note. */
	outcome?: (text: string, isError: boolean) => { status: string; text: string } | undefined;
}

const REGISTRY_KEY = Symbol.for("pi.file-preview.tools");

/** Pi's shells: their results end with "Command exited with code N" and the like, read by shellOutcome. */
const SHELLS: Readonly<Record<string, RunTool>> = {
	bash: { code: "command", language: "bash", output: true },
	powershell: { code: "command", language: "powershell", output: true },
};

/** A tool shown as a command: one of Pi's shells or a registered one; codemode is handled apart. */
function runTool(name: string): RunTool | undefined {
	if (Object.hasOwn(SHELLS, name)) return SHELLS[name];
	const registry = (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
	const entry = registry instanceof Map ? (registry.get(name) as Partial<RunTool> | undefined) : undefined;
	if (!entry || typeof entry.code !== "string" || typeof entry.language !== "string") return undefined;
	return entry as RunTool;
}

function isTool(name: unknown): name is Tool {
	return typeof name === "string" && (name === "edit" || name === "write" || name === "codemode" || runTool(name) !== undefined);
}

/** A call that runs something: a command or a codemode script. */
function isRun(tool: Tool): boolean {
	return tool !== "edit" && tool !== "write";
}

/** A call from the moment the model starts writing it. */
interface LiveEdit {
	id: string;
	tool: Tool;
	/** The arguments as streamed so far, JSON that may stop anywhere; parsed when needed. */
	json: string;
	args: Record<string, unknown>;
	parsed: boolean;
	streaming: boolean;
	running: boolean;
	/** Order of the calls as the model wrote them; the preview follows the highest. */
	seq: number;
	/** The file before the call; for bash and codemode the command or script, as a snapshot to highlight. */
	file?: Snapshot;
	/** bash and codemode: the output so far, cleaned, and how the call ended (exit 0, failed, …). */
	output?: string[];
	outcome?: string;
	/** The file after the call, and the lines (0-based rows) it changed. */
	after?: Snapshot;
	focus?: { from: number; to: number };
	done?: boolean;
	failed?: boolean;
	stopped?: boolean;
}

interface EditArg {
	oldText?: string;
	newText?: string;
}

interface Row {
	/** A line of the file or command, removed, added, a line of output, or the rule above the output. */
	kind: " " | "-" | "+" | "o" | "r";
	num: number;
	text: string;
	/** Index of the line in the snapshot, for its highlighted form. */
	src?: number;
	mark?: boolean;
	cursor?: boolean;
}

interface Layout {
	rows: Row[];
	/** Rows of the change to centre. */
	focus?: { from: number; to: number };
	/** Keep the end of the focus at the bottom, like a terminal. */
	tail?: boolean;
	/** Wrap long lines of a command or script instead of cutting them, each to at most MAX_WRAP_ROWS rows. */
	wrap?: boolean;
	note?: string;
}

/** A hunk of a unified patch, 1-based; lines keep their " ", "-", "+" prefix. */
interface Hunk {
	oldStart: number;
	newStart: number;
	lines: string[];
}

// --- Files and arguments -------------------------------------------------------------------------------------------

function resolvePath(cwd: string, raw: string): string {
	return path.resolve(cwd, raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw);
}

/** The lines of `text`, without the empty one after a final newline; none for "". */
function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function countNewlines(text: string, end: number): number {
	let n = 0;
	for (let i = text.indexOf("\n"); i >= 0 && i < end; i = text.indexOf("\n", i + 1)) n++;
	return n;
}

/** How many first lines `a` and `b` share, counting at most `limit` lines of `b`. */
function sharedHead(a: string[], b: string[], limit: number): number {
	let n = 0;
	while (n < a.length && n < limit && a[n] === b[n]) n++;
	return n;
}

/** How many last lines `a` and `b` share after their first `head` lines. */
function sharedTail(a: string[], b: string[], head: number): number {
	let n = 0;
	while (n < a.length - head && n < b.length - head && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

function readSnapshot(abs: string): Snapshot {
	try {
		const stat = statSync(abs);
		if (!stat.isFile()) return { abs, exists: false, content: null, lines: [], note: "not a regular file" };
		if (stat.size > MAX_FILE_BYTES) {
			return { abs, exists: true, content: null, lines: [], note: `too large to show (${(stat.size / 1048576).toFixed(1)} MB)` };
		}
		const buffer = readFileSync(abs);
		if (buffer.subarray(0, 8000).includes(0)) return { abs, exists: true, content: null, lines: [], note: "binary file, not shown" };
		const content = buffer.toString("utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
		return { abs, exists: true, content, lines: splitLines(content) };
	} catch {
		return { abs, exists: false, content: null, lines: [] };
	}
}

/** The arguments of a live call as far as they have arrived. */
function argsOf(entry: LiveEdit): Record<string, unknown> {
	if (!entry.parsed) {
		entry.parsed = true;
		try {
			const parsed = parseStreamingJson<Record<string, unknown>>(entry.json);
			if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) entry.args = parsed;
		} catch {
			// keep the arguments that parsed last
		}
	}
	return entry.args;
}

/** The arguments of a live call as far as they have arrived, in the form of Pi's edit and write tools. */
function liveArgs(entry: LiveEdit): { path: string; edits: EditArg[]; content?: string } {
	const args = argsOf(entry);
	const text = (value: unknown) => (typeof value === "string" ? value : undefined);
	const one = (e: Record<string, unknown>) => ({ oldText: text(e.oldText ?? e.old_string), newText: text(e.newText ?? e.new_string) });
	const edits = Array.isArray(args.edits)
		? (args.edits as unknown[]).filter((e): e is Record<string, unknown> => !!e && typeof e === "object").map(one)
		: args.oldText !== undefined || args.old_string !== undefined
			? [one(args)]
			: [];
	return { path: text(args.path ?? args.file_path) ?? "", edits, content: text(args.content) };
}

/** The call's path once it is complete: while streaming, only after another argument has started. */
function pathOf(entry: LiveEdit): string {
	const args = liveArgs(entry);
	if (!args.path || (entry.streaming && Object.keys(entry.args).length < 2)) return "";
	return args.path;
}

/** Whether the preview can show the call: a command or script at once, an edit or write once its path is known. */
function ready(entry: LiveEdit): boolean {
	return isRun(entry.tool) || pathOf(entry) !== "";
}

/** The command or the codemode script of a call, as far as it has arrived. */
function runText(entry: LiveEdit): string {
	const value = argsOf(entry)[entry.tool === "codemode" ? "code" : (runTool(entry.tool)?.code ?? "command")];
	return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : "";
}

// --- Command output ------------------------------------------------------------------------------------------------

/** Terminal output as plain lines: escape sequences gone, of a line redrawn with \r its last state, the last lines. */
function outputLines(text: string): string[] {
	// eslint-disable-next-line no-control-regex
	const plain = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]?/g, "");
	return splitLines(plain)
		.slice(-OUTPUT_MAX_LINES)
		.map((line) => {
			const trimmed = line.replace(/\r+$/, "");
			const shown = trimmed.slice(trimmed.lastIndexOf("\r") + 1);
			return clean(shown.length > OUTPUT_MAX_CHARS ? shown.slice(0, OUTPUT_MAX_CHARS) : shown);
		});
}

/** The texts of a tool result's content blocks; an image as [image]. */
function resultTexts(result: unknown): string[] {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content.map((b: { type?: unknown; text?: unknown } | null) =>
		b?.type === "text" && typeof b.text === "string" ? b.text : b?.type === "image" ? "[image]" : "",
	);
}

const CALL_ICON: Record<string, string> = { running: "…", ok: "✓", error: "✗", cancelled: "⊘" };

/** A registered tool's outcome(), or undefined when it has none or it throws. */
function registeredOutcome(tool: Tool, text: string, isError: boolean): { status: string; text: string } | undefined {
	try {
		const outcome = runTool(tool)?.outcome?.(text, isError);
		return outcome && typeof outcome.status === "string" && typeof outcome.text === "string" ? outcome : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The output of a command or codemode call, from an update while it runs or from its result: for a shell the text
 * without the closing "Command exited with code N", which the header shows; for a registered tool the text its
 * outcome() leaves, or a note when it does not declare its output safe to show; for codemode the nested calls from the
 * details, then the script's output without the "Script completed" header.
 */
function runOutput(tool: Tool, result: unknown, isError = false): string[] {
	const texts = resultTexts(result);
	if (Object.hasOwn(SHELLS, tool)) return outputLines(texts.join("\n").replace(/\n*Command exited with code \d+\s*$/, ""));
	if (tool !== "codemode") {
		if (!runTool(tool)?.output) return [`(${tool} does not declare its output safe to show here)`];
		const text = texts.join("\n");
		return outputLines(registeredOutcome(tool, text, isError)?.text ?? text);
	}
	if (/^Script (completed|failed)\n/.test(texts[0] ?? "")) texts.shift();
	const calls = (result as { details?: { calls?: unknown } } | undefined)?.details?.calls;
	const lines = Array.isArray(calls)
		? calls.map((c: { name?: unknown; args?: unknown; status?: unknown } | null) =>
				`${CALL_ICON[String(c?.status)] ?? "·"} ${String(c?.name ?? "?")}${c?.args ? ` ${String(c.args)}` : ""}`,
			)
		: [];
	const text = texts.filter((t) => t !== "").join("\n").trim();
	return outputLines([...lines, ...(lines.length > 0 && text ? [""] : []), ...(text ? [text] : [])].join("\n"));
}

/** How a call ended: for a shell exit N, timed out, aborted, or failed; for codemode done or failed. */
function runOutcome(tool: Tool, isError: boolean, result: unknown): string {
	if (Object.hasOwn(SHELLS, tool)) return shellOutcome(isError, result);
	if (tool !== "codemode") {
		const status = registeredOutcome(tool, resultTexts(result).join("\n"), isError)?.status;
		if (status) return status;
	}
	return isError ? "failed" : "done";
}

/** How a shell call ended: exit N, timed out, aborted, or failed (blocked, no exit code). */
function shellOutcome(isError: boolean, result: unknown): string {
	const code = (result as { structuredContent?: { exit_code?: unknown } } | undefined)?.structuredContent?.exit_code;
	if (typeof code === "number") return `exit ${code}`;
	const text = resultTexts(result).join("\n");
	const exit = text.match(/Command exited with code (\d+)\s*$/);
	if (exit) return `exit ${exit[1]}`;
	if (!isError) return "exit 0";
	if (/Command timed out after [^\n]*$/.test(text)) return "timed out";
	return /Command aborted\s*$/.test(text) ? "aborted" : "failed";
}

// --- Preview layouts -----------------------------------------------------------------------------------------------

function contextRow(file: Snapshot, i: number, delta: number, marks?: Set<number>): Row {
	return { kind: " ", num: i + 1 + delta, text: file.lines[i], src: i, mark: marks?.has(i + 1) || undefined };
}

/**
 * The whole file with an edit call's replacements at their places, as far as its arguments have arrived. A replacement
 * is placed once its oldText is found exactly once in the file; it shows the whole lines it touches, what it keeps of
 * them as context, and until its newText arrives what it removes.
 */
function composeEdit(file: Snapshot, edits: EditArg[], streaming: boolean, marks?: Set<number>): Layout {
	const content = file.content;
	if (content === null) return { rows: [], note: file.note ?? "file not found" };
	interface Change {
		start: number;
		removed: string[];
		added: string[];
		index: number;
		cursor: boolean;
	}
	const changes: Change[] = [];
	let missing = 0;
	let ambiguous = 0;
	edits.forEach((edit, i) => {
		const last = i === edits.length - 1;
		const oldText = edit.oldText ?? "";
		const hasNew = edit.newText !== undefined;
		const oldDone = hasNew || !last || !streaming;
		const newDone = hasNew && (!last || !streaming);
		if (!oldText) return;
		const at = content.indexOf(oldText);
		if (at < 0 || content.indexOf(oldText, at + 1) >= 0) {
			if (oldDone && at < 0) missing++;
			else if (oldDone) ambiguous++;
			return;
		}
		const lineStart = at === 0 ? 0 : content.lastIndexOf("\n", at - 1) + 1;
		const prefix = content.slice(lineStart, at);
		const startLine = countNewlines(content, lineStart);
		let suffix = "";
		if (!oldText.endsWith("\n")) {
			const oldEnd = at + oldText.length;
			const lineEnd = content.indexOf("\n", oldEnd);
			suffix = content.slice(oldEnd, lineEnd < 0 ? content.length : lineEnd);
		}
		const oldLines = splitLines(prefix + oldText + suffix);
		const newText = prefix + (edit.newText ?? "") + (newDone ? suffix : "");
		const newLines = hasNew ? splitLines(newText) : [];
		const complete = newDone || newText.endsWith("\n") ? newLines.length : newLines.length - 1;
		const head = hasNew ? sharedHead(oldLines, newLines, complete) : 0;
		const tail = newDone ? sharedTail(oldLines, newLines, head) : 0;
		changes.push({
			start: startLine + head,
			removed: oldLines.slice(head, oldLines.length - tail),
			added: newLines.slice(head, newLines.length - tail),
			index: i,
			cursor: streaming && last,
		});
	});
	changes.sort((a, b) => a.start - b.start);
	const lastIndex = Math.max(-1, ...changes.map((c) => c.index));
	const rows: Row[] = [];
	let focus: Layout["focus"];
	let i = 0;
	let delta = 0;
	for (const c of changes) {
		if (c.start < i) continue; // overlaps the one before
		for (; i < c.start && i < file.lines.length; i++) rows.push(contextRow(file, i, delta, marks));
		const from = rows.length;
		c.removed.forEach((text, k) => rows.push({ kind: "-", num: c.start + k + 1 + delta, text }));
		c.added.forEach((text, k) => rows.push({ kind: "+", num: c.start + k + 1 + delta, text }));
		if (c.cursor && rows.length > from) rows[rows.length - 1] = { ...rows[rows.length - 1], cursor: true };
		if (c.index === lastIndex) focus = { from, to: Math.max(from, rows.length - 1) };
		delta += c.added.length - c.removed.length;
		i = c.start + c.removed.length;
	}
	for (; i < file.lines.length; i++) rows.push(contextRow(file, i, delta, marks));
	const note = missing ? "oldText not found" : ambiguous ? "oldText matches several places" : undefined;
	return { rows, focus, note };
}

/**
 * The file as a write call replaces it, as far as its content has arrived: the old lines it keeps at the start, then
 * what it writes; once complete, also the old lines it replaces and the ones it keeps at the end.
 */
function composeWrite(file: Snapshot, content: string | undefined, streaming: boolean, marks?: Set<number>): Layout {
	if (file.content === null && file.exists) return { rows: [], note: file.note };
	const oldLines = file.content === null ? [] : file.lines;
	if (content === undefined) return { rows: oldLines.map((_, i) => contextRow(file, i, 0, marks)) };
	const text = content.replace(/\r\n/g, "\n");
	const newLines = splitLines(text);
	const complete = !streaming || text.endsWith("\n") ? newLines.length : newLines.length - 1;
	const head = sharedHead(oldLines, newLines, complete);
	const tail = streaming ? 0 : sharedTail(oldLines, newLines, head);
	const rows: Row[] = [];
	for (let i = 0; i < head; i++) rows.push(contextRow(file, i, 0, marks));
	const from = rows.length;
	if (!streaming) oldLines.slice(head, oldLines.length - tail).forEach((t, k) => rows.push({ kind: "-", num: head + k + 1, text: t }));
	newLines.slice(head, newLines.length - tail).forEach((t, k) => rows.push({ kind: "+", num: head + k + 1, text: t }));
	if (streaming && rows.length > from) rows[rows.length - 1] = { ...rows[rows.length - 1], cursor: true };
	const focus = { from, to: Math.max(from, rows.length - 1) };
	if (!streaming) for (let i = oldLines.length - tail; i < oldLines.length; i++) rows.push(contextRow(file, i, newLines.length - oldLines.length, marks));
	const same = !streaming && head === oldLines.length && head === newLines.length;
	return { rows, focus, note: same ? "no changes" : file.exists ? undefined : "new file" };
}

/** The file as it is, with the marked lines. */
function composeFile(file: Snapshot, marks?: Set<number>, focus?: Layout["focus"]): Layout {
	if (file.content === null) return { rows: [], note: file.note ?? "file not found" };
	return { rows: file.lines.map((_, i) => contextRow(file, i, 0, marks)), focus };
}

/**
 * A command or script with the bar in the gutter, the cursor while it is written, then a rule and its output. While it
 * is written the view keeps its end in sight; once written it stays at the top, the output below it.
 */
function composeRun(code: Snapshot, streaming: boolean, output: string[] | undefined): Layout {
	const lines = streaming ? (code.content ?? "").split("\n") : code.lines;
	const rows: Row[] = lines.map((text, i) => ({ kind: " ", num: i + 1, text, src: i, mark: true }));
	if (streaming && rows.length > 0) rows[rows.length - 1].cursor = true;
	if (output) {
		rows.push({ kind: "r", num: 0, text: "" });
		for (const text of output) rows.push({ kind: "o", num: 0, text });
	}
	return streaming
		? { rows, focus: { from: rows.length - 1, to: rows.length - 1 }, tail: true, wrap: true }
		: { rows, focus: { from: 0, to: 0 }, wrap: true };
}

// --- Changed lines -------------------------------------------------------------------------------------------------

function parsePatch(patch: string): Hunk[] {
	const hunks: Hunk[] = [];
	for (const line of patch.split("\n")) {
		const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		if (m) {
			// A side with no lines names the line before the hunk.
			hunks.push({ oldStart: Number(m[1]) + (m[2] === "0" ? 1 : 0), newStart: Number(m[3]) + (m[4] === "0" ? 1 : 0), lines: [] });
		} else if (hunks.length > 0 && /^[ +-]/.test(line)) hunks[hunks.length - 1].lines.push(line);
	}
	return hunks;
}

/** One hunk for what differs between the first and last lines `a` and `b` share. */
function headTailHunks(a: string[], b: string[]): Hunk[] {
	const head = sharedHead(a, b, b.length);
	const tail = sharedTail(a, b, head);
	if (head === a.length && head === b.length) return [];
	const lines = [...a.slice(head, a.length - tail).map((l) => `-${l}`), ...b.slice(head, b.length - tail).map((l) => `+${l}`)];
	return [{ oldStart: head + 1, newStart: head + 1, lines }];
}

/** The lines of the new file the hunks add, and where the first removal is when they add none. */
function changedLines(hunks: Hunk[]): { added: number[]; at?: number } {
	const added: number[] = [];
	let at: number | undefined;
	for (const h of hunks) {
		let n = h.newStart;
		for (const l of h.lines) {
			if (l[0] === "+") added.push(n++);
			else if (l[0] === " ") n++;
			else at ??= n;
		}
	}
	return { added, at };
}

/** Where line `line` of the old file is in the new one; undefined when the hunks removed it. */
function remapLine(hunks: Hunk[], line: number): number | undefined {
	let delta = 0;
	for (const h of hunks) {
		if (line < h.oldStart) return line + delta;
		let o = h.oldStart;
		let n = h.newStart;
		for (const l of h.lines) {
			if (l[0] === " ") {
				if (o === line) return n;
				o++;
				n++;
			} else if (l[0] === "-") {
				if (o === line) return undefined;
				o++;
			} else n++;
		}
		delta = n - o;
	}
	return line + delta;
}

// --- Rendering -----------------------------------------------------------------------------------------------------

/** Control characters other than tab would reach the terminal as they are. */
function clean(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\t/g, TAB);
}

function highlighted(file: Snapshot, theme: Theme): string[] {
	if (file.hl?.theme === theme) return file.hl.lines;
	const text = file.lines.map(clean).join("\n");
	const lang = file.lang ?? getLanguageFromPath(file.abs);
	let lines: string[];
	try {
		lines = lang && text.length <= MAX_HIGHLIGHT_BYTES ? highlightCode(text, lang) : text.split("\n").map((l) => theme.fg("toolDiffContext", l));
	} catch {
		lines = text.split("\n");
	}
	file.hl = { theme, lines };
	file.fmt = undefined;
	return lines;
}

/** Rows a wrapped line of a command takes at most; the rest is cut with …, or while it is written its start. */
const MAX_WRAP_ROWS = 8;

/** `text` wrapped to `width` columns, at most MAX_WRAP_ROWS rows, with `cursor` after its end when it is written. */
function wrapRows(text: string, width: number, cursor: string): string[] {
	let parts = text === "" ? [""] : wrapTextWithAnsi(text, width);
	if (parts.length === 0) parts = [""];
	if (cursor) {
		const last = parts[parts.length - 1];
		if (visibleWidth(last) < width) parts[parts.length - 1] = last + cursor;
		else parts.push(cursor);
	}
	if (parts.length <= MAX_WRAP_ROWS) return parts;
	if (cursor) {
		// While it is written, its end matters: keep the last rows, … in front.
		parts = parts.slice(-MAX_WRAP_ROWS);
		parts[0] = `…${sliceByColumn(parts[0], 1, Math.max(0, width - 1))}`;
		return parts;
	}
	parts = parts.slice(0, MAX_WRAP_ROWS);
	parts[MAX_WRAP_ROWS - 1] = `${sliceByColumn(parts[MAX_WRAP_ROWS - 1], 0, Math.max(0, width - 1))}\x1b[0m…`;
	return parts;
}

/**
 * The rows of a layout as panel lines of `width` columns: border, line number, a space, gutter, sign, text. A wrapped
 * row continues on lines with an empty number column.
 */
function renderRows(theme: Theme, layout: Layout, file: Snapshot | undefined, width: number): string[] {
	const border = theme.fg("border", "│");
	if (layout.rows.length === 0) {
		const text = layout.note ?? (file?.content === "" ? "empty file" : "");
		return text ? [`${border} ${theme.fg("muted", truncateToWidth(text, Math.max(1, width - 2), "…"))}`] : [];
	}
	let max = 1;
	for (const r of layout.rows) if (r.num > max) max = r.num;
	const numWidth = String(max).length;
	const textWidth = Math.max(1, width - numWidth - 5);
	const hl = file && file.content !== null ? highlighted(file, theme) : [];
	if (file && (file.fmt?.theme !== theme || file.fmt.width !== textWidth)) file.fmt = { theme, width: textWidth, lines: [] };
	const bar = theme.fg("accent", "▌");
	const cursor = theme.fg("accent", "▍");
	return layout.rows.flatMap((r) => {
		if (r.kind === "r") return `${border} ${theme.fg("dim", "─".repeat(Math.max(1, width - 3)))}`;
		if (r.kind === "o") return `${border} ${theme.fg("toolOutput", truncateToWidth(r.text, Math.max(1, width - 2), "…"))}`;
		const num = `${String(r.num).padStart(numWidth)} `;
		if (r.kind === " ") {
			let text: string;
			const line = r.src !== undefined ? hl[r.src] : undefined;
			if (layout.wrap) {
				const gutter = `${border} ${theme.fg(r.mark ? "accent" : "dim", num)}${r.mark ? bar : " "} `;
				const more = `${border} ${" ".repeat(num.length)}${r.mark ? bar : " "} `;
				return wrapRows(line ?? clean(r.text), textWidth, r.cursor ? cursor : "").map((p, k) => (k === 0 ? gutter : more) + p);
			}
			if (r.cursor) text = truncateToWidth(line ?? clean(r.text), Math.max(1, textWidth - 1), "…") + cursor;
			else if (file?.fmt && r.src !== undefined) text = file.fmt.lines[r.src] ??= truncateToWidth(hl[r.src] ?? clean(r.text), textWidth, "…");
			else text = truncateToWidth(clean(r.text), textWidth, "…");
			return `${border} ${theme.fg(r.mark ? "accent" : "dim", num)}${r.mark ? bar : " "} ${text}`;
		}
		const color = r.kind === "+" ? "toolDiffAdded" : "toolDiffRemoved";
		const text = truncateToWidth(clean(r.text), Math.max(1, r.cursor ? textWidth - 1 : textWidth), "…");
		return `${border} ${theme.fg(color, num)}${bar}${theme.fg(color, `${r.kind}${text}`)}${r.cursor ? cursor : ""}`;
	});
}

/** `left` and `right` on one line of `width` columns, `left` cut to make room. */
function spread(left: string, right: string, width: number): string {
	const room = Math.max(1, width - visibleWidth(right) - 1);
	const cut = truncateToWidth(left, room, "…");
	return `${cut}${" ".repeat(Math.max(1, width - visibleWidth(cut) - visibleWidth(right)))}${right}`;
}

/** The colour of a call's status; exit N other than 0 is an error. */
const STATUS_COLOR: Record<string, "accent" | "muted" | "success" | "error" | "warning"> = {
	"writing…": "accent",
	queued: "muted",
	"applying…": "muted",
	"running…": "accent",
	applied: "success",
	done: "success",
	"exit 0": "success",
	aborted: "warning",
	"not applied": "muted",
	"not run": "muted",
};

function headerLine(theme: Theme, width: number, v: View, focused: boolean): string {
	const border = theme.fg("border", "│");
	const name = v.title ?? "File preview";
	const sub = v.subtitle ? ` ${theme.fg("muted", v.subtitle)}` : "";
	const left = `${border} ${theme.bold(focused ? theme.fg("accent", name) : name)}${sub}`;
	const note = v.layout.note;
	const status = v.status;
	const right =
		(note ? `${theme.fg(note.startsWith("oldText") ? "warning" : "muted", note)}  ` : "") +
		(status ? `${theme.fg(STATUS_COLOR[status] ?? "error", `● ${status}`)}  ` : "") +
		`${theme.fg("muted", "✕")} `;
	return spread(left, right, width);
}

function readPrefs(): Prefs {
	try {
		return JSON.parse(readFileSync(PREFS_FILE, "utf8")) as Prefs;
	} catch {
		return {};
	}
}

function writePrefs(prefs: Prefs): void {
	try {
		writeFileSync(PREFS_FILE, `${JSON.stringify(prefs, null, 2)}\n`, { mode: 0o600 });
	} catch {
		// not persisted
	}
}

/**
 * The panel's scroll view. It reports when the user scrolls it (wheel, scrollbar, keys), which pauses following, and
 * scrolls for the panel with jump(): the target is computed once the body is drawn and the layout knows its new height.
 */
class PanelScroll extends ScrollView {
	onUserScroll: () => void = () => {};
	/** Whether the body shows a command's output cut in the middle; the first wheel or key then shows all of it. */
	cut = false;
	private jumpTarget: (() => number) | undefined;
	private jumping = false;

	jump(target: () => number): void {
		this.jumpTarget = target;
	}

	override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		const before = this.viewportHeight;
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		// An output is cut for the panel's height: when that changes and the body was cut or does not fit, cut it anew.
		if (this.viewportHeight !== before && (this.cut || contentHeight > this.viewportHeight)) requestRender();
		const target = this.jumpTarget;
		if (!target) return;
		this.jumpTarget = undefined;
		this.jumping = true;
		try {
			super.scrollTo(target(), { disableFollow: true });
		} catch {
			// keep the position
		} finally {
			this.jumping = false;
		}
	}

	override scrollTo(scrollTop: number, options?: { disableFollow?: boolean }): void {
		if (!this.jumping) this.onUserScroll();
		super.scrollTo(scrollTop, options);
	}

	override scrollBy(lines: number): number {
		if (this.cut && lines !== 0) {
			this.onUserScroll();
			return 0;
		}
		const rest = super.scrollBy(lines);
		if (rest !== lines) this.onUserScroll();
		return rest;
	}
}

/** Output rows a command keeps at least when it is cut, even when the command itself fills the panel. */
const MIN_OUTPUT_ROWS = 7;

/**
 * The panel lines of a command's view cut to `height` rows: the command, then the start and the end of the output with
 * a line in the middle that says how many lines are hidden. Unchanged when it fits, or when it is no command's view.
 */
function cutOutput(theme: Theme, layout: Layout, lines: string[], height: number, width: number): string[] {
	const rule = layout.rows.findIndex((r) => r.kind === "r");
	// The output's rows are one line each; the command's may wrap, so the output starts `count` lines from the end.
	const count = rule < 0 ? 0 : layout.rows.length - rule - 1;
	if (rule < 0 || lines.length < count + 1 || lines.length <= height) return lines;
	const start = lines.length - count;
	const room = Math.max(MIN_OUTPUT_ROWS, height - start);
	if (count <= room) return lines;
	const head = Math.floor((room - 1) / 2);
	const tail = room - 1 - head;
	const hidden = count - head - tail;
	const note = `⋯ ${hidden} ${hidden === 1 ? "line" : "lines"} hidden, scroll to show them`;
	const marker = `${theme.fg("border", "│")} ${theme.fg("muted", truncateToWidth(note, Math.max(1, width - 2), "…"))}`;
	return [...lines.slice(0, start + head), marker, ...lines.slice(lines.length - tail)];
}

// --- Extension -----------------------------------------------------------------------------------------------------

interface View {
	title?: string;
	/** For bash and codemode: the command's first line. */
	subtitle?: string;
	status?: string;
	file?: Snapshot;
	layout: Layout;
	streaming: boolean;
}

export default function (pi: ExtensionAPI) {
	if (Number(process.env.PI_SUBAGENT_DEPTH || 0) > 0) return;

	let prefs = readPrefs();
	let tuiRef: TUI | undefined;
	let cwd = process.cwd();
	let panel: ReturnType<typeof createPanel> | null = null;
	let autoTried = false;
	const live = new Map<string, LiveEdit>();
	let liveSeq = 0;
	/** The call the preview follows. */
	let current: LiveEdit | undefined;
	/** Changed lines per file, until the next prompt. */
	const marks = new Map<string, Set<number>>();
	/** Bumped on every change of what the panel shows. */
	let version = 0;
	let viewCache: { version: number; view: View } | undefined;

	const safe =
		<A extends unknown[]>(fn: (...args: A) => void) =>
		(...args: A): void => {
			try {
				fn(...args);
			} catch {
				// a failing preview must not take the session down
			}
		};

	function shownPath(abs: string): string {
		const rel = path.relative(cwd, abs);
		return rel.startsWith("..") || path.isAbsolute(rel) ? abs.replace(os.homedir(), "~") : rel;
	}

	function view(): View {
		if (viewCache?.version === version) return viewCache.view;
		const entry = current;
		let result: View = { layout: { rows: [] }, streaming: false };
		const raw = entry && !isRun(entry.tool) ? pathOf(entry) : "";
		if (entry && isRun(entry.tool)) {
			const code = runText(entry);
			if (entry.file?.content !== code) {
				const lang = entry.tool === "codemode" ? "javascript" : (runTool(entry.tool)?.language ?? "bash");
				entry.file = { abs: entry.tool, lang, exists: true, content: code, lines: splitLines(code) };
			}
			const status = entry.stopped
				? "not run"
				: (entry.outcome ?? (entry.streaming ? "writing…" : entry.running ? "running…" : "queued"));
			const first = code.split("\n").find((l) => l.trim() !== "") ?? "";
			const layout = composeRun(entry.file, entry.streaming, entry.output);
			result = { title: entry.tool, subtitle: clean(first.trim()), status, file: entry.file, layout, streaming: entry.streaming };
		} else if (entry && raw) {
			const abs = resolvePath(cwd, raw);
			const status = entry.failed
				? "failed"
				: entry.stopped
					? "not applied"
					: entry.done
						? "applied"
						: entry.streaming
							? "writing…"
							: entry.running
								? "applying…"
								: "queued";
			const fileMarks = marks.get(abs);
			if (entry.done || entry.failed || entry.stopped) {
				entry.after ??= readSnapshot(abs);
				result = { title: shownPath(abs), status, file: entry.after, layout: composeFile(entry.after, fileMarks, entry.done ? entry.focus : undefined), streaming: false };
			} else {
				if (entry.file?.abs !== abs) entry.file = readSnapshot(abs);
				const args = liveArgs(entry);
				const layout =
					entry.tool === "edit"
						? composeEdit(entry.file, args.edits, entry.streaming, fileMarks)
						: composeWrite(entry.file, args.content, entry.streaming, fileMarks);
				result = { title: shownPath(abs), status, file: entry.file, layout, streaming: entry.streaming };
			}
		} else if ([...live.values()].some((e) => e.streaming)) result.status = "writing…";
		viewCache = { version, view: result };
		return result;
	}

	/** Follows the call written last that can be shown, and forgets the calls that are over and not followed. */
	function pick(): void {
		for (const entry of live.values()) if ((!current || entry.seq > current.seq) && ready(entry)) current = entry;
		for (const [id, entry] of live) if (entry !== current && (entry.done || entry.failed || entry.stopped)) live.delete(id);
		version++;
	}

	function changed(started: boolean): void {
		pick();
		if (!panel) return;
		if (started) panel.resume();
		panel.frame(started);
	}

	// --- Panel -----------------------------------------------------------------------------------------------------

	function createPanel(ctx: ExtensionContext, tui: TUI, original: Component, transcript: Component, dock: Component) {
		const theme = () => ctx.ui.theme;
		let focused = false;
		let previousFocus: Component | null = null;
		let paused = false;
		let frameTimer: NodeJS.Timeout | null = null;
		let bodyCache: { key: string; theme: Theme; lines: string[] } | undefined;
		let headerWidth = 0;

		function focus(on: boolean): void {
			if (on === focused) return;
			if (on) {
				previousFocus = (tui as unknown as { getFocusedComponent?: () => Component | null }).getFocusedComponent?.() ?? null;
				tui.setFocus(header);
			} else if (previousFocus) {
				tui.setFocus(previousFocus);
				previousFocus = null;
			}
			focused = on;
			tui.requestRender();
		}

		/**
		 * Centres the focused rows: the whole change when it fits, else its end while it is written, else its start. A
		 * command being written keeps its last row at the bottom; once written, its first row is the focus, at the top.
		 */
		function follow(v: View, total: number): void {
			const f = v.layout.focus;
			if (paused || !f) return;
			scroll.jump(() => {
				const height = scroll.viewportHeight || Math.max(5, tui.terminal.rows - 6);
				const size = f.to - f.from + 1;
				const top = v.layout.tail
					? total - height
					: size <= height - 4 ? f.from - Math.floor((height - size) / 2) : v.streaming ? f.to - height + 3 : f.from - 2;
				return Math.max(0, top);
			});
		}

		const header: Component = {
			// While focused, PgUp/PgDn and the other viewport keys come here instead of scrolling the conversation.
			capturesViewportInput: true,
			render(width: number): string[] {
				headerWidth = width;
				try {
					const v = view();
					const lines = [headerLine(theme(), width, v, focused)];
					if (focused) {
						const help = "↑↓ PgUp/PgDn Home/End scroll · Esc back · x close";
						lines.push(`${theme().fg("border", "│")} ${theme().fg("dim", truncateToWidth(help, Math.max(1, width - 2), "…"))}`);
					}
					lines.push(theme().fg("border", `│${"─".repeat(Math.max(0, width - 1))}`));
					return lines.map((l) => truncateToWidth(l, width));
				} catch {
					return [theme().fg("border", "│")];
				}
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (event.type === "click" && event.button === "left" && event.y === 0 && event.x >= headerWidth - 3) {
					closePanel(true);
					return { handled: true };
				}
				return event.type === "press" ? { handled: true } : undefined;
			},
			handleInput(data: string): void {
				try {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.alt("g"))) return focus(false);
					if (data === "x") return closePanel(true);
					const height = scroll.viewportHeight || 10;
					const total = bodyCache?.lines.length ?? 0;
					const top = scroll.scrollTop;
					const max = Math.max(0, total - height);
					let next: number | undefined;
					if (matchesKey(data, Key.up) || data === "k") next = Math.max(0, top - 1);
					else if (matchesKey(data, Key.down) || data === "j") next = Math.min(max, top + 1);
					else if (matchesKey(data, Key.pageUp)) next = Math.max(0, top - height);
					else if (matchesKey(data, Key.pageDown) || data === " ") next = Math.min(max, top + height);
					else if (matchesKey(data, Key.home) || data === "g") next = 0;
					else if (matchesKey(data, Key.end) || data === "G") next = max;
					if (next !== undefined) {
						scroll.scrollTo(next, { disableFollow: true });
						tui.requestRender();
					}
				} catch {
					// ignore the key
				}
			},
			invalidate(): void {},
		};

		const body: Component = {
			render(width: number): string[] {
				const t = theme();
				const border = t.fg("border", "│");
				let lines: string[];
				try {
					const height = scroll.viewportHeight || Math.max(5, tui.terminal.rows - 6);
					const key = `${version}:${width}:${paused ? "all" : height}`;
					if (bodyCache?.key !== key || bodyCache.theme !== t) {
						const v = view();
						lines = v.title ? renderRows(t, v.layout, v.file, width) : v.status ? [] : [`${border} ${t.fg("muted", "Nothing edited or run yet.")}`];
						// Following, a long output shows its start and its end; once the user scrolls, all of it.
						const all = lines;
						if (!paused && !v.streaming) lines = cutOutput(t, v.layout, lines, height, width);
						scroll.cut = lines !== all;
						bodyCache = { key, theme: t, lines };
						follow(v, lines.length);
					}
					lines = bodyCache.lines;
				} catch (e) {
					lines = [`${border} ${t.fg("error", truncateToWidth(`preview failed: ${e instanceof Error ? e.message : e}`, Math.max(1, width - 2), "…"))}`];
				}
				const fill = Math.max(0, (scroll.viewportHeight || 0) - lines.length);
				return fill > 0 ? [...lines, ...Array(fill).fill(border)] : lines;
			},
			invalidate(): void {
				bodyCache = undefined;
			},
		};

		const scroll = new PanelScroll(body, { scrollbar: "auto", overscroll: "contain" });
		scroll.onUserScroll = () => {
			paused = true;
			if (scroll.cut) {
				scroll.cut = false;
				tui.requestRender();
			}
		};
		const column = new VStack([
			{ component: header, basis: "auto", grow: 0, shrink: 0 },
			{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		]);
		const row = new HStack([
			{ component: transcript, basis: 0, grow: 11, shrink: 1, minSize: 40 },
			{ component: column, basis: 0, grow: 9, shrink: 1, minSize: 40, visible: (vp) => vp.width >= PANEL_MIN_COLUMNS },
		]);
		const root = new VStack([
			{ component: row, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);

		return {
			root,
			original,
			focus: (on?: boolean) => focus(on ?? !focused),
			/** Something changed: draw now, or within LIVE_FRAME_MS while arguments stream in. */
			frame(now: boolean) {
				if (now) {
					if (frameTimer) clearTimeout(frameTimer);
					frameTimer = null;
					tui.requestRender();
					return;
				}
				if (frameTimer) return;
				frameTimer = setTimeout(() => {
					frameTimer = null;
					if (panel?.root === root) tui.requestRender();
				}, LIVE_FRAME_MS);
			},
			/** A new call started: follow again. */
			resume() {
				paused = false;
			},
			dispose() {
				if (frameTimer) clearTimeout(frameTimer);
				frameTimer = null;
				if (focused && previousFocus) tui.setFocus(previousFocus);
				focused = false;
			},
		};
	}

	/** Why the panel cannot open now, or undefined. */
	function cannotOpen(ctx: ExtensionContext): string | undefined {
		if (ctx.mode !== "tui") return "The file preview needs Pi's interactive terminal.";
		const tui = tuiRef;
		if (!tui || !isViewportTUI(tui)) return "The file preview needs Pi's fullscreen mode.";
		if (tui.terminal.columns < PANEL_MIN_COLUMNS) return `The file preview needs ${PANEL_MIN_COLUMNS} columns; this terminal has ${tui.terminal.columns}.`;
		return undefined;
	}

	/** Splits Pi's fullscreen layout into the conversation and the panel; false when that layout is not there. */
	function openPanel(ctx: ExtensionContext): boolean {
		if (panel) return true;
		const tui = tuiRef;
		if (!tui || cannotOpen(ctx) || !isViewportTUI(tui)) return false;
		const original = (tui as unknown as { layoutRoot?: Component }).layoutRoot;
		const entries = (original as unknown as { entries?: Array<{ component: Component }> } | undefined)?.entries;
		if (!original || !Array.isArray(entries) || entries.length !== 2 || !("scrollTop" in entries[0].component)) return false;
		panel = createPanel(ctx, tui, original, entries[0].component, entries[1].component);
		tui.setLayoutRoot(panel.root);
		version++;
		tui.requestRender();
		return true;
	}

	function closePanel(byUser: boolean): void {
		const open = panel;
		if (!open) return;
		panel = null;
		open.dispose();
		const tui = tuiRef as unknown as { layoutRoot?: Component; setLayoutRoot?: (c: Component | undefined) => void; requestRender?: () => void } | undefined;
		if (tui?.layoutRoot === open.root) tui.setLayoutRoot?.(open.original);
		tui?.requestRender?.();
		if (byUser) {
			prefs = { ...readPrefs(), panel: "closed" };
			writePrefs(prefs);
		}
	}

	function userOpen(ctx: ExtensionContext): boolean {
		const why = cannotOpen(ctx);
		if (why || !openPanel(ctx)) {
			ctx.ui.notify(why ?? "The file preview cannot split this version of Pi's layout.", "info");
			return false;
		}
		prefs = { ...readPrefs(), panel: "opened" };
		writePrefs(prefs);
		return true;
	}

	/** Opens the panel at the session's first edit, as far as the terminal and the preference allow. */
	function autoOpen(ctx: ExtensionContext): void {
		if (panel || autoTried || ctx.mode !== "tui" || !tuiRef) return;
		autoTried = true;
		const need = prefs.panel === "opened" ? PANEL_MIN_COLUMNS : AUTO_OPEN_COLUMNS;
		if (prefs.panel !== "closed" && tuiRef.terminal.columns >= need) openPanel(ctx);
	}

	/** The call has run: show the file as it is now and mark the lines it changed. */
	function applied(entry: LiveEdit, details: unknown): void {
		const raw = pathOf(entry) || liveArgs(entry).path;
		if (!raw) return;
		const abs = resolvePath(cwd, raw);
		const before = entry.file?.abs === abs ? entry.file : undefined;
		const after = readSnapshot(abs);
		const patch = (details as { patch?: unknown } | undefined)?.patch;
		let hunks: Hunk[] = [];
		if (entry.tool === "edit" && typeof patch === "string" && patch.includes("@@")) hunks = parsePatch(patch);
		else if (before && (before.content !== null || !before.exists) && after.content !== null) hunks = headTailHunks(before.lines, after.lines);
		const next = new Set<number>();
		for (const line of marks.get(abs) ?? []) {
			const moved = remapLine(hunks, line);
			if (moved !== undefined) next.add(moved);
		}
		const { added, at } = changedLines(hunks);
		for (const line of added) next.add(line);
		marks.set(abs, next);
		entry.done = true;
		entry.running = false;
		entry.streaming = false;
		entry.after = after;
		entry.focus = added.length > 0 ? { from: Math.min(...added) - 1, to: Math.max(...added) - 1 } : at !== undefined ? { from: at - 1, to: at - 1 } : undefined;
		// Calls of the same file still to run see it as it is now.
		for (const other of live.values()) {
			if (other !== entry && !other.done && !isRun(other.tool) && other.file?.abs === abs) other.file = readSnapshot(abs);
		}
	}

	/** The entry of a call, created with the next sequence number when it is new. */
	function entryOf(id: string, tool: Tool, ctx: ExtensionContext, streaming: boolean): { entry: LiveEdit; started: boolean } {
		const known = live.get(id);
		if (known) return { entry: known, started: false };
		const entry: LiveEdit = { id, tool, json: "", args: {}, parsed: true, streaming, running: false, seq: ++liveSeq };
		live.set(id, entry);
		autoOpen(ctx);
		return { entry, started: true };
	}

	/** The call ended: applied or failed, a command or script with its output and outcome. */
	function finish(id: string, isError: boolean, result: unknown): void {
		const entry = live.get(id);
		if (!entry || entry.done || entry.failed) return;
		if (isRun(entry.tool)) {
			entry.output = runOutput(entry.tool, result, isError);
			entry.outcome = runOutcome(entry.tool, isError, result);
			entry.done = true;
			entry.streaming = false;
		} else if (isError) entry.failed = true;
		else applied(entry, (result as { details?: unknown } | undefined)?.details);
		entry.running = false;
		changed(false);
		panel?.frame(true);
	}

	pi.on("session_start", safe((_event, ctx) => {
		cwd = ctx.cwd;
		prefs = readPrefs();
		autoTried = false;
		live.clear();
		marks.clear();
		current = undefined;
		version++;
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget("file-preview-probe", (tui) => {
			tuiRef = tui;
			return { render: () => [], invalidate() {} };
		});
		ctx.ui.setWidget("file-preview-probe", undefined);
	}));

	pi.on("session_shutdown", safe(() => {
		closePanel(false);
		live.clear();
		marks.clear();
		current = undefined;
		viewCache = undefined;
	}));

	// A new prompt: the changed lines lose their marks.
	pi.on("input", () => {
		marks.clear();
		version++;
		safe(() => panel?.frame(true))();
		return { action: "continue" as const };
	});

	// The model writes a call: its arguments arrive piece by piece, the provider's partial JSON or Pi's deltas.
	pi.on("message_update", safe((event, ctx) => {
		const update = event.assistantMessageEvent as unknown as { type: string; contentIndex?: number; delta?: unknown; toolCall?: unknown };
		if (!update.type.startsWith("toolcall_")) return;
		const content = (event.message as { content?: unknown }).content;
		const block = (update.toolCall ?? (Array.isArray(content) ? content[update.contentIndex ?? -1] : undefined)) as
			| { id?: string; name?: string; arguments?: Record<string, unknown>; partialJson?: unknown }
			| undefined;
		if (!block?.id || !isTool(block.name)) return;
		const { entry, started } = entryOf(block.id, block.name, ctx, true);
		if (!entry.streaming) return;
		if (update.type === "toolcall_end") {
			entry.streaming = false;
			if (block.arguments && Object.keys(block.arguments).length > 0) {
				entry.args = block.arguments;
				entry.parsed = true;
			}
		} else {
			const json =
				typeof block.partialJson === "string"
					? block.partialJson
					: update.type === "toolcall_delta" && typeof update.delta === "string"
						? entry.json + update.delta
						: entry.json;
			if (json !== entry.json) {
				entry.json = json;
				entry.parsed = false;
			} else if (!json && block.arguments) entry.args = block.arguments;
		}
		changed(started);
	}));

	// A response that broke off leaves calls that will not run.
	pi.on("message_end", safe((event) => {
		const message = event.message as { role?: string; stopReason?: string };
		if (message.role !== "assistant" || (message.stopReason !== "aborted" && message.stopReason !== "error")) return;
		for (const entry of live.values()) if (entry.streaming) entry.stopped = true;
		changed(false);
	}));

	// Calls a codemode script makes (parentToolCallId) are left out: the panel keeps showing the script.
	pi.on("tool_call", safe((event, ctx) => {
		if (!isTool(event.toolName) || event.parentToolCallId) return;
		const { entry } = entryOf(event.toolCallId, event.toolName, ctx, false);
		entry.args = event.input as Record<string, unknown>;
		entry.parsed = true;
		entry.streaming = false;
		// The file as it is right before the call runs: an earlier call may have changed it since it was read.
		const raw = isRun(entry.tool) ? "" : liveArgs(entry).path;
		if (raw) entry.file = readSnapshot(resolvePath(ctx.cwd, raw));
		changed(false);
	}));

	// Also a call whose arguments did not stream (another provider, or a whole message) gets its preview here.
	pi.on("tool_execution_start", safe((event, ctx) => {
		if (!isTool(event.toolName) || event.parentToolCallId) return;
		const { entry, started } = entryOf(event.toolCallId, event.toolName, ctx, false);
		entry.streaming = false;
		entry.running = true;
		if (isRun(entry.tool)) entry.output ??= [];
		if (event.args && typeof event.args === "object" && Object.keys(event.args).length > 0) {
			entry.args = event.args as Record<string, unknown>;
			entry.parsed = true;
		}
		changed(started);
	}));

	// bash sends the tail of its output so far, codemode its nested calls.
	pi.on("tool_execution_update", safe((event) => {
		const entry = event.parentToolCallId ? undefined : live.get(event.toolCallId);
		if (!entry || !isRun(entry.tool) || entry.done) return;
		entry.streaming = false;
		entry.running = true;
		entry.output = runOutput(entry.tool, event.partialResult);
		changed(false);
	}));

	pi.on("tool_result", safe((event) => {
		if (!isTool(event.toolName) || event.parentToolCallId) return;
		const { content, details, structuredContent } = event;
		finish(event.toolCallId, event.isError, { content, details, structuredContent });
	}));

	pi.on("tool_execution_end", safe((event) => {
		if (!event.parentToolCallId) finish(event.toolCallId, event.isError, event.result);
	}));

	// Nothing runs any more: what is still written or queued was never run.
	pi.on("agent_settled", safe(() => {
		for (const entry of live.values()) if (!entry.done && !entry.failed && !entry.running) entry.stopped = true;
		changed(false);
		panel?.frame(true);
	}));

	pi.registerShortcut("alt+g", {
		description: "Move the keyboard into the file preview and back (opens it when closed)",
		handler: (ctx) => {
			try {
				if (panel) panel.focus();
				else if (userOpen(ctx)) (panel as ReturnType<typeof createPanel> | null)?.focus(true);
			} catch {
				// no preview
			}
		},
	});

	pi.registerCommand("preview", {
		description: "Open or close the live preview of the file being edited",
		handler: async (_args, ctx) => {
			cwd = ctx.cwd;
			if (panel) closePanel(true);
			else userOpen(ctx);
		},
	});
}
