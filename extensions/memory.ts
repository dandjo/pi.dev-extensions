/**
 * Memory: a persistent memory per project, kept the way Claude Code keeps its auto memory, for any provider.
 *
 * - A project's memory is a folder with an index, MEMORY.md, holding one line per entry that links a topic file, and
 *   the topic files themselves (Markdown with frontmatter). The index goes into the system prompt on every run, read
 *   live; the model reads a topic file when it is relevant and writes, corrects, and removes entries with its file
 *   tools, following the rules that come with the index.
 * - Where it lives comes from the providers in ~/.pi/agent/memory.json, in order of priority: the first one available
 *   is used, the others are fallbacks. {"providers": {"claude": {}, "pi": {}}} is the default:
 *   - claude: Claude Code's auto memory, so both remember the same. Available while Claude Code is installed (its
 *     config directory exists) and its auto memory is on (no autoMemoryEnabled: false in its settings, no
 *     CLAUDE_CODE_DISABLE_AUTO_MEMORY). The folder follows Claude Code's rules: autoMemoryDirectory from its settings,
 *     else <config dir>/projects/<project>/memory, <project> being CLAUDE_CODE_PROJECT_DIR_NAME beside
 *     CLAUDE_CONFIG_DIR or the project key.
 *   - pi: ~/.pi/agent/memory/<project>, always available.
 *   - Any provider takes a "dir" with {project} for the key, and a provider of another name needs one.
 * - The project is the git repository (its main worktree, so worktrees share one memory), else the working directory;
 *   its key is the absolute path with every character but letters and digits replaced by "-", as Claude Code names
 *   it. Claude Code's project settings count only once Pi trusts the project.
 * - A project without a memory gets the folder and an empty index when the first entry is written there.
 * - /memory shows the providers and the index in use; /memory edit opens the index in Pi's editor.
 * - /memory lint checks the memory against its rules and the size it costs: index lines over 150 characters, an index
 *   over 200 lines, links to missing files, topic files without an index line or frontmatter, and topic files over
 *   8 KB, which cost that much every time they are read. A file the topic map of an indexed core file links ([[name]]
 *   or a Markdown link) counts as indexed: a subject split into several files needs one index line, not one per file.
 *   At start, a notice counts what it finds.
 * - The same limits hold when the model writes: a write or edit that would put an index line over 150 characters or
 *   the index over 200 lines, a topic file without frontmatter, or a topic file over 8 KB that grows further is
 *   refused, with what to do instead (shorten the line and keep the details in the topic file; split the file by
 *   subject). Edits that shrink a large file pass, so it can be tidied. {"guard": false} in memory.json turns the
 *   check off. Claude Code, writing to the same memory, is not checked.
 * - /memory tidy asks the model to fix what /memory lint lists, showing what it would remove before it removes it.
 * - /memory migrate [provider] copies this project's memory from another provider's folder into the one in use, as
 *   long as that has no entries yet: after a switch of provider (Claude Code uninstalled, its auto memory turned off,
 *   memory.json reordered) the entries come along. The source is the named provider, else the first one in order of
 *   priority whose folder has an index; Claude Code's and Pi's own folders count even when memory.json leaves them
 *   out. The source stays as it is, and a file of the same name in the target is not overwritten.
 * - Subagents (PI_SUBAGENT_DEPTH) get no memory, as in Claude Code.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	isToolCallEventType,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const INDEX = "MEMORY.md";
const MAX_INDEX_LINES = 200;
const MAX_LINE_CHARS = 150;
const MAX_TOPIC_BYTES = 8 * 1024;
const CONFIG_FILE = path.join(getAgentDir(), "memory.json");

/** How the model keeps the memory, in Claude Code's format so that both can read and write the same files. */
const RULES = [
	"How to keep this memory:",
	"- Save what a later session needs and cannot read from the code, the docs, or the git history: who the user is and how they work (type user); corrections and preferences they gave you (feedback); facts and decisions about the project and its surroundings, with the reason (project); where outside information lives (reference). Save at once when the user asks you to remember something, corrects you, or a non-obvious fact took effort to establish.",
	"- Do not save the steps of the current task, guesses, or what the repository already says, and never secrets, tokens, or other people's personal data.",
	"- One topic file per subject, named in kebab-case (deploy-needs-vpn.md), beginning with this frontmatter: `name` (the file name without .md), `description` (one line, specific enough to judge relevance), and `metadata` with `node_type: memory`, `type` (user, feedback, project, or reference), and `modified` (an ISO 8601 timestamp). Then the fact; feedback and project entries add **Why:** (the reason given) and **How to apply:** (when it matters).",
	"- Every topic file has one line in MEMORY.md: `- [Title](file.md) — what it says`, under 150 characters. A topic file stays under 8 KB: a subject that needs more gets a core file whose topic map links its other files ([[name]]), and only the core file has a line in MEMORY.md, ending in a topic map hint. The index holds no content of its own and stays under 200 lines; create it with the first entry if it is missing.",
	"- Before adding an entry, look for one on the same subject and update it instead, setting `modified`. Correct or delete an entry, with its index line, as soon as it turns out wrong or stale. Write dates as absolute dates.",
].join("\n");

function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

interface Provider {
	name: string;
	/** A folder with {project} for the project key; default the provider's own. */
	dir?: string;
}

const DEFAULT_PROVIDERS: Provider[] = [{ name: "claude" }, { name: "pi" }];

/** The providers in order of priority, and what is wrong with memory.json if it is; the defaults when it is. */
function loadProviders(): { providers: Provider[]; problem?: string } {
	let config: any;
	try {
		config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: DEFAULT_PROVIDERS };
		return { providers: DEFAULT_PROVIDERS, problem: `${CONFIG_FILE} is not valid JSON` };
	}
	const map = config?.providers;
	if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length === 0) {
		return { providers: DEFAULT_PROVIDERS, problem: `${CONFIG_FILE}: expected {"providers": {"claude": {}, "pi": {}}}` };
	}
	const providers: Provider[] = [];
	for (const [name, settings] of Object.entries(map)) {
		const dir = (settings as { dir?: unknown } | null)?.dir;
		if (dir !== undefined && (typeof dir !== "string" || !dir.trim())) {
			return { providers: DEFAULT_PROVIDERS, problem: `${CONFIG_FILE}: providers.${name}.dir must be a path` };
		}
		if (name !== "claude" && name !== "pi" && dir === undefined) {
			return { providers: DEFAULT_PROVIDERS, problem: `${CONFIG_FILE}: providers.${name} needs a dir` };
		}
		providers.push({ name, dir: dir as string | undefined });
	}
	return { providers };
}

/** Whether writes into the memory are checked against its limits ({"guard": false} in memory.json turns it off). */
function guardOn(): boolean {
	try {
		return JSON.parse(readFileSync(CONFIG_FILE, "utf8"))?.guard !== false;
	} catch {
		return true;
	}
}

/** Index lines (entries starting with "- [") over the limit, with their length. */
function longIndexLines(text: string): { chars: number; text: string }[] {
	return text
		.split("\n")
		.filter((l) => l.trimStart().startsWith("- ["))
		.map((l) => ({ chars: Array.from(l).length, text: l }))
		.filter((l) => l.chars > MAX_LINE_CHARS);
}

function hasFrontmatter(text: string): boolean {
	if (!text.startsWith("---")) return false;
	const end = text.indexOf("\n---", 3);
	const front = end > 0 ? text.slice(3, end) : "";
	return /^name:/m.test(front) && /^description:/m.test(front) && /^\s*type:/m.test(front);
}

/**
 * Why a write or edit into the memory breaks its limits, or undefined when it does not. `content` is the whole new
 * file for a write; `edits` the replacements of an edit.
 */
function guardProblem(file: string, content: string | undefined, edits: { oldText: string; newText: string }[]): string | undefined {
	const name = path.basename(file);
	if (name === INDEX) {
		const added = content ?? edits.map((e) => e.newText).join("\n");
		const long = longIndexLines(added);
		if (long.length) {
			const shown = long.slice(0, 3).map((l) => `${l.chars} characters: ${l.text.slice(0, 80)}…`).join("\n");
			return `Not written: ${long.length} index line${long.length > 1 ? "s" : ""} over ${MAX_LINE_CHARS} characters, which ${long.length > 1 ? "go" : "goes"} into every request:\n${shown}\nKeep the title and the one fact that decides whether the entry is relevant; the details belong in the topic file. Write it again with shorter lines.`;
		}
		if (content !== undefined) {
			const lines = content.split("\n").filter((l) => l.trim()).length;
			if (lines > MAX_INDEX_LINES) {
				return `Not written: the index would have ${lines} lines, and the prompt gets only the first ${MAX_INDEX_LINES}. Merge related entries or remove stale ones first.`;
			}
		}
		return undefined;
	}
	if (!name.endsWith(".md")) return undefined;
	if (content !== undefined && !hasFrontmatter(content)) {
		return "Not written: a topic file begins with frontmatter: name, description, and metadata with node_type: memory, type, and modified (see the memory rules in the system prompt).";
	}
	let before = 0;
	try {
		before = statSync(file).size;
	} catch {
		// a new file
	}
	const after =
		content !== undefined
			? Buffer.byteLength(content)
			: before + edits.reduce((n, e) => n + Buffer.byteLength(e.newText) - Buffer.byteLength(e.oldText), 0);
	if (after > MAX_TOPIC_BYTES && after > before) {
		return `Not written: ${name} would have ${(after / 1024).toFixed(1)} KB, over the ${MAX_TOPIC_BYTES / 1024} KB a topic file should stay under, since it costs its size each time it is read. Split it by subject: keep this file as the core with a topic map that links new topic files ([[name]], each with frontmatter), and drop what is stale (superseded statements, finished intermediate states, removed workarounds); then write the part that belongs here.`;
	}
	return undefined;
}

/** ~ expanded; {project} replaced with the key. */
function expand(dir: string, key: string): string {
	const withKey = dir.trim().replaceAll("{project}", key);
	if (withKey === "~" || withKey.startsWith("~/")) return path.join(os.homedir(), withKey.slice(1));
	return path.resolve(withKey);
}

const projectRoots = new Map<string, string>();

/** The project of a working directory as Claude Code takes it: the git repository's main worktree, else the directory. */
function projectRoot(cwd: string): string {
	const start = path.resolve(cwd);
	const known = projectRoots.get(start);
	if (known) return known;
	let root = start;
	try {
		const git = (args: string[]) =>
			execFileSync("git", args, { cwd: start, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		root = path.basename(common) === ".git" ? path.dirname(common) : git(["rev-parse", "--show-toplevel"]) || start;
	} catch {
		// not a git repository
	}
	projectRoots.set(start, root);
	return root;
}

/** Claude Code's settings that decide its auto memory: user, then project and local once Pi trusts the project. */
function claudeSettings(root: string, trusted: boolean): { autoMemoryEnabled?: unknown; autoMemoryDirectory?: unknown } {
	const files = [path.join(claudeDir(), "settings.json")];
	if (trusted) files.push(path.join(root, ".claude", "settings.json"), path.join(root, ".claude", "settings.local.json"));
	const merged: Record<string, unknown> = {};
	for (const file of files) {
		try {
			const settings = JSON.parse(readFileSync(file, "utf8"));
			for (const key of ["autoMemoryEnabled", "autoMemoryDirectory"]) if (settings?.[key] !== undefined) merged[key] = settings[key];
		} catch {
			// no such settings file
		}
	}
	return merged;
}

interface Resolved {
	provider: string;
	dir: string;
	/** Why the provider cannot be used; undefined when it can. */
	unavailable?: string;
}

function resolve(provider: Provider, root: string, key: string, trusted: boolean): Resolved {
	if (provider.name === "claude") {
		if (!existsSync(claudeDir())) return { provider: provider.name, dir: "", unavailable: "Claude Code is not installed" };
		const settings = claudeSettings(root, trusted);
		const disabled = /^(1|true|yes)$/i.test(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? "") || settings.autoMemoryEnabled === false;
		const name = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CODE_PROJECT_DIR_NAME ? process.env.CLAUDE_CODE_PROJECT_DIR_NAME : key;
		const dir = provider.dir
			? expand(provider.dir, key)
			: typeof settings.autoMemoryDirectory === "string" && settings.autoMemoryDirectory.trim()
				? expand(settings.autoMemoryDirectory, key)
				: path.join(claudeDir(), "projects", name, "memory");
		return { provider: provider.name, dir, unavailable: disabled ? "Claude Code's auto memory is off" : undefined };
	}
	if (provider.name === "pi" && !provider.dir) return { provider: provider.name, dir: path.join(getAgentDir(), "memory", key) };
	return { provider: provider.name, dir: expand(provider.dir ?? "", key) };
}

interface Memory {
	dir: string;
	exists: boolean;
	provider: string;
	/** Every provider in order, with its folder and why it is not used. */
	all: Resolved[];
}

/** The memory of a working directory: the folder of the first available provider. */
function memoryOf(cwd: string, trusted: boolean): Memory | undefined {
	const root = projectRoot(cwd);
	const key = root.replace(/[^a-zA-Z0-9]/g, "-");
	const all = loadProviders().providers.map((provider) => resolve(provider, root, key, trusted));
	const used = all.find((r) => !r.unavailable);
	if (!used) return undefined;
	return { dir: used.dir, exists: existsSync(path.join(used.dir, INDEX)), provider: used.provider, all };
}

function shortPath(file: string): string {
	const home = os.homedir();
	return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/** A tool's path argument as the file tools resolve it: ~ expanded, relative to the working directory. */
function toolPath(value: string, cwd: string): string {
	const trimmed = value.trim().replace(/^@/, "");
	if (trimmed === "~" || trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(1));
	return path.resolve(cwd, trimmed);
}

/**
 * Framed, scrollable boxes for the extensions that show more than a notification can hold: overlays for /hooks,
 * /agents, /cron, and /memory, and the frame and scrolling of the boxes /btw and the /diff dialog show above the
 * prompt.
 *
 * background-agents.ts, btw.ts, claude-code-hooks.ts, claude-remote-control.ts, diff.ts, scheduled-tasks.ts, subagents.ts
 * carry a copy of this block, or of a part of it: change them alike.
 */
const OVERLAY_OPTIONS = { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 } as const;

/** Rows the body of an overlay may use: the overlay's height cap minus the frame and help lines. */
function bodyRows(tui: TUI): number {
	return Math.max(3, Math.floor(tui.terminal.rows * 0.9) - 4);
}

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
 * Shows read-only text in a scrollable overlay until Esc, q, or Enter. `build` renders the body lines for a width;
 * longer lines are wrapped. Outside the interactive terminal the text goes out as a notification instead.
 */
async function showText(
	ctx: ExtensionContext,
	title: string,
	build: (width: number, theme: Theme) => string[],
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(build(100, ctx.ui.theme).join("\n"), "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let offset = 0;
			let cache: { width: number; lines: string[] } | undefined;
			const body = (width: number) => {
				if (!cache || cache.width !== width) {
					const inner = Math.max(1, width - 4);
					cache = { width, lines: build(inner, theme).flatMap((line) => (line ? wrapTextWithAnsi(line, inner) : [""])) };
				}
				return cache.lines;
			};
			return {
				render(width: number): string[] {
					const lines = body(width);
					const rows = Math.min(bodyRows(tui), Math.max(1, lines.length));
					offset = Math.min(offset, Math.max(0, lines.length - rows));
					const more = lines.length > rows ? `  ${offset + 1}–${Math.min(lines.length, offset + rows)}/${lines.length}` : "";
					return frame(theme, width, title, viewport(lines, offset, rows), `↑↓ PgUp PgDn scroll · Esc close${more}`);
				},
				handleInput(data: string): void {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
						done();
						return;
					}
					const lines = body(cache?.width ?? 80);
					const next = scrollKey(data, offset, lines.length, Math.min(bodyRows(tui), lines.length));
					if (next !== undefined && next !== offset) {
						offset = next;
						tui.requestRender();
					}
				},
				invalidate(): void {
					cache = undefined;
				},
			};
		},
		{ overlay: true, overlayOptions: OVERLAY_OPTIONS },
	);
}

interface Lint {
	indexBytes: number;
	indexLines: number;
	longLines: { line: number; chars: number; text: string }[];
	missing: string[];
	unindexed: string[];
	noFrontmatter: string[];
	large: { file: string; bytes: number }[];
}

/** Checks a memory folder against the rules that come with its index and the size it costs. */
function lint(dir: string): Lint {
	const result: Lint = { indexBytes: 0, indexLines: 0, longLines: [], missing: [], unindexed: [], noFrontmatter: [], large: [] };
	const indexFile = path.join(dir, INDEX);
	const index = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "";
	result.indexBytes = Buffer.byteLength(index);
	const lines = index.split("\n").filter((l) => l.trim());
	result.indexLines = lines.length;
	const linked = new Set<string>();
	lines.forEach((line, i) => {
		const chars = Array.from(line).length;
		if (chars > MAX_LINE_CHARS) result.longLines.push({ line: i + 1, chars, text: line });
		for (const m of line.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
			linked.add(m[1]);
			if (!existsSync(path.join(dir, m[1]))) result.missing.push(m[1]);
		}
	});
	// Files the topic maps of indexed files link count as indexed.
	for (const file of [...linked]) {
		let text = "";
		try {
			text = readFileSync(path.join(dir, file), "utf8");
		} catch {
			continue;
		}
		for (const m of text.matchAll(/\]\(([^)\s]+\.md)\)/g)) linked.add(m[1]);
		for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) linked.add(`${m[1].trim()}.md`);
	}
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== INDEX);
	} catch {
		// no folder yet
	}
	for (const file of files.sort()) {
		const full = path.join(dir, file);
		if (!linked.has(file)) result.unindexed.push(file);
		const bytes = statSync(full).size;
		if (bytes > MAX_TOPIC_BYTES) result.large.push({ file, bytes });
		const head = readFileSync(full, "utf8").slice(0, 2000);
		const front = head.startsWith("---") ? head.slice(3, head.indexOf("\n---", 3)) : "";
		if (!/^name:/m.test(front) || !/^description:/m.test(front) || !/^\s*type:/m.test(front)) result.noFrontmatter.push(file);
	}
	result.large.sort((a, b) => b.bytes - a.bytes);
	return result;
}

function lintSummary(l: Lint): string | undefined {
	const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
	const parts = [
		l.longLines.length && `${n(l.longLines.length, "index line")} over ${MAX_LINE_CHARS} characters`,
		l.indexLines > MAX_INDEX_LINES && `an index of ${l.indexLines} lines (cut at ${MAX_INDEX_LINES})`,
		l.missing.length && `${n(l.missing.length, "link")} to missing files`,
		l.unindexed.length && `${n(l.unindexed.length, "topic file")} not linked from the index`,
		l.noFrontmatter.length && `${n(l.noFrontmatter.length, "topic file")} without frontmatter`,
		l.large.length && `${n(l.large.length, "topic file")} over ${MAX_TOPIC_BYTES / 1024} KB`,
	].filter(Boolean);
	return parts.length ? parts.join(", ") : undefined;
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

function lintReport(l: Lint, theme: Theme): string[] {
	const head = theme.fg("muted", `${INDEX}: ${l.indexLines} lines, ${kb(l.indexBytes)}, about ${Math.round(l.indexBytes / 3.5 / 1000)}k tokens in every request`);
	const out = [head, ""];
	const section = (title: string, rows: string[]) => {
		if (rows.length) out.push(theme.fg("accent", title), ...rows.map((r) => `  ${r}`), "");
	};
	section(
		`Index lines over ${MAX_LINE_CHARS} characters (${l.longLines.length})`,
		l.longLines.map((x) => `${String(x.line).padStart(3)}: ${x.chars} · ${x.text.slice(0, 90)}…`),
	);
	if (l.indexLines > MAX_INDEX_LINES) section("Index too long", [`${l.indexLines} lines; the prompt gets the first ${MAX_INDEX_LINES}`]);
	section(`Links to missing files (${l.missing.length})`, l.missing);
	section(`Topic files without an index line or a topic map that links them (${l.unindexed.length})`, l.unindexed);
	section(`Topic files without frontmatter (name, description, type) (${l.noFrontmatter.length})`, l.noFrontmatter);
	section(
		`Topic files over ${MAX_TOPIC_BYTES / 1024} KB (${l.large.length}): each read costs about as many tokens as the file has bytes / 3.5`,
		l.large.map((x) => `${kb(x.bytes).padStart(8)}  ${x.file}`),
	);
	if (out.length === 2) out.push("Nothing to report.");
	return out;
}

/** What the memory is, for the prompt and /memory: "Claude Code's auto memory" or the provider's name. */
function describe(provider: string): string {
	return provider === "claude" ? "shared with Claude Code" : provider === "pi" ? "Pi's own" : `provider ${provider}`;
}

const trustedIn = (ctx: ExtensionContext) => {
	try {
		return ctx.isProjectTrusted();
	} catch {
		return false;
	}
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.PI_SUBAGENT_DEPTH || !ctx.hasUI) return;
		const problem = loadProviders().problem;
		if (problem) ctx.ui.notify(`memory: ${problem}; the defaults apply`, "warning");
		const memory = memoryOf(ctx.cwd, trustedIn(ctx));
		if (!memory) ctx.ui.notify("memory: no provider in memory.json is available", "warning");
		else if (memory.exists) {
			ctx.ui.notify(`Memory: ${shortPath(memory.dir)}`, "info");
			const summary = lintSummary(lint(memory.dir));
			if (summary) ctx.ui.notify(`memory: ${summary}; /memory lint lists them, /memory tidy fixes them`, "warning");
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		const sections = event.systemPromptOptions.sections as Record<string, string | undefined>;
		const memory = process.env.PI_SUBAGENT_DEPTH ? undefined : memoryOf(event.systemPromptOptions.cwd, trustedIn(ctx));
		if (!memory) {
			delete sections.memory;
			return;
		}
		let index = "";
		if (memory.exists) {
			index = readFileSync(path.join(memory.dir, INDEX), "utf8").trim();
			const lines = index.split("\n");
			if (lines.length > MAX_INDEX_LINES) index = `${lines.slice(0, MAX_INDEX_LINES).join("\n")}\n…`;
		}
		sections.memory = [
			`Persistent memory for this project, ${describe(memory.provider)}. Directory: ${memory.dir}`,
			"The index below links topic files (relative to that directory). Read a topic file when it is relevant to the task before acting; treat entries as dated observations and verify them against the current state when it matters.",
			"",
			RULES,
			"",
			index ? `${INDEX}:\n${index}` : `${INDEX} does not exist yet: this project has no memory so far.`,
		].join("\n");
	});

	// Writes into the memory keep its limits.
	pi.on("tool_call", (event, ctx) => {
		if (process.env.PI_SUBAGENT_DEPTH || !guardOn()) return;
		const write = isToolCallEventType("write", event);
		if (!write && !isToolCallEventType("edit", event)) return;
		const memory = memoryOf(ctx.cwd, trustedIn(ctx));
		if (!memory) return;
		const input = event.input as { path: string; content?: string; edits?: { oldText: string; newText: string }[]; oldText?: string; newText?: string };
		const target = toolPath(input.path, ctx.cwd);
		if (path.dirname(target) !== memory.dir) return;
		const edits = write ? [] : (input.edits ?? (input.newText !== undefined ? [{ oldText: input.oldText ?? "", newText: input.newText }] : []));
		const problem = guardProblem(target, write ? (input.content ?? "") : undefined, edits);
		if (problem) return { block: true, reason: problem };
	});

	// The first entry in a project without memory: the folder and an empty index come with it.
	pi.on("tool_call", (event, ctx) => {
		if (process.env.PI_SUBAGENT_DEPTH) return;
		if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return;
		const memory = memoryOf(ctx.cwd, trustedIn(ctx));
		if (!memory || memory.exists) return;
		const target = toolPath(event.input.path, ctx.cwd);
		if (!target.startsWith(memory.dir + path.sep)) return;
		try {
			mkdirSync(memory.dir, { recursive: true });
			const index = path.join(memory.dir, INDEX);
			if (target !== index && !existsSync(index)) writeFileSync(index, "");
		} catch {
			// the tool reports what fails
		}
	});

	pi.registerCommand("memory", {
		description:
			"Show this project's memory and its providers; /memory edit opens the index, lint checks it, tidy fixes it, migrate copies it from another provider",
		getArgumentCompletions: (prefix) => {
			const matches = ["edit", "lint", "tidy", "migrate"].filter((v) => v !== prefix && v.startsWith(prefix));
			return matches.length ? matches.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			const memory = memoryOf(ctx.cwd, trustedIn(ctx));
			if (!memory) {
				ctx.ui.notify("No provider in memory.json is available, so Pi has no memory here.", "warning");
				return;
			}
			const index = path.join(memory.dir, INDEX);
			if (args.trim() === "lint") {
				const result = lint(memory.dir);
				await showText(ctx, `Memory lint · ${shortPath(memory.dir)}`, (_width, theme) => lintReport(result, theme));
				return;
			}
			if (args.trim() === "tidy") {
				const result = lint(memory.dir);
				if (!lintSummary(result)) {
					ctx.ui.notify("The memory keeps its limits; nothing to tidy.", "info");
					return;
				}
				const plain = { fg: (_color: string, text: string) => text } as unknown as Theme;
				const task = [
					`Tidy this project's memory in ${memory.dir}, following its rules. /memory lint found:`,
					"",
					...lintReport(result, plain),
					"",
					`- Index lines over ${MAX_LINE_CHARS} characters: keep the title and the one fact that decides whether the entry is relevant; check that every detail the line drops stands in its topic file, and move it there if not.`,
					`- Topic files over ${MAX_TOPIC_BYTES / 1024} KB: split each by subject into topic files of at most ${MAX_TOPIC_BYTES / 1024} KB, each with frontmatter, so that a task reads only the part it needs: the original file stays as the core with a topic map that links the others ([[name]]), and only it keeps a line in ${INDEX}, ending in a topic map hint. Keep every fact, prohibition, decision, and preference that still holds; drop only what is clearly stale (superseded statements, finished intermediate states, removed workarounds).`,
					"- Links to missing files, files without an index line or frontmatter: fix the index or the file.",
					"- Before you remove anything or overwrite a file, show me what would go, with the reason, and wait for my answer.",
				].join("\n");
				if (ctx.isIdle()) pi.sendUserMessage(task);
				else pi.sendUserMessage(task, { deliverAs: "followUp" });
				return;
			}
			const [verb, named] = args.trim().split(/\s+/);
			if (verb === "migrate") {
				if (memory.exists && readFileSync(index, "utf8").split("\n").some((line) => line.trim())) {
					ctx.ui.notify(`${shortPath(memory.dir)} has entries already, so nothing was copied: /memory migrate fills an empty memory only.`, "warning");
					return;
				}
				const root = projectRoot(ctx.cwd);
				const key = root.replace(/[^a-zA-Z0-9]/g, "-");
				const configured = loadProviders().providers;
				const candidates = [...configured, ...DEFAULT_PROVIDERS.filter((d) => !configured.some((p) => p.name === d.name))]
					.filter((p) => !named || p.name === named)
					.map((p) => resolve(p, root, key, trustedIn(ctx)))
					.filter((r) => r.dir && path.resolve(r.dir) !== path.resolve(memory.dir));
				const source = candidates.find((r) => existsSync(path.join(r.dir, INDEX)));
				if (!source) {
					const where = named ? `provider ${named}` : "any other provider";
					ctx.ui.notify(`No memory of this project in the folder of ${where}; nothing to copy.`, "warning");
					return;
				}
				const before = new Set(existsSync(memory.dir) ? readdirSync(memory.dir) : []);
				mkdirSync(memory.dir, { recursive: true });
				cpSync(source.dir, memory.dir, { recursive: true, force: false, errorOnExist: false });
				// An index without entries is replaced by the source's.
				if (memory.exists) cpSync(path.join(source.dir, INDEX), index, { force: true });
				const copied = readdirSync(memory.dir).filter((name) => !before.has(name) || name === INDEX).length;
				ctx.ui.notify(
					`Copied ${copied} file${copied === 1 ? "" : "s"} of this project's memory from ${source.provider} (${shortPath(source.dir)}) to ${memory.provider} (${shortPath(memory.dir)}). The source stays as it is.`,
					"info",
				);
				return;
			}
			if (args.trim() === "edit") {
				const before = memory.exists ? readFileSync(index, "utf8") : "";
				const after = await ctx.ui.editor(`Memory index · ${shortPath(index)}`, before);
				if (after === undefined || after === before) return;
				mkdirSync(memory.dir, { recursive: true });
				writeFileSync(index, after.endsWith("\n") || after === "" ? after : `${after}\n`);
				ctx.ui.notify(`Saved ${shortPath(index)}`, "info");
				return;
			}
			await showText(ctx, `Memory · ${shortPath(memory.dir)}`, (_width, theme) => {
				const providers = memory.all.map((r) =>
					r.dir === memory.dir && r.provider === memory.provider
						? `${theme.fg("success", "●")} ${r.provider}  ${shortPath(r.dir)}  ${theme.fg("muted", "(in use)")}`
						: `${theme.fg("dim", "○")} ${r.provider}  ${r.dir ? shortPath(r.dir) : ""}  ${theme.fg("muted", r.unavailable ? `(${r.unavailable})` : "(fallback)")}`,
				);
				const head = [theme.fg("muted", `Providers in order of priority (${shortPath(CONFIG_FILE)}):`), ...providers, ""];
				if (!memory.exists) return [...head, `No memory yet for this project (${describe(memory.provider)}). The first entry creates it.`];
				return [...head, theme.fg("muted", `${INDEX} · /memory edit opens it`), "", ...readFileSync(index, "utf8").trimEnd().split("\n")];
			});
		},
	});
}
