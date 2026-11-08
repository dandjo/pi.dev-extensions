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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const INDEX = "MEMORY.md";
const MAX_INDEX_LINES = 200;
const CONFIG_FILE = path.join(getAgentDir(), "memory.json");

/** How the model keeps the memory, in Claude Code's format so that both can read and write the same files. */
const RULES = [
	"How to keep this memory:",
	"- Save what a later session needs and cannot read from the code, the docs, or the git history: who the user is and how they work (type user); corrections and preferences they gave you (feedback); facts and decisions about the project and its surroundings, with the reason (project); where outside information lives (reference). Save at once when the user asks you to remember something, corrects you, or a non-obvious fact took effort to establish.",
	"- Do not save the steps of the current task, guesses, or what the repository already says, and never secrets, tokens, or other people's personal data.",
	"- One topic file per subject, named in kebab-case (deploy-needs-vpn.md), beginning with this frontmatter: `name` (the file name without .md), `description` (one line, specific enough to judge relevance), and `metadata` with `node_type: memory`, `type` (user, feedback, project, or reference), and `modified` (an ISO 8601 timestamp). Then the fact; feedback and project entries add **Why:** (the reason given) and **How to apply:** (when it matters).",
	"- Every topic file has one line in MEMORY.md: `- [Title](file.md) — what it says`, under 150 characters. The index holds no content of its own and stays under 200 lines; create it with the first entry if it is missing.",
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
	// {"store": "claude"|"pi"}, the form of the first version
	if (config && typeof config === "object" && config.providers === undefined && (config.store === "claude" || config.store === "pi")) {
		return { providers: [{ name: config.store }] };
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
 * background-agents.ts, btw.ts, claude-hooks.ts, claude-remote-control.ts, diff.ts, scheduled-tasks.ts, subagents.ts
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
		else if (memory.exists) ctx.ui.notify(`Memory: ${shortPath(memory.dir)}`, "info");
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
		description: "Show this project's memory and its providers; /memory edit opens the index in the editor",
		getArgumentCompletions: (prefix) => (prefix !== "edit" && "edit".startsWith(prefix) ? [{ value: "edit", label: "edit" }] : null),
		handler: async (args, ctx) => {
			const memory = memoryOf(ctx.cwd, trustedIn(ctx));
			if (!memory) {
				ctx.ui.notify("No provider in memory.json is available, so Pi has no memory here.", "warning");
				return;
			}
			const index = path.join(memory.dir, INDEX);
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
