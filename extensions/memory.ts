/**
 * Memory: a persistent memory per project, kept the way Claude Code keeps its auto memory, for any provider.
 *
 * - A project's memory is a folder with an index, MEMORY.md, holding one line per entry that links a topic file, and
 *   the topic files themselves (Markdown with frontmatter). The index goes into the system prompt on every run, read
 *   live; the model reads a topic file when it is relevant and writes, corrects, and removes entries with its file
 *   tools, following the rules that come with the index.
 * - The folder is shared with Claude Code while Claude Code is there (its config directory exists; CLAUDE_CONFIG_DIR
 *   is honoured): ~/.claude/projects/<key>/memory, so both remember the same. Without Claude Code it is
 *   ~/.pi/agent/memory/<key>. {"store": "claude"} or {"store": "pi"} in ~/.pi/agent/memory.json fixes one.
 * - <key> is the project's absolute path with every character but letters and digits replaced by "-", as Claude Code
 *   names it. The working directory and its parents are tried, nearest first; without a memory in any of them, the
 *   working directory's folder is used, and the extension creates it with an empty index when the first entry is
 *   written there.
 * - /memory shows the folder and the index; /memory edit opens the index in Pi's editor.
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

/** Where memories live: Claude Code's projects folder while Claude Code is there, else Pi's own; memory.json fixes one. */
function store(): "claude" | "pi" {
	try {
		const value = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))?.store;
		if (value === "claude" || value === "pi") return value;
	} catch {
		// no settings: decide by Claude Code's presence
	}
	return existsSync(claudeDir()) ? "claude" : "pi";
}

function folderOf(dir: string, where: "claude" | "pi"): string {
	const key = dir.replace(/[^a-zA-Z0-9]/g, "-");
	return where === "claude" ? path.join(claudeDir(), "projects", key, "memory") : path.join(getAgentDir(), "memory", key);
}

/**
 * The memory of a working directory: the nearest folder of it and its parents that has an index, else the working
 * directory's own, which does not exist yet.
 */
function memoryOf(cwd: string): { dir: string; exists: boolean; where: "claude" | "pi" } {
	const where = store();
	const start = path.resolve(cwd);
	for (let dir = start; ; dir = path.dirname(dir)) {
		const candidate = folderOf(dir, where);
		if (existsSync(path.join(candidate, INDEX))) return { dir: candidate, exists: true, where };
		if (dir === path.dirname(dir)) break;
	}
	return { dir: folderOf(start, where), exists: false, where };
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.PI_SUBAGENT_DEPTH || !ctx.hasUI) return;
		const memory = memoryOf(ctx.cwd);
		if (memory.exists) ctx.ui.notify(`Memory: ${shortPath(memory.dir)}`, "info");
	});

	pi.on("before_agent_start", (event) => {
		const sections = event.systemPromptOptions.sections as Record<string, string | undefined>;
		if (process.env.PI_SUBAGENT_DEPTH) {
			delete sections.memory;
			return;
		}
		const memory = memoryOf(event.systemPromptOptions.cwd);
		let index = "";
		if (memory.exists) {
			index = readFileSync(path.join(memory.dir, INDEX), "utf8").trim();
			const lines = index.split("\n");
			if (lines.length > MAX_INDEX_LINES) index = `${lines.slice(0, MAX_INDEX_LINES).join("\n")}\n…`;
		}
		const shared = memory.where === "claude" ? ", shared with Claude Code" : "";
		sections.memory = [
			`Persistent memory for this project${shared}. Directory: ${memory.dir}`,
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
		const memory = memoryOf(ctx.cwd);
		if (memory.exists) return;
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
		description: "Show this project's memory; /memory edit opens its index in the editor",
		getArgumentCompletions: (prefix) => (prefix !== "edit" && "edit".startsWith(prefix) ? [{ value: "edit", label: "edit" }] : null),
		handler: async (args, ctx) => {
			const memory = memoryOf(ctx.cwd);
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
			const where = memory.where === "claude" ? "shared with Claude Code" : "Pi's own";
			await showText(ctx, `Memory · ${shortPath(memory.dir)}`, (_width, theme) => {
				if (!memory.exists) return [`No memory yet for this project (${where}).`, "", theme.fg("muted", `The first entry creates ${shortPath(memory.dir)}.`)];
				const lines = readFileSync(index, "utf8").trimEnd().split("\n");
				return [theme.fg("muted", `${where} · /memory edit opens the index`), "", ...lines];
			});
		},
	});
}
