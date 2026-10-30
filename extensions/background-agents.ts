/**
 * Background agents: Claude Code's agent panel below the prompt. While subagents (subagents.ts) run in the
 * background, a panel under the editor lists them; ↓ from the prompt moves into it, Enter opens an agent's live
 * transcript, x stops it (https://code.claude.com/docs/en/sub-agents).
 *
 * - The panel shows a `main` row and one row per agent: name, description, elapsed time, tokens. At most five rows
 *   are visible; the window follows the selection. Finished agents stay listed for 30 seconds, failed or stopped
 *   ones with a red mark. The footer reads "↓ to manage" while the panel exists.
 * - ↓ on the last line of the prompt, outside history browsing and autocomplete, selects the panel. Then ↑/↓ move
 *   (↑ from the first row returns to the prompt), Enter opens the selected agent (on `main` it returns to the
 *   prompt), x stops a running agent or clears a finished one, Esc returns to the prompt, and typing goes to the
 *   prompt. /tasks lists the agents as well.
 * - Opening an agent shows its transcript as it is written — the task, the assistant's text, its tool calls and
 *   results — in an overlay that follows the end while the agent works; ↑↓ PgUp PgDn scroll, x stops the agent,
 *   Esc returns. Subagents cannot be messaged; their report arrives in the conversation when they finish.
 * - The transcript is read from the agent's session file under ~/.pi/agent/subagents/<session id>/. The panel
 *   replaces the editor with a subclass of Pi's own, so another extension that replaces the editor wins over it.
 * - Scheduled tasks (scheduled-tasks.ts, scheduled-tasks:state) are listed below the agents with their schedule and
 *   next run: Enter opens the task in its manager, x deletes it. The panel also exists while only tasks are scheduled.
 * - The mouse: a click on a row opens it, a click on `main` returns to the prompt, and a click on "↓ to manage" in
 *   the status line (statusline:status-click) moves into the panel.
 */

import { type ExtensionAPI, type ExtensionContext, CustomEditor, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	type KeybindingsManager,
	Markdown,
	matchesKey,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bodyRows, frame, scrollKey, viewport } from "./lib/overlay.ts";
import type { ScheduledTaskView } from "./scheduled-tasks.ts";
import type { SubagentView } from "./subagents.ts";

const SESSIONS_ROOT = path.join(getAgentDir(), "subagents");
const WIDGET_KEY = "background-agents";
const STATUS_KEY = "background-agents";
const MAX_VISIBLE_ROWS = 5;
const FINISHED_TTL_MS = 30_000;
const TICK_MS = 1_000;
const TRANSCRIPT_POLL_MS = 500;
const MAX_NAME_WIDTH = 28;
const RESULT_PREVIEW_LINES = 4;

type Theme = ExtensionContext["ui"]["theme"];

interface Row extends SubagentView {
	finishedAt?: number;
}

/** A row of the panel below `main`: a background agent or a scheduled task. */
type Entry = { kind: "agent"; row: Row } | { kind: "scheduled"; task: ScheduledTaskView };

// --- Formatting ---------------------------------------------------------------------------------------------------------

function elapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ${m % 60}m ${s % 60}s`;
	return `${Math.floor(h / 24)}d ${h % 24}h ${m % 60}m`;
}

function compact(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

function summarize(name: string, args: Record<string, unknown>): string {
	const short = (value: unknown, max = 80) => {
		const text = String(value ?? "").replace(/\s+/g, " ").trim();
		return text.length > max ? `${text.slice(0, max - 1)}…` : text;
	};
	const home = (p: unknown) => String(p ?? "").replace(os.homedir(), "~");
	switch (name) {
		case "bash":
			return `$ ${short(args.command)}`;
		case "read":
		case "write":
		case "edit":
			return `${name} ${home(args.path)}`;
		case "grep":
			return `grep /${short(args.pattern, 40)}/ ${home(args.path ?? ".")}`;
		case "find":
			return `find ${short(args.pattern, 40)} ${home(args.path ?? ".")}`;
		case "Agent":
			return `Agent ${args.subagent_type ?? "general-purpose"}: ${short(args.description, 50)}`;
		default:
			return `${name} ${short(JSON.stringify(args), 70)}`;
	}
}

// --- Transcript -----------------------------------------------------------------------------------------------------------

function sessionFileOf(sessionId: string, agentId: string): string | undefined {
	const dir = path.join(SESSIONS_ROOT, sessionId);
	try {
		const name = readdirSync(dir).find((f) => f.endsWith(`_${agentId}.jsonl`));
		return name ? path.join(dir, name) : undefined;
	} catch {
		return undefined;
	}
}

/** The transcript of a subagent session file as terminal lines for `width`. */
function transcriptLines(file: string, width: number, theme: Theme): string[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [theme.fg("dim", "The agent's session file is not there yet.")];
	}
	const lines: string[] = [];
	const wrap = (s: string) => (s ? wrapTextWithAnsi(s, width) : [""]);
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(raw);
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			const content = typeof message.content === "string" ? message.content : message.content.map((p: any) => (p.type === "text" ? p.text : "[image]")).join("\n");
			lines.push(...wrap(theme.fg("accent", `❯ ${content.split("\n")[0]}`)));
			for (const line of content.split("\n").slice(1)) lines.push(...wrap(`  ${line}`));
			lines.push("");
		} else if (message.role === "assistant") {
			for (const part of message.content ?? []) {
				if (part.type === "text" && part.text?.trim()) {
					lines.push(...new Markdown(part.text, 0, 0, getMarkdownTheme()).render(width));
					lines.push("");
				} else if (part.type === "thinking" && part.thinking) {
					lines.push(theme.fg("dim", `· thinking (${compact(part.thinking.length)} chars)`));
				} else if (part.type === "toolCall") {
					lines.push(...wrap(theme.fg("muted", "→ ") + theme.fg("toolTitle", summarize(part.name, part.arguments ?? {}))));
				}
			}
			if (message.stopReason === "error" && message.errorMessage) lines.push(...wrap(theme.fg("error", message.errorMessage)));
		} else if (message.role === "toolResult") {
			const body = (message.content ?? []).map((p: any) => (p.type === "text" ? p.text : "[image]")).join("\n");
			const all = body.split("\n").filter((l: string) => l.trim());
			const shown = all.slice(0, RESULT_PREVIEW_LINES);
			for (const line of shown) lines.push(truncateToWidth(theme.fg(message.isError ? "error" : "dim", `  ${line}`), width, "…"));
			if (all.length > shown.length) lines.push(theme.fg("dim", `  … ${all.length - shown.length} more lines`));
			lines.push("");
		}
	}
	return lines.length ? lines : [theme.fg("dim", "Nothing yet.")];
}

// --- Extension -----------------------------------------------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_DEPTH) return;

	let ctx: ExtensionContext | null = null;
	const rows = new Map<string, Row>();
	let scheduled: ScheduledTaskView[] = [];
	/** -1: the prompt has the focus; 0: the main row; 1..n: the entries (agents, then scheduled tasks). */
	let selected = -1;
	/** The selection index of each line of the last panel render, for the mouse. */
	let panelLines: (number | undefined)[] = [];
	let scroll = 0;
	let viewing: string | null = null;
	let widgetShown = false;
	let widgetTui: TUI | null = null;
	let ticker: NodeJS.Timeout | null = null;

	const agentRows = (): Row[] => {
		const now = Date.now();
		const list = [...rows.values()].filter((r) => r.status === "running" || r.agentId === viewing || now - (r.finishedAt ?? now) < FINISHED_TTL_MS);
		return list.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.startedAt - b.startedAt);
	};

	const entries = (): Entry[] => [
		...agentRows().map((row) => ({ kind: "agent" as const, row })),
		...scheduled.map((task) => ({ kind: "scheduled" as const, task })),
	];

	// --- state -------------------------------------------------------------------------------------------------------

	function refresh(): void {
		const list = entries();
		if (selected > list.length) selected = list.length;
		if (list.length === 0 && selected >= 0) selected = -1;
		const show = list.length > 0;
		if (show && (!widgetShown || !widgetTui)) {
			widgetShown = true;
			ctx?.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				widgetTui = tui;
				return {
					render: (width: number) => renderPanel(width, theme),
					handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
						if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
						const index = panelLines[event.y];
						if (index === undefined) return undefined;
						if (event.type === "click") {
							if (index === 0) blur();
							else openEntry(entries()[index - 1]);
						}
						return { handled: true };
					},
					invalidate() {},
					dispose() {
						if (widgetTui === tui) widgetTui = null;
					},
				};
			}, { placement: "belowEditor" });
		} else if (!show && widgetShown) {
			widgetShown = false;
			ctx?.ui.setWidget(WIDGET_KEY, undefined);
		}
		ctx?.ui.setStatus(STATUS_KEY, hint(list));
		widgetTui?.requestRender();
		if (show && !ticker) {
			ticker = setInterval(refresh, TICK_MS);
			ticker.unref?.();
		} else if (!show && ticker) {
			clearInterval(ticker);
			ticker = null;
		}
	}

	function hint(list: Entry[]): string | undefined {
		if (list.length === 0) return undefined;
		if (selected < 0) return "↓ to manage";
		if (selected === 0) return "↑/↓ to select · Enter to return";
		const entry = list[selected - 1];
		if (entry?.kind === "scheduled") return "Enter to view · x to delete";
		const running = list.filter((e) => e.kind === "agent" && e.row.status === "running").length;
		const stopAll = running > 1 ? " · x on each to stop" : "";
		return entry?.row.status === "running" ? `Enter to view · x to stop${stopAll}` : "Enter to view · x to clear";
	}

	function onScheduled(data: unknown): void {
		if (!Array.isArray(data)) return;
		scheduled = data as ScheduledTaskView[];
		refresh();
	}

	/** Enter or a click on an entry: an agent's transcript, or the scheduled task in its manager. */
	function openEntry(entry: Entry | undefined): void {
		if (!entry) return;
		if (entry.kind === "agent") void openAgent(entry.row);
		else pi.events.emit("scheduled-tasks:open", { id: entry.task.id });
	}

	function onState(data: unknown): void {
		if (!Array.isArray(data)) return;
		const now = Date.now();
		const seen = new Set<string>();
		for (const v of data as SubagentView[]) {
			if (!v.background && v.status === "running") continue; // foreground agents block the prompt; the tool call shows them
			seen.add(v.agentId);
			const old = rows.get(v.agentId);
			const finishedAt = v.status === "running" ? undefined : (old?.finishedAt ?? now);
			rows.set(v.agentId, { ...v, finishedAt });
		}
		for (const id of rows.keys()) if (!seen.has(id)) rows.delete(id);
		refresh();
	}

	// --- panel ------------------------------------------------------------------------------------------------------------

	function renderPanel(width: number, theme: Theme): string[] {
		const list = entries();
		panelLines = [];
		if (list.length === 0) return [];
		const focused = selected >= 0;
		const lines: string[] = [];
		const total = list.length;
		if (selected - 1 < scroll) scroll = Math.max(0, selected - 1);
		if (selected - 1 >= scroll + MAX_VISIBLE_ROWS) scroll = selected - MAX_VISIBLE_ROWS;
		scroll = Math.max(0, Math.min(scroll, Math.max(0, total - MAX_VISIBLE_ROWS)));
		const visible = list.slice(scroll, scroll + MAX_VISIBLE_ROWS);

		const mainPointer = selected === 0 ? theme.fg("accent", "❯ ") : "  ";
		let main = `${mainPointer}${viewing ? "◯" : "●"} ${selected === 0 ? theme.bold("main") : focused ? "main" : theme.fg("dim", "main")}`;
		if (scroll > 0) {
			const more = theme.fg("dim", `↑ ${scroll} more`);
			main = `${truncateToWidth(main, Math.max(0, width - visibleWidth(more) - 1), "…")} ${more}`;
		}
		panelLines[lines.length] = 0;
		lines.push(truncateToWidth(main, width, "…"));

		const label = (entry: Entry) => (entry.kind === "agent" ? entry.row.type : entry.task.kind === "loop wakeup" ? "loop" : "scheduled");
		const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(4, ...list.map((e) => label(e).length)));
		const statuses = visible.map((e) => (e.kind === "agent" ? statusText(e.row) : `${e.task.kind === "loop wakeup" ? "" : `${e.task.schedule} · `}next ${e.task.next}`));
		const statusWidth = Math.max(...statuses.map((s) => s.length), 0);
		visible.forEach((entry, i) => {
			const index = scroll + i + 1;
			const isSelected = selected === index;
			const pointer = isSelected ? theme.fg("accent", "❯ ") : "  ";
			const name = truncateToWidth(label(entry), nameWidth, "…").padEnd(nameWidth);
			const descWidth = Math.max(8, width - 2 - 2 - nameWidth - 2 - statusWidth - 2);
			const desc = truncateToWidth((entry.kind === "agent" ? entry.row.description : entry.task.prompt) || "", descWidth, "…").padEnd(descWidth);
			let status = statuses[i].padStart(statusWidth);
			status = status.replace(/\d+ queued/, (m) => theme.fg("warning", m));
			const body = `${isSelected ? theme.bold(name) : name}  ${desc}  ${status}`;
			panelLines[lines.length] = index;
			if (entry.kind === "scheduled") {
				const dim = !isSelected && !focused;
				lines.push(truncateToWidth(`${pointer}${theme.fg("accent", "↻")} ${dim ? theme.fg("dim", body) : body}`, width, "…"));
				return;
			}
			const row = entry.row;
			const icon = row.status === "completed" ? theme.fg("success", "◯") : row.status === "running" ? "◯" : theme.fg("error", "◯");
			const dim = !isSelected && row.agentId !== viewing && !focused;
			lines.push(truncateToWidth(`${pointer}${row.agentId === viewing ? "●" : icon} ${dim ? theme.fg("dim", body) : body}`, width, "…"));
		});
		if (scroll + visible.length < total) lines.push(theme.fg("dim", `    ↓ ${total - scroll - visible.length} more`));
		return lines;
	}

	function statusText(row: Row): string {
		const parts: string[] = [];
		if (row.status === "running") parts.push(elapsed(Date.now() - row.startedAt));
		else parts.push(row.status === "completed" ? `done ${elapsed(row.durationMs ?? 0)}` : row.status === "aborted" ? "stopped" : "failed");
		if (row.tokens > 0) parts.push(`${row.status === "running" && row.toolCount === 0 ? "↑" : "↓"} ${compact(row.tokens)} tokens`);
		return parts.join(" · ");
	}

	// --- keys ---------------------------------------------------------------------------------------------------------------

	function focusPanel(): boolean {
		const list = entries();
		if (list.length === 0) return false;
		selected = 0;
		refresh();
		return true;
	}

	function blur(): void {
		selected = -1;
		refresh();
	}

	/** Handles a key while the panel is selected; false when the key belongs to the editor. */
	function panelKey(data: string, keybindings: KeybindingsManager): boolean {
		const list = entries();
		if (selected < 0 || list.length === 0) return false;
		if (matchesKey(data, Key.down) || keybindings.matches(data, "tui.editor.cursorDown") || data === "\x0e") {
			selected = Math.min(list.length, selected + 1);
			refresh();
			return true;
		}
		if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.editor.cursorUp") || data === "\x10") {
			if (selected === 0) blur();
			else {
				selected--;
				refresh();
			}
			return true;
		}
		if (matchesKey(data, Key.escape)) {
			blur();
			return true;
		}
		if (matchesKey(data, Key.enter)) {
			if (selected === 0) blur();
			else openEntry(list[selected - 1]);
			return true;
		}
		if (data === "x" && selected > 0) {
			const entry = list[selected - 1];
			if (entry.kind === "scheduled") {
				pi.events.emit("scheduled-tasks:delete", entry.task.id);
				selected = Math.max(0, selected - 1);
				refresh();
				return true;
			}
			const row = entry.row;
			if (row.status === "running") {
				pi.events.emit("subagents:stop", row.agentId);
				ctx?.ui.notify(`Stopping agent ${row.type} (${row.agentId}).`, "info");
			} else {
				rows.delete(row.agentId);
				selected = Math.max(0, selected - 1);
			}
			refresh();
			return true;
		}
		// Printable text goes to the prompt, which takes the focus back.
		if (data.length >= 1 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32) {
			blur();
			return false;
		}
		return false;
	}

	class AgentsEditor extends CustomEditor {
		constructor(
			tui: TUI,
			theme: ConstructorParameters<typeof CustomEditor>[1],
			private readonly kb: KeybindingsManager,
		) {
			super(tui, theme, kb, { embedWorkingStatus: true });
		}

		handleInput(data: string): void {
			if (selected >= 0 && panelKey(data, this.kb)) return;
			if ((matchesKey(data, Key.down) || this.kb.matches(data, "tui.editor.cursorDown")) && this.atPromptEnd() && focusPanel()) return;
			super.handleInput(data);
		}

		private atPromptEnd(): boolean {
			const self = this as unknown as { historyIndex?: number; isOnLastVisualLine?: () => boolean };
			if (this.isShowingAutocomplete()) return false;
			if ((self.historyIndex ?? -1) > -1) return false;
			if (typeof self.isOnLastVisualLine === "function") return self.isOnLastVisualLine();
			return this.getCursor().line === this.getLines().length - 1;
		}
	}

	// --- transcript overlay ------------------------------------------------------------------------------------------------------

	async function openAgent(row: Row): Promise<void> {
		if (!ctx) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (ctx.mode !== "tui") {
			const file = sessionFileOf(sessionId, row.agentId);
			ctx.ui.notify(`Agent ${row.type} ${row.agentId}: ${row.status}${file ? ` — transcript at ${file}` : ""}`, "info");
			return;
		}
		viewing = row.agentId;
		refresh();
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					let file = sessionFileOf(sessionId, row.agentId);
					let offset = 0;
					let follow = true;
					let cache: { width: number; lines: string[]; size: number } | undefined;
					const size = () => {
						try {
							return file ? statSync(file).size : -1;
						} catch {
							return -1;
						}
					};
					const body = (width: number) => {
						const now = size();
						if (!cache || cache.width !== width || cache.size !== now) {
							const inner = Math.max(1, width - 4);
							cache = { width, size: now, lines: file ? transcriptLines(file, inner, theme) : [theme.fg("dim", "The agent has not started writing yet.")] };
						}
						return cache.lines;
					};
					const timer = setInterval(() => {
						if (!file) file = sessionFileOf(sessionId, row.agentId);
						if (size() !== (cache?.size ?? -2)) tui.requestRender();
					}, TRANSCRIPT_POLL_MS);
					return {
						render(width: number): string[] {
							const current = rows.get(row.agentId) ?? row;
							const lines = body(width);
							const rowsAvail = Math.max(3, bodyRows(tui) - 2);
							const max = Math.max(0, lines.length - rowsAvail);
							if (follow) offset = max;
							offset = Math.min(offset, max);
							const state = current.status === "running" ? theme.fg("warning", `running · ${elapsed(Date.now() - current.startedAt)}`) : current.status === "completed" ? theme.fg("success", `✔ completed · ${elapsed(current.durationMs ?? 0)}`) : theme.fg("error", `${current.status === "aborted" ? "stopped" : "✘ failed"}${current.error ? ` · ${current.error.split("\n")[0]}` : ""}`);
							const head = [
								truncateToWidth(`${state}  ${theme.fg("dim", `${compact(current.tokens)} tokens · ${current.toolCount} tool${current.toolCount === 1 ? "" : "s"} · ${current.model.split("/").at(-1)}`)}`, Math.max(1, width - 4), "…"),
								"",
							];
							const more = lines.length > rowsAvail ? `  ${offset + 1}–${Math.min(lines.length, offset + rowsAvail)}/${lines.length}` : "";
							return frame(
								theme,
								width,
								`${current.type} › ${current.description || row.agentId}`,
								[...head, ...viewport(lines, offset, rowsAvail)],
								`↑↓ PgUp PgDn scroll · End follow · ${current.status === "running" ? "x stop · " : ""}Esc back${more}`,
							);
						},
						handleInput(data: string): void {
							if (matchesKey(data, Key.escape) || data === "q") {
								done();
								return;
							}
							if (data === "x") {
								const current = rows.get(row.agentId) ?? row;
								if (current.status === "running") {
									pi.events.emit("subagents:stop", row.agentId);
									tui.requestRender();
								}
								return;
							}
							const lines = body(cache?.width ?? 80);
							const rowsAvail = Math.max(3, bodyRows(tui) - 2);
							const next = scrollKey(data, offset, lines.length, rowsAvail);
							if (next !== undefined) {
								offset = next;
								follow = next >= Math.max(0, lines.length - rowsAvail);
								tui.requestRender();
							}
						},
						invalidate(): void {
							cache = undefined;
						},
						dispose(): void {
							clearInterval(timer);
						},
					};
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 } },
			);
		} finally {
			viewing = null;
			refresh();
		}
	}

	// --- lifecycle ------------------------------------------------------------------------------------------------------------------

	pi.on("session_start", (_event, context) => {
		ctx = context;
		rows.clear();
		scheduled = [];
		selected = -1;
		if (context.mode === "tui") context.ui.setEditorComponent((tui, theme, keybindings) => new AgentsEditor(tui, theme, keybindings));
		pi.events.emit("subagents:request", undefined);
		pi.events.emit("scheduled-tasks:request", undefined);
	});

	pi.on("session_shutdown", () => {
		if (ticker) clearInterval(ticker);
		ticker = null;
		if (ctx?.mode === "tui") ctx.ui.setEditorComponent(undefined);
		if (widgetShown) ctx?.ui.setWidget(WIDGET_KEY, undefined);
		widgetShown = false;
		widgetTui = null;
		ctx?.ui.setStatus(STATUS_KEY, undefined);
		ctx = null;
	});

	pi.events.on("subagents:state", onState);
	pi.events.on("scheduled-tasks:state", onScheduled);
	pi.events.on("statusline:status-click", (data) => {
		if ((data as { key?: unknown } | undefined)?.key === STATUS_KEY && selected < 0) focusPanel();
	});

	pi.registerCommand("tasks", {
		description: "List the background agents of this session and open one",
		handler: async (_args, command) => {
			const list = agentRows();
			if (list.length === 0) {
				command.ui.notify("No background agents right now.", "info");
				return;
			}
			const labels = list.map((r) => `${r.type} — ${r.description || r.agentId} (${statusText(r)})`);
			const answer = await command.ui.select("Background agents", labels);
			const index = answer ? labels.indexOf(answer) : -1;
			if (index >= 0) await openAgent(list[index]);
		},
	});
}
