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
 * - Keyboard: alt+g moves into the panel and back. There ↑↓ pick a file, PgUp/PgDn/Home/End scroll, Tab switches the
 *   source, b the base, a asks, e unfolds, r refreshes, Esc returns to the editor, x closes.
 * - It opens on its own at the session's first edit when the terminal has 144 columns, or 110 once you have opened it
 *   with /diff. Closed, it stays closed, in later sessions too, until /diff opens it again. /diff toggles it.
 * Dialog — otherwise: a bordered block above the prompt with the same views. ↑↓ select, Enter opens a diff, a asks,
 * Tab switches the source, b the base, r refreshes, Esc goes back and closes.
 *
 * Turn views come from the session's edit and write calls; changes made through bash appear only under Current. The
 * base is remembered per repository in ~/.pi/agent/diff-panel.json, and the dialog uses the panel's. The panel splits
 * Pi's fullscreen layout through tui.setLayoutRoot(); when that layout is not the one this was built against (Pi 1.4),
 * /diff opens the dialog instead.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
			const abs = path.resolve(cwd, raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw);
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
 * Framed, scrollable boxes for the extensions that show more than a notification can hold: overlays for /hooks,
 * /agents, /cron, and /memory, and the frame and scrolling of the boxes /btw and the /diff dialog show above the
 * prompt.
 *
 * background-agents.ts, btw.ts, claude-hooks.ts, claude-remote-control.ts, memory.ts, scheduled-tasks.ts, subagents.ts
 * carry a copy of this block, or of a part of it: change them alike.
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

		const view = (): View | undefined => views[Math.min(viewIndex, views.length - 1)];
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
			try {
				do {
					dirty = false;
					const label = view()?.label;
					const next = await loadViews(ctx, base);
					const files = (next.find((v) => v.label === label) ?? next[0]).files;
					const target = next.find((v) => v.label === label) ?? next[0];
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
					}
				} while (dirty && panel === api);
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			} finally {
				refreshing = false;
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
			body.render(lastBodyWidth);
			scroll.scrollTo(starts[selected] ?? 0, { disableFollow: true });
			render();
		}

		function cycleView(step: number): void {
			if (views.length < 2) return;
			viewIndex = (viewIndex + step + views.length) % views.length;
			selected = 0;
			listOffset = 0;
			scroll.scrollTo(0, { disableFollow: true });
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
			scroll.scrollTo(0, { disableFollow: true });
			void refresh();
		}

		function toggle(group: Group): void {
			if (expanded.has(group)) expanded.delete(group);
			else expanded.add(group);
			void refresh();
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
				out.push({ text: `${border} ${t.fg("dim", truncateToWidth(`${v?.title ?? "loading…"}${refreshing ? " · refreshing…" : ""}`, width - 3, "…"))}`, zones: [] });
				if (error) out.push({ text: `${border} ${t.fg("error", truncateToWidth(error, width - 3, "…"))}`, zones: [] });

				const files = listed();
				const max = listRows();
				listOffset = Math.min(listOffset, Math.max(0, files.length - max));
				files.slice(listOffset, listOffset + max).forEach((f, k) => {
					const i = listOffset + k;
					const mark = focused && i === selected ? t.fg("accent", "› ") : "  ";
					const tag = f.untracked ? t.fg("muted", " new") : f.group === "before" ? t.fg("muted", " earlier") : f.group === "aux" ? t.fg("muted", " test/gen") : "";
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
				if (focused) out.push({ text: `${border} ${t.fg("dim", truncateToWidth("↑↓ file · PgUp/PgDn scroll · Tab source · b base · a ask · e unfold · r refresh · Esc back · x close", width - 3, "…"))}`, zones: [] });
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
				const next = scrollKey(data, scroll.scrollTop, bodyLines.length, height);
				if (next !== undefined) {
					scroll.scrollTo(next, { disableFollow: true });
					tui.requestRender();
				}
			},
			invalidate(): void {
				bodyKey = "";
			},
		};

		let lastBodyWidth = 60;
		const body: Component = {
			render(width: number): string[] {
				lastBodyWidth = width;
				const t = theme();
				const key = `${width}:${viewIndex}:${views.length}:${asked?.path ?? ""}:${[...expanded].join(",")}`;
				if (key !== bodyKey) {
					bodyKey = key;
					const border = t.fg("border", "│");
					const lines: string[] = [];
					const zones = new Map<number, Zone>();
					starts = [];
					const files = listed().slice(0, MAX_PANEL_FILES);
					files.forEach((f, i) => {
						starts[i] = lines.length;
						const askLabel = asked?.path === f.path ? "asked ✓" : "ask";
						const right = `${stats(t, f)}  ${asked?.path === f.path ? t.fg("success", askLabel) : t.fg("accent", askLabel)} `;
						zones.set(lines.length, { from: width - visibleWidth(askLabel) - 1, to: width, action: () => ask(f) });
						lines.push(`${border}${spread(` ${t.bold(f.path)}`, right, width - 1)}`);
						const patch = f.patch === undefined ? ["(loading…)"] : hunks(f.patch);
						for (const line of patch.slice(0, MAX_PATCH_LINES)) lines.push(`${border} ${truncateToWidth(colorLine(t, line), width - 2, "…")}`);
						if (patch.length > MAX_PATCH_LINES) lines.push(`${border} ${t.fg("dim", `… ${patch.length - MAX_PATCH_LINES} more lines`)}`);
						lines.push(border);
					});
					if (listed().length > MAX_PANEL_FILES) lines.push(`${border} ${t.fg("dim", `… ${listed().length - MAX_PANEL_FILES} more files; /diff without the panel lists them all`)}`);
					bodyLines = lines;
					bodyZones = zones;
				}
				const fill = Math.max(0, (scroll.viewportHeight || 0) - bodyLines.length);
				return fill > 0 ? [...bodyLines, ...Array(fill).fill(t.fg("border", "│"))] : bodyLines;
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (event.type !== "click" || event.button !== "left") return undefined;
				const zone = bodyZones.get(event.y);
				if (!zone || event.x < zone.from) return undefined;
				zone.action();
				render();
				return { handled: true };
			},
			invalidate(): void {
				bodyKey = "";
			},
		};

		const scroll = new ScrollView(body, { scrollbar: "auto", overscroll: "contain" });
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
			dispose() {
				if (timer) clearTimeout(timer);
				timer = null;
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

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		prefs = readPrefs();
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
		if (baseline) rmSync(baseline.dir, { recursive: true, force: true });
		baseline = undefined;
		ctxRef = undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write") return;
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string") return;
		const abs = path.resolve(ctx.cwd, raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw);
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
		if (panel && (edited || event.toolName === "bash")) panel.schedule();
		else if (edited && !panel && !autoTried && ctx.mode === "tui" && tuiRef) {
			autoTried = true;
			const need = prefs.panel === "opened" ? PANEL_MIN_COLUMNS : AUTO_OPEN_COLUMNS;
			if (prefs.panel !== "closed" && tuiRef.terminal.columns >= need && (await repoOf(ctx.cwd))) openPanel(ctx);
		}
		const prior = before.get(event.toolCallId);
		if (!prior) return;
		before.delete(event.toolCallId);
		if (event.isError) return;
		const shown = path.relative(ctx.cwd, prior.abs).startsWith("..") ? prior.abs.replace(os.homedir(), "~") : path.relative(ctx.cwd, prior.abs);
		const dir = mkdtempSync(path.join(os.tmpdir(), "pi-diff-"));
		try {
			const oldFile = path.join(dir, "old");
			writeFileSync(oldFile, prior.old ?? "", { mode: 0o600 });
			const raw = await git(dir, ["diff", "--no-color", "--no-index", "--", prior.old === null ? "/dev/null" : oldFile, prior.abs], { ok: [0, 1] });
			const lines = raw.split("\n");
			const start = lines.findIndex((l) => l.startsWith("@@"));
			if (start >= 0) writes.set(event.toolCallId, [`--- ${prior.old === null ? "/dev/null" : shown}`, `+++ ${shown}`, ...lines.slice(start)].join("\n"));
		} catch {
			// no git: the turn view falls back to the written content
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	pi.on("agent_settled", () => {
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
