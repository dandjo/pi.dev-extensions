/**
 * /diff: Claude Code's diff panel and diff dialog
 * (https://code.claude.com/docs/en/interactive-mode#review-changes-with-%2Fdiff).
 *
 * Panel — fullscreen terminal, git repository, at least 110 columns:
 * - Opens beside the conversation and stays open, refreshed after every edit, write, and bash call and when the agent
 *   settles. It lists the changed files with their added and removed lines and shows each file's diff under the list.
 *   Test and generated files, and changes from before this session, are folded into one line each.
 * - Mouse: click a file to jump to its diff; ask, right of a file's name above its diff, attaches that diff to your
 *   next prompt; the source label steps through Current and the turn views T1, T2, …; the base label switches between
 *   this session's changes, all uncommitted changes, and everything since the branch split from the default branch; a
 *   folded line unfolds; ✕ closes. The wheel scrolls.
 * - Live: an edit or write call shows at the top of the panel while the model writes it, before it runs: the lines it
 *   removes and adds at their place in the file, with the line number once its oldText is found there. Its file reads
 *   editing… in the list. The preview stays until the refresh after the call shows the real diff.
 * - Following: then the panel selects the changed file and scrolls to the hunk, which keeps an accent bar in the gutter
 *   until the next prompt. Scrolling the panel or picking a file pauses that until the next prompt; f or the follow
 *   label switches it off and on, kept in diff-panel.json.
 * - Keyboard: alt+g moves into the panel and back. There ↑↓ pick a file, PgUp/PgDn/Home/End scroll, Tab switches the
 *   source, b the base, a asks, e unfolds, f follows, r refreshes, Esc returns to the editor, x closes.
 * - It opens on its own when the model starts the session's first edit and the terminal has 144 columns, or 110 once
 *   you have opened it with /diff. Closed, it stays closed, in later sessions too, until /diff opens it again. /diff toggles it.
 * Dialog — otherwise: a bordered block above the prompt with the same views. ↑↓ select, Enter opens a diff, a asks,
 * Tab switches the source, b the base, r refreshes, Esc goes back and closes.
 *
 * The live preview reads the calls' arguments from the message stream (message_update), the file as it was before the
 * call, and drops the preview at the refresh after the call ran. Turn views come from the session's edit and write
 * calls; changes made through bash appear only under Current. The
 * base is remembered per repository in ~/.pi/agent/diff-panel.json, and the dialog uses the panel's. The panel splits
 * Pi's fullscreen layout through tui.setLayoutRoot(); when that layout is not the one this was built against (Pi 1.4),
 * /diff opens the dialog instead.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseStreamingJson } from "@earendil-works/pi-ai";
import {
	type Component,
	HStack,
	isViewportTUI,
	Key,
	matchesKey,
	ScrollView,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BASELINE_FILE = 1024 * 1024;
const MAX_BASELINE_TOTAL = 64 * 1024 * 1024;
const MAX_PANEL_FILES = 60;
const MAX_PATCH_LINES = 2_000;
const PANEL_MIN_COLUMNS = 110;
const AUTO_OPEN_COLUMNS = 144;
const REFRESH_DELAY_MS = 400;
const EDIT_REFRESH_DELAY_MS = 120;
/** The live preview redraws at most this often while a call's arguments arrive. */
const LIVE_FRAME_MS = 80;
const LIVE_CONTEXT = 2;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PREFS_FILE = path.join(getAgentDir(), "diff-panel.json");

type Base = "session" | "head" | "branch";
const BASES: Base[] = ["session", "head", "branch"];
const BASE_LABEL: Record<Base, string> = { session: "this session", head: "uncommitted", branch: "branch" };
type Group = "main" | "aux" | "before";

interface FileChange {
	path: string;
	added: number;
	removed: number;
	group: Group;
	untracked?: boolean;
	binary?: boolean;
	/** Copy of the file as it was when the session started, for files that were already changed then. */
	startCopy?: string | null;
	patch?: string;
}

interface View {
	label: string;
	title: string;
	files: FileChange[];
	current: boolean;
	root?: string;
	ref?: string;
}

interface Repo {
	root: string;
	head: string;
}

interface Baseline {
	root: string;
	dir: string;
	files: Map<string, { hash: string | null; copy: string | null }>;
}

interface Prefs {
	panel?: "auto" | "opened" | "closed";
	bases?: Record<string, Base>;
	follow?: boolean;
}

/** The file a live call changes, as it was before the call ran. */
interface LiveFile {
	abs: string;
	exists: boolean;
	/** null when the file is not there or too large to compare. */
	content: string | null;
	lines: string[];
}

/** An edit or write call from the moment the model starts writing it until the panel shows what it did. */
interface LiveEdit {
	id: string;
	tool: "edit" | "write";
	/** The arguments as streamed so far, JSON that may stop anywhere; parsed when the panel draws. */
	json: string;
	args: Record<string, unknown>;
	parsed: boolean;
	streaming: boolean;
	running: boolean;
	/** When the call ended; the first refresh started after that shows its result and drops the preview. */
	doneAt?: number;
	/** Order of the calls as the model wrote them. */
	seq: number;
	file?: LiveFile;
}

interface PreviewLine {
	kind: " " | "-" | "+" | "@" | "…";
	text: string;
	cursor?: boolean;
}

/** The last edit or write, which the panel follows and marks. */
interface Recent {
	abs: string;
	/** Line of the new file where the change starts. */
	line?: number;
	/** Order of the call; of calls that run side by side, the panel follows the one the model wrote last. */
	seq: number;
}

interface HunkRow {
	row: number;
	start: number;
	count: number;
}

// --- git -----------------------------------------------------------------------------------------------------------

function git(cwd: string, args: string[], options: { ok?: number[]; input?: string } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			["-c", "core.quotepath=off", ...args],
			{ cwd, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
			(error, stdout) => {
				const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? -1 : 0;
				if (!error || (options.ok ?? []).includes(code)) resolve(stdout);
				else reject(error);
			},
		);
		child.stdin?.on("error", () => {});
		child.stdin?.end(options.input ?? "");
	});
}

async function repoOf(cwd: string): Promise<Repo | undefined> {
	try {
		const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
		let head = "HEAD";
		try {
			await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
		} catch {
			head = EMPTY_TREE;
		}
		return { root, head };
	} catch {
		return undefined;
	}
}

function countLines(text: string): number {
	return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function isBinary(file: string): boolean {
	try {
		return readFileSync(file).subarray(0, 8000).includes(0);
	} catch {
		return false;
	}
}

/** Files that differ between `ref` and the working tree, untracked files included. */
async function changesAgainst(repo: Repo, ref: string): Promise<FileChange[]> {
	const files: FileChange[] = [];
	for (const line of (await git(repo.root, ["diff", "--numstat", "--no-renames", ref])).split("\n")) {
		const match = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
		if (match) files.push({ path: match[3], added: Number(match[1]) || 0, removed: Number(match[2]) || 0, binary: match[1] === "-", group: "main" });
	}
	for (const file of (await git(repo.root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)) {
		const abs = path.join(repo.root, file);
		let added = 0;
		let binary = false;
		try {
			if (statSync(abs).size <= MAX_FILE_BYTES) {
				binary = isBinary(abs);
				if (!binary) added = countLines(readFileSync(abs, "utf8"));
			}
		} catch {
			// unreadable
		}
		files.push({ path: file, added, removed: 0, untracked: true, binary, group: "main" });
	}
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function mergeBase(repo: Repo): Promise<{ ref: string; name: string } | undefined> {
	if (repo.head !== "HEAD") return undefined;
	let name: string | undefined;
	try {
		name = (await git(repo.root, ["rev-parse", "--abbrev-ref", "origin/HEAD"])).trim();
	} catch {
		for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
			try {
				await git(repo.root, ["rev-parse", "--verify", "--quiet", candidate]);
				name = candidate;
				break;
			} catch {
				// next
			}
		}
	}
	if (!name) return undefined;
	try {
		return { ref: (await git(repo.root, ["merge-base", "HEAD", name])).trim(), name };
	} catch {
		return undefined;
	}
}

/** Object hashes of the files that exist, without writing them into the repository. */
async function hashFiles(root: string, paths: string[]): Promise<Map<string, string>> {
	const existing = paths.filter((p) => {
		try {
			return statSync(path.join(root, p)).isFile();
		} catch {
			return false;
		}
	});
	const hashes = new Map<string, string>();
	if (existing.length === 0) return hashes;
	const out = (await git(root, ["hash-object", "--stdin-paths"], { input: `${existing.join("\n")}\n` })).trim().split("\n");
	existing.forEach((p, i) => {
		if (out[i]) hashes.set(p, out[i].trim());
	});
	return hashes;
}

/** What was already changed when the session started, with a copy of each such file, so later diffs can start there. */
async function takeBaseline(repo: Repo): Promise<Baseline> {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-diff-base-"));
	const files = new Map<string, { hash: string | null; copy: string | null }>();
	const dirty = await changesAgainst(repo, repo.head);
	const hashes = await hashFiles(repo.root, dirty.map((f) => f.path));
	let total = 0;
	dirty.forEach((f, i) => {
		const hash = hashes.get(f.path) ?? null;
		let copy: string | null = null;
		const abs = path.join(repo.root, f.path);
		try {
			const size = hash ? statSync(abs).size : 0;
			if (hash && size <= MAX_BASELINE_FILE && total + size <= MAX_BASELINE_TOTAL) {
				copy = path.join(dir, String(i));
				writeFileSync(copy, readFileSync(abs), { mode: 0o600 });
				total += size;
			}
		} catch {
			copy = null;
		}
		files.set(f.path, { hash, copy });
	});
	return { root: repo.root, dir, files };
}

async function sessionChanges(repo: Repo, baseline: Baseline): Promise<FileChange[]> {
	const current = await changesAgainst(repo, repo.head);
	const known = current.filter((f) => baseline.files.has(f.path)).map((f) => f.path);
	const hashes = await hashFiles(repo.root, known);
	const out: FileChange[] = [];
	for (const f of current) {
		const start = baseline.files.get(f.path);
		if (!start) {
			out.push(f);
			continue;
		}
		const now = hashes.get(f.path) ?? null;
		if (now === start.hash) {
			out.push({ ...f, group: "before" });
			continue;
		}
		if (!start.copy) {
			out.push(f);
			continue;
		}
		const target = now ? f.path : "/dev/null";
		const stat = (await git(repo.root, ["diff", "--no-index", "--numstat", "--", start.copy, target], { ok: [0, 1] })).trim();
		const match = stat.match(/^(-|\d+)\t(-|\d+)\t/);
		out.push({ ...f, added: Number(match?.[1]) || 0, removed: Number(match?.[2]) || 0, startCopy: start.copy, untracked: false });
	}
	return out;
}

async function loadPatch(view: View, file: FileChange): Promise<string> {
	if (file.patch !== undefined) return file.patch;
	if (file.binary) return "(binary file)";
	if (!view.root || !view.ref) return "";
	const root = view.root;
	if (file.startCopy) {
		const target = existsSync(path.join(root, file.path)) ? file.path : "/dev/null";
		return git(root, ["diff", "--no-color", "--no-index", "--", file.startCopy, target], { ok: [0, 1] });
	}
	if (file.untracked) return git(root, ["diff", "--no-color", "--no-index", "--", "/dev/null", file.path], { ok: [0, 1] });
	return git(root, ["diff", "--no-color", "--no-renames", view.ref, "--", file.path]);
}

/** The hunks of a patch, without its file header lines. */
function hunks(patch: string): string[] {
	const lines = patch.replace(/\n$/, "").split("\n");
	const start = lines.findIndex((l) => l.startsWith("@@"));
	return start >= 0 ? lines.slice(start) : lines.filter((l) => l.trim());
}

// --- Views ---------------------------------------------------------------------------------------------------------

const TEST_FILE = [/(^|\/)(tests?|__tests__|specs?)\//i, /\.(test|spec)\.[^/]+$/i, /(^|\/)test_[^/]*\.py$/i, /_test\.(go|py|rb)$/i, /Test\.php$/];
const GENERATED_FILE = [
	/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum|bun\.lockb?|patches\.lock\.json)$/,
	/\.min\.(js|css)$/,
	/\.map$/,
	/(^|\/)(dist|build|generated|__generated__)\//,
];

function classify(file: string): Group {
	return TEST_FILE.some((re) => re.test(file)) || GENERATED_FILE.some((re) => re.test(file)) ? "aux" : "main";
}

async function currentView(cwd: string, base: Base, baseline: Baseline | undefined): Promise<View> {
	const repo = await repoOf(cwd);
	if (!repo) return { label: "Current", title: "not a git repository", files: [], current: true };
	let files: FileChange[];
	let title: string;
	let ref = repo.head;
	if (base === "branch" && (await mergeBase(repo))) {
		const split = (await mergeBase(repo))!;
		ref = split.ref;
		files = await changesAgainst(repo, ref);
		title = `everything since the branch split from ${split.name}`;
	} else if (base === "session" && baseline?.root === repo.root) {
		files = await sessionChanges(repo, baseline);
		title = "changes made in this session";
	} else {
		files = await changesAgainst(repo, repo.head);
		title = repo.head === "HEAD" ? "uncommitted changes against HEAD" : "everything (no commit yet)";
	}
	for (const f of files) if (f.group !== "before") f.group = classify(f.path);
	return { label: "Current", title, files, current: true, root: repo.root, ref };
}

/** One view per user prompt whose run edited or wrote files, from the session branch. */
function turnViews(branch: SessionEntry[], cwd: string, writes: Map<string, string>): View[] {
	const views: View[] = [];
	let prompt = "";
	let byFile = new Map<string, string[]>();
	const args = new Map<string, Record<string, unknown>>();
	const flush = () => {
		if (byFile.size === 0) return;
		const files = [...byFile.entries()].map(([file, patches]): FileChange => {
			const patch = patches.join("\n");
			let added = 0;
			let removed = 0;
			for (const line of patch.split("\n")) {
				if (line.startsWith("+") && !line.startsWith("+++")) added++;
				else if (line.startsWith("-") && !line.startsWith("---")) removed++;
			}
			return { path: file, patch, added, removed, group: classify(file) };
		});
		files.sort((a, b) => a.path.localeCompare(b.path));
		const n = views.length + 1;
		views.push({ label: `T${n}`, title: `turn ${n}: ${prompt.replace(/\s+/g, " ").slice(0, 80)}`, files, current: false });
		byFile = new Map();
	};
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as {
			role: string;
			content: unknown;
			toolCallId?: string;
			toolName?: string;
			isError?: boolean;
			details?: { patch?: string };
		};
		if (message.role === "user") {
			flush();
			prompt =
				typeof message.content === "string"
					? message.content
					: (message.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join(" ");
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content as Array<{ type: string; id?: string; arguments?: Record<string, unknown> }>) {
				if (part.type === "toolCall" && part.id) args.set(part.id, part.arguments ?? {});
			}
		} else if (message.role === "toolResult" && !message.isError && (message.toolName === "edit" || message.toolName === "write")) {
			const input = args.get(message.toolCallId ?? "") ?? {};
			const raw = typeof input.path === "string" ? input.path : "";
			if (!raw) continue;
			const abs = resolvePath(cwd, raw);
			const shown = path.relative(cwd, abs).startsWith("..") ? abs.replace(os.homedir(), "~") : path.relative(cwd, abs);
			let patch = message.toolName === "edit" ? message.details?.patch : writes.get(message.toolCallId ?? "");
			if (!patch && message.toolName === "write" && typeof input.content === "string") {
				patch = `@@ written in full (no earlier version recorded) @@\n${input.content.split("\n").map((l) => `+${l}`).join("\n")}`;
			}
			if (patch) byFile.set(shown, [...(byFile.get(shown) ?? []), patch]);
		}
	}
	flush();
	return views;
}

// --- Live previews -------------------------------------------------------------------------------------------------

function resolvePath(cwd: string, raw: string): string {
	return path.resolve(cwd, raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw);
}

/** The lines of `text`, without the empty one after a final newline. */
function splitLines(text: string): string[] {
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

/** The arguments of a live call as far as they have arrived, in the form of Pi's edit and write tools. */
function liveArgs(entry: LiveEdit): { path: string; edits: Array<{ oldText?: string; newText?: string }>; content?: string } {
	if (!entry.parsed) {
		entry.parsed = true;
		try {
			const parsed = parseStreamingJson<Record<string, unknown>>(entry.json);
			if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) entry.args = parsed;
		} catch {
			// keep the arguments that parsed last
		}
	}
	const args = entry.args;
	const text = (value: unknown) => (typeof value === "string" ? value : undefined);
	const one = (e: Record<string, unknown>) => ({ oldText: text(e.oldText ?? e.old_string), newText: text(e.newText ?? e.new_string) });
	const edits = Array.isArray(args.edits)
		? (args.edits as unknown[]).filter((e): e is Record<string, unknown> => !!e && typeof e === "object").map(one)
		: args.oldText !== undefined || args.old_string !== undefined
			? [one(args)]
			: [];
	return { path: text(args.path ?? args.file_path) ?? "", edits, content: text(args.content) };
}

/** The file a live call changes, read once per path, so that it shows the file as it was before the call. */
function liveFile(entry: LiveEdit, abs: string): LiveFile {
	if (entry.file?.abs === abs) return entry.file;
	let content: string | null = null;
	let exists = false;
	try {
		const stat = statSync(abs);
		exists = stat.isFile();
		if (exists && stat.size <= MAX_FILE_BYTES) content = readFileSync(abs, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
	} catch {
		// not there (yet): the path may still be arriving
	}
	entry.file = { abs, exists, content, lines: content === null ? [] : content.split("\n") };
	return entry.file;
}

/**
 * An edit call as a diff while its arguments arrive: each replacement with the whole lines it touches, what it keeps of
 * them as context, and two lines of the file around it. Its place is known once its oldText is found once in the file,
 * and from then on it shows the file's whole lines; until its newText arrives it shows what it removes.
 */
function editPreview(file: LiveFile, edits: Array<{ oldText?: string; newText?: string }>, streaming: boolean): PreviewLine[] {
	const out: PreviewLine[] = [];
	const content = file.content;
	edits.forEach((edit, i) => {
		const last = i === edits.length - 1;
		const oldText = edit.oldText ?? "";
		const hasNew = edit.newText !== undefined;
		const oldDone = hasNew || !last || !streaming;
		const newDone = hasNew && (!last || !streaming);
		if (!oldText && !hasNew) {
			out.push({ kind: "@", text: "@@ … @@" });
			return;
		}
		let at = content !== null && oldText ? content.indexOf(oldText) : -1;
		if (at >= 0 && content!.indexOf(oldText, at + 1) >= 0) at = -1;
		let prefix = "";
		let suffix = "";
		let startLine = 0;
		if (at >= 0 && content !== null) {
			const lineStart = at === 0 ? 0 : content.lastIndexOf("\n", at - 1) + 1;
			prefix = content.slice(lineStart, at);
			startLine = countNewlines(content, lineStart);
			if (!oldText.endsWith("\n")) {
				const oldEnd = at + oldText.length;
				const lineEnd = content.indexOf("\n", oldEnd);
				suffix = content.slice(oldEnd, lineEnd < 0 ? content.length : lineEnd);
			}
		}
		const oldLines = splitLines(prefix + oldText + suffix);
		const newText = prefix + (edit.newText ?? "") + (newDone ? suffix : "");
		const newLines = hasNew ? splitLines(newText) : [];
		const complete = newDone || newText.endsWith("\n") ? newLines.length : newLines.length - 1;
		const head = hasNew ? sharedHead(oldLines, newLines, complete) : 0;
		const tail = newDone ? sharedTail(oldLines, newLines, head) : 0;
		out.push({ kind: "@", text: at >= 0 ? `@@ line ${startLine + head + 1} @@` : oldDone ? "@@ not found in the file @@" : "@@ … @@" });
		const before = at >= 0 ? file.lines.slice(Math.max(0, startLine - LIVE_CONTEXT), startLine) : [];
		for (const text of [...before, ...oldLines.slice(0, head)].slice(-LIVE_CONTEXT)) out.push({ kind: " ", text });
		for (const text of oldLines.slice(head, oldLines.length - tail)) out.push({ kind: "-", text });
		for (const text of newLines.slice(head, newLines.length - tail)) out.push({ kind: "+", text });
		const end = out[out.length - 1];
		if (streaming && last && (end.kind === "+" || end.kind === "-")) out[out.length - 1] = { ...end, cursor: true };
		if (newDone) {
			const next = startLine + oldLines.length;
			const after = at >= 0 ? file.lines.slice(next, next + LIVE_CONTEXT) : [];
			for (const text of [...oldLines.slice(oldLines.length - tail), ...after].slice(0, LIVE_CONTEXT)) out.push({ kind: " ", text });
		}
	});
	return out;
}

/**
 * A write call as a diff while its content arrives: what it writes from the first line that differs from the file, and
 * once the content is complete, the lines it replaces too.
 */
function writePreview(file: LiveFile, content: string | undefined, streaming: boolean): PreviewLine[] {
	if (content === undefined) return [{ kind: "@", text: "@@ … @@" }];
	const newLines = splitLines(content);
	const out: PreviewLine[] = [];
	if (file.content === null) {
		out.push({ kind: "@", text: file.exists ? "@@ too large to compare @@" : "@@ new file @@" });
		for (const text of newLines) out.push({ kind: "+", text });
	} else {
		const oldLines = splitLines(file.content);
		const complete = !streaming || content.endsWith("\n") ? newLines.length : newLines.length - 1;
		const head = sharedHead(oldLines, newLines, complete);
		const tail = streaming ? 0 : sharedTail(oldLines, newLines, head);
		if (!streaming && head === oldLines.length && head === newLines.length) return [{ kind: "@", text: "@@ no changes @@" }];
		out.push({ kind: "@", text: `@@ line ${head + 1} @@` });
		for (const text of oldLines.slice(Math.max(0, head - LIVE_CONTEXT), head)) out.push({ kind: " ", text });
		if (!streaming) for (const text of oldLines.slice(head, oldLines.length - tail)) out.push({ kind: "-", text });
		for (const text of newLines.slice(head, newLines.length - tail)) out.push({ kind: "+", text });
		if (!streaming) for (const text of oldLines.slice(oldLines.length - tail, oldLines.length - tail + LIVE_CONTEXT)) out.push({ kind: " ", text });
	}
	const end = out[out.length - 1];
	if (streaming && end.kind === "+") out[out.length - 1] = { ...end, cursor: true };
	return out;
}

/** The line of the new file where `patch` changes first. */
function firstChanged(patch: string): number | undefined {
	let line: number | undefined;
	for (const text of patch.split("\n")) {
		const head = text.match(HUNK_HEADER);
		if (head) line = Number(head[1]);
		else if (line === undefined) continue;
		else if (text.startsWith("+") || text.startsWith("-")) return line;
		else if (!text.startsWith("\\")) line++;
	}
	return undefined;
}

/** The hunk that covers `line` of the new file, else the nearest one; without a line, the first. */
function hunkAt<T extends { start: number; count: number }>(list: T[], line: number | undefined): T | undefined {
	if (line === undefined || list.length === 0) return list[0];
	return (
		list.find((h) => line >= h.start && line <= h.start + Math.max(h.count, 1)) ??
		list.reduce((a, b) => (Math.abs(b.start - line) < Math.abs(a.start - line) ? b : a))
	);
}

// --- Rendering helpers ----------------------------------------------------------------------------------------------

function colorLine(theme: Theme, line: string): string {
	const text = line.replace(/\t/g, "    ");
	if (text.startsWith("@@")) return theme.fg("accent", text);
	if (text.startsWith("+")) return theme.fg("toolDiffAdded", text);
	if (text.startsWith("-")) return theme.fg("toolDiffRemoved", text);
	if (text.startsWith("\\")) return theme.fg("dim", text);
	return theme.fg("toolDiffContext", text);
}

function stats(theme: Theme, f: FileChange): string {
	return `${theme.fg("toolDiffAdded", `+${f.added}`)} ${theme.fg("toolDiffRemoved", `-${f.removed}`)}`;
}

/** `left` and `right` on one line of `width` columns, `left` cut to make room. */
function spread(left: string, right: string, width: number): string {
	const room = Math.max(1, width - visibleWidth(right) - 1);
	const cut = truncateToWidth(left, room, "…");
	return `${cut}${" ".repeat(Math.max(1, width - visibleWidth(cut) - visibleWidth(right)))}${right}`;
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

// --- Extension -----------------------------------------------------------------------------------------------------

interface Zone {
	from: number;
	to: number;
	action: () => void;
}

interface Row {
	text: string;
	zones: Zone[];
}

/**
 * Framed, scrollable boxes for the extensions that show more than a notification can hold: overlays for /agents,
 * /cron, and /memory, and the frame and scrolling of the boxes /btw and the /diff dialog show above the prompt.
 *
 * background-agents.ts, btw.ts, claude-remote-control.ts, memory.ts, scheduled-tasks.ts, subagents.ts carry a copy of
 * this block, or of a part of it: change them alike.
 */
/** Draws a rounded frame around `body`, with `title` in the top edge and `help` under it. */
function frame(theme: Theme, width: number, title: string, body: string[], help: string): string[] {
	const inner = Math.max(1, width - 4);
	const border = (s: string) => theme.fg("border", s);
	const head = truncateToWidth(` ${title} `, Math.max(1, width - 4), "…");
	const lines = [border("╭─") + theme.fg("accent", head) + border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(head)))}╮`)];
	for (const line of body) lines.push(`${border("│")} ${truncateToWidth(line, inner, "…", true)} ${border("│")}`);
	lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
	lines.push(truncateToWidth(theme.fg("dim", ` ${help}`), width));
	return lines;
}

/** Moves `offset` for the scroll keys; returns the new offset, or undefined when `data` is no scroll key. */
function scrollKey(data: string, offset: number, total: number, rows: number): number | undefined {
	const max = Math.max(0, total - rows);
	if (matchesKey(data, Key.up) || data === "k") return Math.max(0, offset - 1);
	if (matchesKey(data, Key.down) || data === "j") return Math.min(max, offset + 1);
	if (matchesKey(data, Key.pageUp)) return Math.max(0, offset - rows);
	if (matchesKey(data, Key.pageDown) || data === " ") return Math.min(max, offset + rows);
	if (matchesKey(data, Key.home) || data === "g") return 0;
	if (matchesKey(data, Key.end) || data === "G") return max;
	return undefined;
}

/** The visible slice of `lines`, padded to `rows` so the frame keeps its height while scrolling. */
function viewport(lines: string[], offset: number, rows: number): string[] {
	const visible = lines.slice(offset, offset + rows);
	return lines.length > rows ? [...visible, ...Array(Math.max(0, rows - visible.length)).fill("")] : visible;
}

/**
 * The panel's scroll view. It reports when the user scrolls it (wheel, scrollbar, keys), which pauses following, and
 * scrolls for the panel with jump(): the target is computed once the body is drawn and the layout knows its new height,
 * so a jump to lines that have just appeared is not cut to the old height.
 */
class PanelScroll extends ScrollView {
	onUserScroll: () => void = () => {};
	private jumpTarget: (() => number) | undefined;
	private jumping = false;

	jump(target: () => number): void {
		this.jumpTarget = target;
	}

	get jumpPending(): boolean {
		return this.jumpTarget !== undefined;
	}

	override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		const target = this.jumpTarget;
		if (!target) return;
		this.jumpTarget = undefined;
		this.jumping = true;
		try {
			super.scrollTo(target(), { disableFollow: true });
		} finally {
			this.jumping = false;
		}
	}

	override scrollTo(scrollTop: number, options?: { disableFollow?: boolean }): void {
		if (!this.jumping) this.onUserScroll();
		super.scrollTo(scrollTop, options);
	}

	override scrollBy(lines: number): number {
		const rest = super.scrollBy(lines);
		if (rest !== lines) this.onUserScroll();
		return rest;
	}
}

export default function (pi: ExtensionAPI) {
	if (Number(process.env.PI_SUBAGENT_DEPTH || 0) > 0) return;

	/** Patches of write calls made in this process, by tool call id; Pi records none for write. */
	const writes = new Map<string, string>();
	const before = new Map<string, { abs: string; old: string | null }>();
	let prefs = readPrefs();
	let tuiRef: TUI | undefined;
	let ctxRef: ExtensionContext | undefined;
	let baseline: Baseline | undefined;
	let baselineRun: Promise<void> | undefined;
	let autoTried = false;
	let asked: { path: string; text: string } | null = null;
	let panel: ReturnType<typeof createPanel> | null = null;
	/** edit and write calls from the moment the model starts writing them until the panel shows what they did. */
	const live = new Map<string, LiveEdit>();
	let liveSeq = 0;
	let recent: Recent | undefined;
	let followOn = prefs.follow !== false;

	const baseFor = (root: string | undefined): Base => (root && prefs.bases?.[root]) || "session";

	function setBase(root: string | undefined, base: Base): void {
		if (!root) return;
		prefs = { ...prefs, bases: { ...(prefs.bases ?? {}), [root]: base } };
		writePrefs(prefs);
	}

	async function loadViews(ctx: ExtensionContext, base: Base): Promise<View[]> {
		if (baselineRun) await baselineRun.catch(() => {});
		const current = await currentView(ctx.cwd, base, baseline);
		return [current, ...turnViews(ctx.sessionManager.getBranch(), ctx.cwd, writes)];
	}

	function askText(file: FileChange): string {
		const body = hunks(file.patch ?? "").join("\n");
		return `Changes in ${file.path}:\n\`\`\`diff\n--- a/${file.path}\n+++ b/${file.path}\n${body}\n\`\`\``;
	}

	function ask(file: FileChange): void {
		if (file.patch === undefined) return;
		asked = { path: file.path, text: askText(file) };
		if (ctxRef?.hasUI) ctxRef.ui.setStatus("diff-ask", `◆ diff of ${file.path} goes with your next prompt`);
	}

	pi.on("input", (event) => {
		recent = undefined;
		panel?.resume();
		if (!asked || event.source === "extension") return { action: "continue" };
		const text = `${event.text}\n\n${asked.text}`;
		asked = null;
		ctxRef?.ui.setStatus("diff-ask", undefined);
		panel?.invalidate();
		return { action: "transform", text };
	});

	// --- Panel -----------------------------------------------------------------------------------------------------

	function createPanel(ctx: ExtensionContext, tui: TUI, original: Component, transcript: Component, dock: Component) {
		const theme = () => ctx.ui.theme;
		let views: View[] = [];
		let viewIndex = 0;
		let base: Base = "session";
		let selected = 0;
		let listOffset = 0;
		let focused = false;
		let previousFocus: Component | null = null;
		let refreshing = false;
		let dirty = false;
		let timer: NodeJS.Timeout | null = null;
		let error: string | undefined;
		const expanded = new Set<Group>();
		let rows: Row[] = [];
		let bodyLines: string[] = [];
		let bodyZones = new Map<number, Zone>();
		let starts: number[] = [];
		let bodyKey = "";
		let hunkRows: HunkRow[][] = [];
		let liveCount = 0;
		let liveTimer: NodeJS.Timeout | null = null;
		let paused = false;
		let pendingJump: Recent | undefined;
		const following = () => followOn && !paused;

		const view = (): View | undefined => views[Math.min(viewIndex, views.length - 1)];
		/** Whether `f` of view `v` is the file of `r`; turn views list paths relative to the working directory. */
		const isFile = (f: FileChange, r: Recent, v: View | undefined) => path.resolve(v?.root ?? ctx.cwd, f.path) === r.abs;
		const listed = (): FileChange[] => {
			const files = view()?.files ?? [];
			return [
				...files.filter((f) => f.group === "main"),
				...(expanded.has("aux") ? files.filter((f) => f.group === "aux") : []),
				...(expanded.has("before") ? files.filter((f) => f.group === "before") : []),
			];
		};
		const render = () => {
			bodyKey = "";
			tui.requestRender();
		};
		const listRows = () => Math.max(3, Math.floor(tui.terminal.rows * 0.3));

		async function refresh(): Promise<void> {
			if (refreshing) {
				dirty = true;
				return;
			}
			refreshing = true;
			let loadStart = 0;
			try {
				do {
					dirty = false;
					loadStart = Date.now();
					const label = view()?.label;
					const next = await loadViews(ctx, base);
					let target = next.find((v) => v.label === label) ?? next[0];
					const jump = pendingJump;
					if (jump && following()) {
						// Follow into Current when the shown turn view does not have the file, and unfold its group.
						if (!target.files.some((f) => isFile(f, jump, target)) && next[0].files.some((f) => isFile(f, jump, next[0]))) target = next[0];
						const group = target.files.find((f) => isFile(f, jump, target))?.group;
						if (group && group !== "main") expanded.add(group);
					}
					const files = target.files;
					const show = [
						...files.filter((f) => f.group === "main"),
						...(expanded.has("aux") ? files.filter((f) => f.group === "aux") : []),
						...(expanded.has("before") ? files.filter((f) => f.group === "before") : []),
					].slice(0, MAX_PANEL_FILES);
					await Promise.all(
						show.map(async (f) => {
							f.patch = await loadPatch(target, f).catch((e) => `(could not read the diff: ${e instanceof Error ? e.message : e})`);
						}),
					);
					if (panel === api) {
						views = next;
						viewIndex = Math.max(0, views.indexOf(target));
						selected = Math.min(selected, Math.max(0, listed().length - 1));
						error = undefined;
						if (jump && pendingJump === jump) {
							pendingJump = undefined;
							if (following()) followTo(jump);
						}
					}
				} while (dirty && panel === api);
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			} finally {
				refreshing = false;
				// A preview goes once a refresh that started after its call ended has the result.
				for (const [id, entry] of live) if (entry.doneAt !== undefined && entry.doneAt <= loadStart) live.delete(id);
				render();
			}
		}

		function schedule(delay = REFRESH_DELAY_MS): void {
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				void refresh();
			}, delay);
		}

		function select(index: number): void {
			const files = listed();
			if (files.length === 0) return;
			selected = Math.max(0, Math.min(files.length - 1, index));
			if (selected < listOffset) listOffset = selected;
			if (selected >= listOffset + listRows()) listOffset = selected - listRows() + 1;
			userMoved();
			scroll.jump(() => liveCount + (starts[selected] ?? 0));
			render();
		}

		function cycleView(step: number): void {
			if (views.length < 2) return;
			viewIndex = (viewIndex + step + views.length) % views.length;
			selected = 0;
			listOffset = 0;
			scroll.jump(() => 0);
			const target = view();
			if (target && !target.current) {
				render();
				return;
			}
			void refresh();
		}

		function cycleBase(): void {
			base = BASES[(BASES.indexOf(base) + 1) % BASES.length];
			setBase(view()?.root, base);
			viewIndex = 0;
			selected = 0;
			listOffset = 0;
			scroll.jump(() => 0);
			void refresh();
		}

		function toggle(group: Group): void {
			if (expanded.has(group)) expanded.delete(group);
			else expanded.add(group);
			void refresh();
		}

		/** The user scrolled or picked a file: following waits for the next prompt. */
		function userMoved(): void {
			if (!following()) return;
			paused = true;
			tui.requestRender();
		}

		/** Paused: follow again. Following: switch it off. Off: switch it on. */
		function toggleFollow(): void {
			if (followOn && paused) paused = false;
			else {
				followOn = !followOn;
				paused = false;
				prefs = { ...readPrefs(), follow: followOn };
				writePrefs(prefs);
			}
			if (following() && live.size > 0) scroll.jump(() => 0);
			else if (following() && recent) followTo(recent);
			render();
		}

		/** Selects the file of `r` and scrolls to its hunk at `r.line`. */
		function followTo(r: Recent): void {
			const v = view();
			const i = listed().findIndex((f) => isFile(f, r, v));
			if (i < 0 || i >= MAX_PANEL_FILES) return;
			selected = i;
			const max = listRows();
			if (selected < listOffset || selected >= listOffset + max) listOffset = Math.max(0, selected - Math.floor(max / 2));
			scroll.jump(() => {
				const rows = hunkRows[i] ?? [];
				const hunk = hunkAt(rows, r.line);
				return liveCount + (hunk && hunk !== rows[0] ? hunk.row - 1 : (starts[i] ?? 0));
			});
			render();
		}

		/** The live calls, each with its file and the lines it removes and adds so far. */
		function renderLive(width: number): string[] {
			const t = theme();
			const bar = t.fg("accent", "┃");
			const root = view()?.root ?? views[0]?.root;
			const entries = [...live.values()];
			const room = Math.max(6, Math.floor(((scroll.viewportHeight || 24) * 0.8) / entries.length) - 2);
			const out: string[] = [];
			for (const entry of entries) {
				const args = liveArgs(entry);
				const abs = args.path ? resolvePath(ctx.cwd, args.path) : "";
				const rel = abs ? path.relative(root ?? ctx.cwd, abs) : "";
				const shown = !abs ? "…" : rel.startsWith("..") || path.isAbsolute(rel) ? abs.replace(os.homedir(), "~") : rel;
				const phase =
					entry.doneAt !== undefined
						? t.fg("success", "applied")
						: entry.streaming
							? t.fg("accent", "writing…")
							: entry.running
								? t.fg("muted", "applying…")
								: t.fg("muted", "queued");
				out.push(`${bar}${spread(` ${t.fg("accent", "✎")} ${t.bold(shown)}`, `${phase} `, width - 1)}`);
				const file = abs ? liveFile(entry, abs) : undefined;
				let preview = !file ? [] : entry.tool === "edit" ? editPreview(file, args.edits, entry.streaming) : writePreview(file, args.content, entry.streaming);
				if (preview.length > room) {
					// While it is written, the end is what changes; afterwards, the start.
					if (entry.streaming) {
						const first = preview[0].kind === "@" ? [preview[0]] : [];
						const keep = room - first.length - 1;
						preview = [...first, { kind: "…", text: `… ${preview.length - first.length - keep} lines` }, ...preview.slice(preview.length - keep)];
					} else preview = [...preview.slice(0, room - 1), { kind: "…", text: `… ${preview.length - room + 1} more lines` }];
				}
				for (const line of preview) {
					const text = line.kind === "@" || line.kind === "…" ? line.text : `${line.kind}${line.text}`;
					const colored = line.kind === "…" ? t.fg("dim", text) : colorLine(t, text);
					out.push(
						line.cursor
							? `${bar} ${truncateToWidth(colored, Math.max(1, width - 3), "…")}${t.fg("accent", "▍")}`
							: `${bar} ${truncateToWidth(colored, width - 2, "…")}`,
					);
				}
				out.push(t.fg("border", "│"));
			}
			return out;
		}

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
			render();
		}

		const header: Component = {
			render(width: number): string[] {
				const t = theme();
				const v = view();
				const out: Row[] = [];
				const border = t.fg("border", "│");
				const sourceText = views.length > 1 ? `source: ${v?.label ?? "Current"} ▾` : `${v?.label ?? "Current"}`;
				const baseText = v?.current !== false ? `base: ${BASE_LABEL[base]} ▾` : "";
				const title = `${border} ${t.bold(focused ? t.fg("accent", "Diff") : "Diff")}  `;
				const close = "✕ ";
				let x = visibleWidth(title);
				const zones: Zone[] = [{ from: x, to: x + visibleWidth(sourceText), action: () => cycleView(1) }];
				x += visibleWidth(sourceText) + 2;
				if (baseText) zones.push({ from: x, to: x + visibleWidth(baseText), action: cycleBase });
				zones.push({ from: width - visibleWidth(close), to: width, action: () => closePanel(true) });
				out.push({ text: spread(`${title}${t.fg("accent", sourceText)}  ${t.fg("muted", baseText)}`, t.fg("muted", close), width), zones });
				const followText = following() ? t.fg("accent", "● follow") : t.fg("muted", followOn ? "◌ follow paused" : "○ follow");
				out.push({
					text: `${border}${spread(` ${t.fg("dim", `${v?.title ?? "loading…"}${refreshing ? " · refreshing…" : ""}`)}`, `${followText} `, width - 1)}`,
					zones: [{ from: width - visibleWidth(followText) - 1, to: width, action: toggleFollow }],
				});
				if (error) out.push({ text: `${border} ${t.fg("error", truncateToWidth(error, width - 3, "…"))}`, zones: [] });

				const files = listed();
				const max = listRows();
				listOffset = Math.min(listOffset, Math.max(0, files.length - max));
				const editing = new Set(
					[...live.values()]
						.filter((e) => e.doneAt === undefined)
						.map((e) => liveArgs(e).path)
						.filter(Boolean)
						.map((p) => resolvePath(ctx.cwd, p)),
				);
				files.slice(listOffset, listOffset + max).forEach((f, k) => {
					const i = listOffset + k;
					const mark = focused && i === selected ? t.fg("accent", "› ") : recent && isFile(f, recent, v) ? t.fg("accent", "• ") : "  ";
					const tag =
						(editing.has(path.resolve(v?.root ?? ctx.cwd, f.path)) ? t.fg("accent", " editing…") : "") +
						(f.untracked ? t.fg("muted", " new") : f.group === "before" ? t.fg("muted", " earlier") : f.group === "aux" ? t.fg("muted", " test/gen") : "");
					const right = `${stats(t, f)}${asked?.path === f.path ? t.fg("success", " ✓") : ""}`;
					const name = focused && i === selected ? t.fg("accent", f.path) : f.path;
					out.push({ text: `${border}${spread(`${mark}${name}${tag}`, right, width - 2)} `, zones: [{ from: 0, to: width, action: () => select(i) }] });
				});
				if (files.length > max) out.push({ text: `${border} ${t.fg("dim", `↕ ${listOffset + 1}–${Math.min(files.length, listOffset + max)} of ${files.length} files`)}`, zones: [] });
				if (!v) out.push({ text: `${border} ${t.fg("muted", "Loading…")}`, zones: [] });
				else if (v.files.length === 0) out.push({ text: `${border} ${t.fg("muted", v.current ? "No changes." : "No edits in this turn.")}`, zones: [] });
				const all = v?.files ?? [];
				const aux = all.filter((f) => f.group === "aux").length;
				const earlier = all.filter((f) => f.group === "before").length;
				if (aux) out.push({ text: `${border} ${t.fg("muted", `${expanded.has("aux") ? "▾" : "▸"} ${aux} test and generated file${aux === 1 ? "" : "s"}`)}`, zones: [{ from: 0, to: width, action: () => toggle("aux") }] });
				if (earlier) out.push({ text: `${border} ${t.fg("muted", `${expanded.has("before") ? "▾" : "▸"} ${earlier} file${earlier === 1 ? "" : "s"} changed before this session`)}`, zones: [{ from: 0, to: width, action: () => toggle("before") }] });
				if (focused) out.push({ text: `${border} ${t.fg("dim", truncateToWidth("↑↓ file · PgUp/PgDn scroll · Tab source · b base · a ask · e unfold · f follow · r refresh · Esc back · x close", width - 3, "…"))}`, zones: [] });
				out.push({ text: `${border}${t.fg("border", "─".repeat(Math.max(0, width - 1)))}`, zones: [] });
				rows = out;
				return out.map((r) => truncateToWidth(r.text, width));
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (event.type === "wheel") {
					const files = listed();
					if (files.length <= listRows()) return undefined;
					listOffset = Math.max(0, Math.min(files.length - listRows(), listOffset + Math.sign(event.wheelDelta ?? 0)));
					return { handled: true };
				}
				if (event.type !== "click" || event.button !== "left") return event.type === "press" ? { handled: true } : undefined;
				const zone = rows[event.y]?.zones.find((z) => event.x >= z.from && event.x < z.to);
				zone?.action();
				return { handled: true };
			},
			handleInput(data: string): void {
				const files = listed();
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.alt("g"))) return focus(false);
				if (data === "x") return closePanel(true);
				if (matchesKey(data, Key.up)) return select(selected - 1);
				if (matchesKey(data, Key.down)) return select(selected + 1);
				if (matchesKey(data, Key.tab)) return cycleView(1);
				if (matchesKey(data, Key.shift("tab"))) return cycleView(-1);
				if (data === "b") return cycleBase();
				if (data === "r") return void refresh();
				if (data === "f") return toggleFollow();
				if (data === "e") {
					const all = view()?.files ?? [];
					const group: Group | undefined = all.some((f) => f.group === "aux") && !expanded.has("aux") ? "aux" : all.some((f) => f.group === "before") ? "before" : undefined;
					if (group) toggle(group);
					return;
				}
				if (data === "a" || matchesKey(data, Key.enter)) {
					const f = files[selected];
					if (f && data === "a") {
						ask(f);
						render();
					} else if (f) select(selected);
					return;
				}
				const height = scroll.viewportHeight || 10;
				const next = scrollKey(data, scroll.scrollTop, liveCount + bodyLines.length, height);
				if (next !== undefined) {
					scroll.scrollTo(next, { disableFollow: true });
					tui.requestRender();
				}
			},
			invalidate(): void {
				bodyKey = "";
			},
		};

		const body: Component = {
			render(width: number): string[] {
				const t = theme();
				const v = view();
				const key = `${width}:${viewIndex}:${views.length}:${asked?.path ?? ""}:${[...expanded].join(",")}:${recent ? `${recent.abs}:${recent.line}` : ""}`;
				if (key !== bodyKey) {
					bodyKey = key;
					const border = t.fg("border", "│");
					const bar = t.fg("accent", "┃");
					const lines: string[] = [];
					const zones = new Map<number, Zone>();
					starts = [];
					hunkRows = [];
					const files = listed().slice(0, MAX_PANEL_FILES);
					files.forEach((f, i) => {
						starts[i] = lines.length;
						const mine = recent !== undefined && isFile(f, recent, v);
						const askLabel = asked?.path === f.path ? "asked ✓" : "ask";
						const right = `${stats(t, f)}  ${asked?.path === f.path ? t.fg("success", askLabel) : t.fg("accent", askLabel)} `;
						zones.set(lines.length, { from: width - visibleWidth(askLabel) - 1, to: width, action: () => ask(f) });
						lines.push(`${border}${spread(` ${t.bold(mine ? t.fg("accent", f.path) : f.path)}`, right, width - 1)}`);
						const patch = f.patch === undefined ? ["(loading…)"] : hunks(f.patch);
						// The hunk of the last edit keeps an accent bar in the gutter.
						const heads = new Map<number, { start: number; count: number }>();
						patch.forEach((line, index) => {
							const m = line.match(HUNK_HEADER);
							if (m) heads.set(index, { start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) });
						});
						const marked = mine ? hunkAt([...heads.values()], recent!.line) : undefined;
						const rows: HunkRow[] = [];
						let current: { start: number; count: number } | undefined;
						patch.slice(0, MAX_PATCH_LINES).forEach((line, index) => {
							const head = heads.get(index);
							if (head) {
								current = head;
								rows.push({ row: lines.length, ...head });
							}
							lines.push(`${current && current === marked ? bar : border} ${truncateToWidth(colorLine(t, line), width - 2, "…")}`);
						});
						hunkRows[i] = rows;
						if (patch.length > MAX_PATCH_LINES) lines.push(`${border} ${t.fg("dim", `… ${patch.length - MAX_PATCH_LINES} more lines`)}`);
						lines.push(border);
					});
					if (listed().length > MAX_PANEL_FILES) lines.push(`${border} ${t.fg("dim", `… ${listed().length - MAX_PANEL_FILES} more files; /diff without the panel lists them all`)}`);
					bodyLines = lines;
					bodyZones = zones;
				}
				const liveLines = live.size > 0 ? renderLive(width) : [];
				// The live block grew or went: what is shown below it stays where it is.
				const shift = liveLines.length - liveCount;
				if (shift !== 0 && !scroll.jumpPending && scroll.scrollTop > 0 && scroll.scrollTop >= liveCount) {
					const top = scroll.scrollTop;
					scroll.jump(() => Math.max(0, top + shift));
				}
				liveCount = liveLines.length;
				const all = liveCount > 0 ? [...liveLines, ...bodyLines] : bodyLines;
				const fill = Math.max(0, (scroll.viewportHeight || 0) - all.length);
				return fill > 0 ? [...all, ...Array(fill).fill(t.fg("border", "│"))] : all;
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (event.type !== "click" || event.button !== "left") return undefined;
				const zone = bodyZones.get(event.y - liveCount);
				if (!zone || event.x < zone.from) return undefined;
				zone.action();
				render();
				return { handled: true };
			},
			invalidate(): void {
				bodyKey = "";
			},
		};

		const scroll = new PanelScroll(body, { scrollbar: "auto", overscroll: "contain" });
		scroll.onUserScroll = userMoved;
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

		const api = {
			root,
			original,
			schedule,
			refresh,
			focus: (on?: boolean) => focus(on ?? !focused),
			invalidate: render,
			setBase(value: Base) {
				base = value;
			},
			/** A live call changed; `started` when it is new, which brings the preview into view while following. */
			live(started: boolean) {
				if (started) {
					if (following()) scroll.jump(() => 0);
					tui.requestRender();
					return;
				}
				if (liveTimer) return;
				liveTimer = setTimeout(() => {
					liveTimer = null;
					if (panel === api) tui.requestRender();
				}, LIVE_FRAME_MS);
			},
			/** An edit or write has run: refresh, then show its hunk. */
			followEdit(r: Recent) {
				pendingJump = r;
				schedule(EDIT_REFRESH_DELAY_MS);
			},
			/** A new prompt: follow again and drop the mark of the last edit. */
			resume() {
				paused = false;
				render();
			},
			dispose() {
				if (timer) clearTimeout(timer);
				timer = null;
				if (liveTimer) clearTimeout(liveTimer);
				liveTimer = null;
				if (focused && previousFocus) tui.setFocus(previousFocus);
			},
		};
		return api;
	}

	/** Splits Pi's fullscreen layout into the conversation and the panel; false when that layout is not there. */
	function openPanel(ctx: ExtensionContext, focus = false): boolean {
		if (panel) return true;
		const tui = tuiRef;
		if (!tui || ctx.mode !== "tui" || !isViewportTUI(tui) || tui.terminal.columns < PANEL_MIN_COLUMNS) return false;
		const original = (tui as unknown as { layoutRoot?: Component }).layoutRoot;
		const entries = (original as unknown as { entries?: Array<{ component: Component }> } | undefined)?.entries;
		if (!original || !Array.isArray(entries) || entries.length !== 2 || !("scrollTop" in entries[0].component)) return false;
		const created = createPanel(ctx, tui, original, entries[0].component, entries[1].component);
		panel = created;
		void repoOf(ctx.cwd).then((repo) => {
			if (panel !== created) return;
			created.setBase(baseFor(repo?.root));
			void created.refresh();
		});
		tui.setLayoutRoot(created.root);
		if (focus) created.focus(true);
		return true;
	}

	function closePanel(byUser: boolean): void {
		const current = panel;
		if (!current) return;
		panel = null;
		current.dispose();
		const tui = tuiRef as unknown as { layoutRoot?: Component; setLayoutRoot?: (c: Component | undefined) => void } | undefined;
		if (tui?.layoutRoot === current.root) tui.setLayoutRoot?.(current.original);
		if (byUser) {
			prefs = { ...readPrefs(), panel: "closed" };
			writePrefs(prefs);
		}
	}

	// --- Dialog ----------------------------------------------------------------------------------------------------

	async function showDialog(ctx: ExtensionContext): Promise<void> {
		const repo = await repoOf(ctx.cwd);
		let base: Base = repo ? (prefs.bases?.[repo.root] ?? "head") : "head";
		let views = await loadViews(ctx, base);
		if (ctx.mode !== "tui") {
			const files = views[0].files;
			ctx.ui.notify(files.length ? files.map((f) => `${f.path} +${f.added} -${f.removed}`).join("\n") : "No changes.", "info");
			return;
		}
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			let viewIndex = 0;
			let selected = 0;
			let listOffset = 0;
			let mode: "list" | "file" = "list";
			let fileOffset = 0;
			let flash = "";
			const rowsFor = () => Math.max(4, Math.floor(tui.terminal.rows * 0.6) - 6);
			const view = () => views[Math.min(viewIndex, views.length - 1)];
			const files = () => view().files;
			const refresh = () => tui.requestRender();
			const ensurePatch = (f: FileChange | undefined) => {
				if (!f || f.patch !== undefined) return;
				loadPatch(view(), f)
					.then((p) => (f.patch = p || "(no textual changes)"))
					.catch((e) => (f.patch = `(could not read the diff: ${e instanceof Error ? e.message : e})`))
					.finally(refresh);
			};
			const reload = () => {
				flash = "Refreshing…";
				refresh();
				loadViews(ctx, base)
					.then((next) => {
						const label = view().label;
						views = next;
						viewIndex = Math.max(0, views.findIndex((v) => v.label === label));
						selected = Math.min(selected, Math.max(0, files().length - 1));
						flash = "";
						if (mode === "file") ensurePatch(files()[selected]);
					})
					.catch((e) => (flash = `Refresh failed: ${e instanceof Error ? e.message : e}`))
					.finally(refresh);
			};
			return {
				render(width: number): string[] {
					const inner = Math.max(1, width - 4);
					const rows = rowsFor();
					const bar = views
						.map((v, i) => (i === viewIndex ? theme.bg("selectedBg", theme.fg("text", ` ${v.label} `)) : theme.fg("muted", ` ${v.label} `)))
						.join("");
					const head = [bar, theme.fg("muted", truncateToWidth(view().current ? `${view().title} · base: ${BASE_LABEL[base]}` : view().title, inner, "…"))];
					if (mode === "list") {
						const list = files();
						const lines = list.length
							? list.map((f, i) => {
									const tag = f.untracked ? theme.fg("muted", " (new)") : f.group === "before" ? theme.fg("muted", " (before this session)") : "";
									const right = `${stats(theme, f)}${asked?.path === f.path ? theme.fg("success", " ✓") : ""}`;
									const text = spread(`${i === selected ? "> " : "  "}${f.path}${tag}`, right, inner);
									return i === selected ? theme.fg("accent", text) : text;
								})
							: [theme.fg("muted", view().current ? "No changes." : "No edits in this turn.")];
						const visible = Math.max(1, Math.min(rows, lines.length));
						if (selected < listOffset) listOffset = selected;
						if (selected >= listOffset + visible) listOffset = selected - visible + 1;
						const total = list.reduce((acc, f) => ({ a: acc.a + f.added, r: acc.r + f.removed }), { a: 0, r: 0 });
						const summary = list.length ? ` · ${list.length} file${list.length === 1 ? "" : "s"} +${total.a} -${total.r}` : "";
						return frame(theme, width, "/diff", [...head, "", ...viewport(lines, listOffset, visible)], flash || `↑↓ select · Enter diff · Tab source · b base · r refresh · Esc close${summary}`);
					}
					const f = files()[selected];
					const lines = f?.patch === undefined ? [theme.fg("muted", "Loading…")] : hunks(f.patch).map((l) => truncateToWidth(colorLine(theme, l), inner, "…"));
					const visible = Math.max(1, Math.min(rows, lines.length));
					fileOffset = Math.min(fileOffset, Math.max(0, lines.length - visible));
					const title = `${f?.path ?? ""}  ${f ? stats(theme, f) : ""}${f && asked?.path === f.path ? theme.fg("success", "  asked ✓") : ""}`;
					const more = lines.length > visible ? ` · ${fileOffset + 1}-${Math.min(lines.length, fileOffset + visible)}/${lines.length}` : "";
					return frame(theme, width, "/diff", [...head, title, ...viewport(lines, fileOffset, visible)], flash || `↑↓ PgUp PgDn scroll · n/p file · a ask · Esc back${more}`);
				},
				handleInput(data: string): void {
					flash = "";
					const list = files();
					if (mode === "file") {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) mode = "list";
						else if (data === "n" || data === "p") {
							if (!list.length) return;
							selected = (selected + (data === "n" ? 1 : list.length - 1)) % list.length;
							fileOffset = 0;
							ensurePatch(list[selected]);
						} else if (data === "a") {
							const f = list[selected];
							if (!f?.patch) return;
							ask(f);
							flash = "The diff goes with your next prompt";
						} else {
							const total = list[selected]?.patch ? hunks(list[selected].patch!).length : 0;
							const next = scrollKey(data, fileOffset, total, Math.min(rowsFor(), total));
							if (next === undefined) return;
							fileOffset = next;
						}
						refresh();
						return;
					}
					if (matchesKey(data, Key.escape) || data === "q") return done();
					if (matchesKey(data, Key.up)) selected = list.length ? (selected + list.length - 1) % list.length : 0;
					else if (matchesKey(data, Key.down)) selected = list.length ? (selected + 1) % list.length : 0;
					else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
						if (!list[selected]) return;
						mode = "file";
						fileOffset = 0;
						ensurePatch(list[selected]);
					} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
						viewIndex = (viewIndex + (matchesKey(data, Key.tab) ? 1 : views.length - 1)) % views.length;
						selected = 0;
						listOffset = 0;
					} else if (data === "b") {
						base = BASES[(BASES.indexOf(base) + 1) % BASES.length];
						setBase(view().root ?? repo?.root, base);
						viewIndex = 0;
						selected = 0;
						return reload();
					} else if (data === "r") return reload();
					else return;
					refresh();
				},
				invalidate(): void {},
			};
		});
	}

	// --- Events and command ------------------------------------------------------------------------------------------

	/** Opens the panel at the session's first edit, as far as the terminal and the preference allow. */
	async function autoOpen(ctx: ExtensionContext): Promise<void> {
		if (panel || autoTried || ctx.mode !== "tui" || !tuiRef) return;
		autoTried = true;
		const need = prefs.panel === "opened" ? PANEL_MIN_COLUMNS : AUTO_OPEN_COLUMNS;
		if (prefs.panel !== "closed" && tuiRef.terminal.columns >= need && (await repoOf(ctx.cwd)) && openPanel(ctx)) {
			// The check above narrowed panel to null; TypeScript does not see that openPanel() set it.
			(panel as ReturnType<typeof createPanel> | null)?.live(true);
		}
	}

	function liveChanged(ctx: ExtensionContext, started: boolean): void {
		if (panel) panel.live(started);
		else if (started) void autoOpen(ctx);
	}

	function followEdit(r: Recent): void {
		if (recent && recent.seq > r.seq) return;
		recent = r;
		panel?.followEdit(r);
	}

	/** The order of a call for following: when its arguments started to arrive, else now. */
	const seqOf = (toolCallId: string) => live.get(toolCallId)?.seq ?? ++liveSeq;

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		prefs = readPrefs();
		followOn = prefs.follow !== false;
		autoTried = false;
		if (ctx.mode === "tui") {
			ctx.ui.setWidget("diff-panel-probe", (tui) => {
				tuiRef = tui;
				return { render: () => [], invalidate() {} };
			});
			ctx.ui.setWidget("diff-panel-probe", undefined);
		}
		baselineRun = repoOf(ctx.cwd)
			.then(async (repo) => {
				if (repo) baseline = await takeBaseline(repo);
			})
			.catch(() => {});
	});

	pi.on("session_shutdown", () => {
		closePanel(false);
		before.clear();
		live.clear();
		recent = undefined;
		if (baseline) rmSync(baseline.dir, { recursive: true, force: true });
		baseline = undefined;
		ctxRef = undefined;
	});

	// The model writes a call: its arguments arrive piece by piece, the provider's partial JSON or Pi's deltas.
	pi.on("message_update", (event, ctx) => {
		const update = event.assistantMessageEvent as unknown as { type: string; contentIndex?: number; delta?: unknown; toolCall?: unknown };
		if (!update.type.startsWith("toolcall_")) return;
		const content = (event.message as { content?: unknown }).content;
		const block = (update.toolCall ?? (Array.isArray(content) ? content[update.contentIndex ?? -1] : undefined)) as
			| { type?: string; id?: string; name?: string; arguments?: Record<string, unknown>; partialJson?: unknown }
			| undefined;
		if (!block?.id || (block.name !== "edit" && block.name !== "write")) return;
		let entry = live.get(block.id);
		const started = !entry;
		if (!entry) {
			entry = { id: block.id, tool: block.name, json: "", args: {}, parsed: true, streaming: true, running: false, seq: ++liveSeq };
			live.set(block.id, entry);
		}
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
		liveChanged(ctx, started);
	});

	// A response that broke off leaves calls that will not run.
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; stopReason?: string };
		if (message.role !== "assistant" || (message.stopReason !== "aborted" && message.stopReason !== "error")) return;
		let changed = false;
		for (const [id, entry] of live) {
			if (!entry.streaming) continue;
			live.delete(id);
			changed = true;
		}
		if (changed) panel?.live(false);
	});

	// Also a call whose arguments did not stream (another provider, or a whole message) gets its preview here.
	pi.on("tool_execution_start", (event, ctx) => {
		if ((event.toolName !== "edit" && event.toolName !== "write") || event.parentToolCallId) return;
		let entry = live.get(event.toolCallId);
		const started = !entry;
		if (!entry) {
			entry = { id: event.toolCallId, tool: event.toolName, json: "", args: {}, parsed: true, streaming: false, running: true, seq: ++liveSeq };
			live.set(event.toolCallId, entry);
		}
		entry.streaming = false;
		entry.running = true;
		if (event.args && typeof event.args === "object") {
			entry.args = event.args as Record<string, unknown>;
			entry.parsed = true;
		}
		liveChanged(ctx, started);
	});

	pi.on("tool_execution_end", (event) => {
		const entry = live.get(event.toolCallId);
		if (!entry) return;
		if (event.isError || !panel) live.delete(event.toolCallId);
		else {
			entry.running = false;
			entry.doneAt = Date.now();
			panel.schedule(EDIT_REFRESH_DELAY_MS);
		}
		panel?.live(false);
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string") return;
		const abs = resolvePath(ctx.cwd, raw);
		// The file as it is before the call runs, for a preview not drawn yet.
		const entry = live.get(event.toolCallId);
		if (entry) {
			entry.args = event.input as Record<string, unknown>;
			entry.parsed = true;
			entry.streaming = false;
			liveFile(entry, abs);
		}
		if (event.toolName !== "write") return;
		let old: string | null = null;
		try {
			if (existsSync(abs) && statSync(abs).size <= MAX_FILE_BYTES) old = readFileSync(abs, "utf8");
		} catch {
			// unreadable: treated as new
		}
		before.set(event.toolCallId, { abs, old });
	});

	pi.on("tool_result", async (event, ctx) => {
		const edited = (event.toolName === "edit" || event.toolName === "write") && !event.isError;
		if (panel && (edited || event.toolName === "bash")) panel.schedule(edited ? EDIT_REFRESH_DELAY_MS : REFRESH_DELAY_MS);
		else if (edited) await autoOpen(ctx);
		const seq = edited ? seqOf(event.toolCallId) : 0;
		if (edited && event.toolName === "edit") {
			const raw = (event.input as { path?: unknown }).path;
			const line = (event.details as { firstChangedLine?: unknown } | undefined)?.firstChangedLine;
			if (typeof raw === "string") followEdit({ abs: resolvePath(ctx.cwd, raw), line: typeof line === "number" ? line : undefined, seq });
		}
		const prior = before.get(event.toolCallId);
		if (!prior) return;
		before.delete(event.toolCallId);
		if (event.isError) return;
		const shown = path.relative(ctx.cwd, prior.abs).startsWith("..") ? prior.abs.replace(os.homedir(), "~") : path.relative(ctx.cwd, prior.abs);
		const dir = mkdtempSync(path.join(os.tmpdir(), "pi-diff-"));
		let line: number | undefined;
		try {
			const oldFile = path.join(dir, "old");
			writeFileSync(oldFile, prior.old ?? "", { mode: 0o600 });
			const raw = await git(dir, ["diff", "--no-color", "--no-index", "--", prior.old === null ? "/dev/null" : oldFile, prior.abs], { ok: [0, 1] });
			const lines = raw.split("\n");
			const start = lines.findIndex((l) => l.startsWith("@@"));
			if (start >= 0) {
				const patch = [`--- ${prior.old === null ? "/dev/null" : shown}`, `+++ ${shown}`, ...lines.slice(start)].join("\n");
				writes.set(event.toolCallId, patch);
				line = firstChanged(patch);
			}
		} catch {
			// no git: the turn view falls back to the written content
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		followEdit({ abs: prior.abs, line, seq });
	});

	pi.on("agent_settled", () => {
		// Nothing runs any more: what is still written was never run.
		for (const [id, entry] of live) if (entry.doneAt === undefined) live.delete(id);
		panel?.schedule(100);
	});

	pi.registerShortcut("alt+g", {
		description: "Move the keyboard into the diff panel and back (opens it when closed)",
		handler: (ctx) => {
			if (panel) {
				panel.focus();
				return;
			}
			if (!openPanel(ctx, true)) ctx.ui.notify("The diff panel needs the fullscreen terminal, a git repository, and 110 columns; /diff opens the dialog.", "info");
		},
	});

	pi.registerCommand("diff", {
		description: "Toggle the diff panel beside the conversation (or open the diff dialog)",
		handler: async (_args, ctx) => {
			ctxRef = ctx;
			if (panel) {
				closePanel(true);
				return;
			}
			if (ctx.mode === "tui" && (await repoOf(ctx.cwd)) && openPanel(ctx)) {
				prefs = { ...readPrefs(), panel: "opened" };
				writePrefs(prefs);
				return;
			}
			await showDialog(ctx);
		},
	});
}
