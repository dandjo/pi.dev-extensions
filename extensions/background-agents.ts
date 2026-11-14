/**
 * Background agents: Claude Code's agent panel below the prompt. While subagents (subagents.ts) run, in the background
 * or in the foreground, a panel under the editor lists them; ↓ from the prompt moves into it, Enter opens an agent's
 * live transcript, x stops it, and Ctrl+B moves a foreground agent to the background
 * (https://code.claude.com/docs/en/sub-agents).
 *
 * - The panel shows a `main` row and one row per agent: name, description, elapsed time, tokens. At most five rows
 *   are visible; the window follows the selection. Finished agents stay listed for 30 seconds, failed or stopped
 *   ones with a red mark. The footer reads "↓ to manage" while the panel exists.
 * - ↓ on the last line of the prompt, outside history browsing and autocomplete, selects the panel. Then ↑/↓ move
 *   (↑ from the first row returns to the prompt), Enter opens the selected agent (on `main` it shows the
 *   conversation again and returns to the prompt), x stops a running agent or clears a finished one, Esc returns to
 *   the prompt, and typing goes to the prompt. /tasks lists the agents as well.
 * - Ctrl+B, while a foreground agent runs, moves it to the background, as in Claude Code: the agent selected in the
 *   panel, or else every foreground agent. Its Agent call returns at once, the conversation goes on, and the report
 *   arrives as a message when the agent finishes. Without a foreground agent, Ctrl+B stays the editor's cursor left.
 * - Opening an agent shows its transcript as it is written — the task, the assistant's text, its tool calls and
 *   results — in place of the conversation above the prompt, as Claude Code does; the panel marks the agent shown
 *   with ●. The view follows the end while the agent works and scrolls like the conversation (wheel, PgUp PgDn).
 * - While an agent is shown, the prompt writes to it (subagents:message): a working agent reads the message after
 *   its current step, a finished one starts again with it, and the message stands under the transcript until the
 *   agent has read it. Esc interrupts a working agent (subagents:interrupt), which then waits for an instruction;
 *   Esc again stops it, and Esc on an agent that does not work shows the conversation again. A ! command still
 *   goes to main and shows the conversation. An agent's report arrives in the conversation when it finishes.
 * - The swap exchanges the children of Pi's document container (the first component of the TUI, in fullscreen the
 *   child of the transcript's ScrollView) and restores them, and the conversation's scroll position, on return and at
 *   session_shutdown. Pi keeps writing to its own containers meanwhile. When Pi's tree does not have that shape, the
 *   transcript opens in an overlay instead (↑↓ PgUp PgDn scroll, x stops the agent, Esc returns).
 * - The transcript is read from the agent's session file under ~/.pi/agent/subagents/<session id>/. The panel
 *   replaces the editor with a subclass of Pi's own, so another extension that replaces the editor wins over it.
 * - Scheduled tasks (scheduled-tasks.ts, scheduled-tasks:state) are listed below the agents with their schedule and
 *   next run: Enter opens the task in its manager, x deletes it. The panel also exists while only tasks are scheduled.
 * - The mouse: a click on a row opens it, a click on `main` returns to the prompt, and a click on "↓ to manage" in
 *   the status line (statusline:status-click) moves into the panel.
 */

import { type ExtensionAPI, type ExtensionContext, CustomEditor, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	isViewportTUI,
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

const SESSIONS_ROOT = path.join(getAgentDir(), "subagents");
const WIDGET_KEY = "background-agents";
const STATUS_KEY = "background-agents";
const MAX_VISIBLE_ROWS = 5;
const FINISHED_TTL_MS = 30_000;
const TICK_MS = 1_000;
const TRANSCRIPT_POLL_MS = 500;
const MAX_NAME_WIDTH = 28;
const RESULT_PREVIEW_LINES = 4;
/** How long a message the agent has not read yet stays under its transcript. */
const SENT_TTL_MS = 10 * 60 * 1000;

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

/** The transcript of a subagent session file as terminal lines for `width`, and how many user messages it holds. */
function transcriptLines(file: string, width: number, theme: Theme): { lines: string[]; users: number } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return { lines: [theme.fg("dim", "The agent's session file is not there yet.")], users: 0 };
	}
	let users = 0;
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
			users++;
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
	return { lines: lines.length ? lines : [theme.fg("dim", "Nothing yet.")], users };
}

// --- Extension -----------------------------------------------------------------------------------------------------------------

/**
 * Framed, scrollable boxes for the extensions that show more than a notification can hold: overlays for /hooks,
 * /agents, /cron, and /memory, and the frame and scrolling of the boxes /btw and the /diff dialog show above the
 * prompt.
 *
 * btw.ts, claude-hooks.ts, claude-remote-control.ts, diff.ts, memory.ts, scheduled-tasks.ts, subagents.ts carry a copy
 * of this block, or of a part of it: change them alike.
 */
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

// A copy of ScheduledTaskView from scheduled-tasks.ts, the event-bus contract between the two: change both alike.
/** A scheduled task as other extensions see it (scheduled-tasks:state). */
interface ScheduledTaskView {
	id: string;
	kind: "recurring" | "one-shot" | "loop wakeup";
	/** The schedule in words where it has a common shape ("daily at 11:00"), else the cron expression. */
	schedule: string;
	nextRun: number;
	/** nextRun as the status line shows it. */
	next: string;
	prompt: string;
}

// A copy of SubagentView from subagents.ts, the event-bus contract between the two: change both alike.
/** What other extensions see of a subagent ("subagents:state" on the event bus). */
interface SubagentView {
	agentId: string;
	type: string;
	description: string;
	status: "running" | "completed" | "failed" | "aborted";
	/** While running: the user interrupted it and it waits for an instruction, or one of its dialogs is open. */
	waiting?: "instruction" | "answer";
	background: boolean;
	model: string;
	startedAt: number;
	durationMs?: number;
	tokens: number;
	toolCount: number;
	lastTool?: string;
	error?: string;
}

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
	let editorTui: TUI | null = null;
	let ticker: NodeJS.Timeout | null = null;
	/** What was written to an agent from its transcript and is not in its session file yet, by agentId. */
	const sent = new Map<string, { text: string; after: number; at: number }[]>();

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
							if (index === 0) {
								showMain();
								blur();
							} else openEntry(entries()[index - 1]);
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
		const toBackground = list.some((e) => e.kind === "agent" && isForeground(e.row)) ? " · ctrl+b to run in background" : "";
		if (selected < 0) return `${viewing ? "↓ to manage · ↓ Enter for main" : "↓ to manage"}${toBackground}`;
		if (selected === 0) return viewing ? "↑/↓ to select · Enter to view main" : "↑/↓ to select · Enter to return";
		const entry = list[selected - 1];
		if (entry?.kind === "scheduled") return "Enter to view · x to delete";
		const running = list.filter((e) => e.kind === "agent" && e.row.status === "running").length;
		const stopAll = running > 1 ? " · x on each to stop" : "";
		const view = entry?.row.agentId === viewing ? "" : "Enter to view · ";
		if (entry && isForeground(entry.row)) return `${view}x to stop · ctrl+b to run in background${stopAll}`;
		return entry?.row.status === "running" ? `${view}x to stop${stopAll}` : `${view}x to clear`;
	}

	function isForeground(row: Row): boolean {
		return row.status === "running" && !row.background;
	}

	/** Ctrl+B: the foreground agent selected in the panel, or else every foreground agent, goes to the background. */
	function moveToBackground(): boolean {
		const foreground = agentRows().filter(isForeground);
		if (foreground.length === 0) return false;
		const entry = selected > 0 ? entries()[selected - 1] : undefined;
		const chosen = entry?.kind === "agent" && isForeground(entry.row) ? [entry.row] : foreground;
		for (const row of chosen) pi.events.emit("subagents:background", row.agentId);
		return true;
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
			seen.add(v.agentId);
			const old = rows.get(v.agentId);
			const finishedAt = v.status === "running" ? undefined : (old?.finishedAt ?? now);
			rows.set(v.agentId, { ...v, finishedAt });
		}
		// The agent shown keeps its row, so the panel and its main row stay reachable.
		for (const id of rows.keys()) if (!seen.has(id) && id !== viewing) rows.delete(id);
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

		// The selected row as Pi's own lists and the AskUserQuestion dialog mark theirs: an arrow, the accent colour, and
		// the selection background across the width.
		const pointer = (isSelected: boolean) => (isSelected ? theme.fg("accent", "→ ") : "  ");
		const line = (text: string, isSelected: boolean) => {
			const cut = truncateToWidth(text, width, "…");
			return isSelected ? theme.bg("selectedBg", cut + " ".repeat(Math.max(0, width - visibleWidth(cut)))) : cut;
		};

		let main = `${pointer(selected === 0)}${viewing ? "◯" : "●"} ${selected === 0 ? theme.fg("accent", "main") : focused ? "main" : theme.fg("dim", "main")}`;
		if (scroll > 0) {
			const more = theme.fg("dim", `↑ ${scroll} more`);
			main = `${truncateToWidth(main, Math.max(0, width - visibleWidth(more) - 1), "…")} ${more}`;
		}
		panelLines[lines.length] = 0;
		lines.push(line(main, selected === 0));

		const label = (entry: Entry) => (entry.kind === "agent" ? entry.row.type : entry.task.kind === "loop wakeup" ? "loop" : "scheduled");
		const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(4, ...list.map((e) => label(e).length)));
		const statuses = visible.map((e) => (e.kind === "agent" ? statusText(e.row) : `${e.task.kind === "loop wakeup" ? "" : `${e.task.schedule} · `}next ${e.task.next}`));
		const statusWidth = Math.max(...statuses.map((s) => s.length), 0);
		visible.forEach((entry, i) => {
			const index = scroll + i + 1;
			const isSelected = selected === index;
			const name = truncateToWidth(label(entry), nameWidth, "…").padEnd(nameWidth);
			const descWidth = Math.max(8, width - 2 - 2 - nameWidth - 2 - statusWidth - 2);
			const desc = truncateToWidth((entry.kind === "agent" ? entry.row.description : entry.task.prompt) || "", descWidth, "…").padEnd(descWidth);
			let status = statuses[i].padStart(statusWidth);
			if (!isSelected) status = status.replace(/\d+ queued/, (m) => theme.fg("warning", m));
			const plain = `${name}  ${desc}  ${status}`;
			panelLines[lines.length] = index;
			const dim = !isSelected && !focused && (entry.kind === "scheduled" || entry.row.agentId !== viewing);
			const body = isSelected ? theme.fg("accent", plain) : dim ? theme.fg("dim", plain) : plain;
			if (entry.kind === "scheduled") {
				lines.push(line(`${pointer(isSelected)}${theme.fg("accent", "↻")} ${body}`, isSelected));
				return;
			}
			const row = entry.row;
			const icon = row.status === "completed" ? theme.fg("success", "◯") : row.status === "running" ? "◯" : theme.fg("error", "◯");
			lines.push(line(`${pointer(isSelected)}${row.agentId === viewing ? "●" : icon} ${body}`, isSelected));
		});
		if (scroll + visible.length < total) lines.push(theme.fg("dim", `    ↓ ${total - scroll - visible.length} more`));
		return lines;
	}

	function statusText(row: Row): string {
		const parts: string[] = [];
		if (row.status === "running") parts.push(row.waiting === "instruction" ? "waits for you" : `${row.waiting === "answer" ? "asks you · " : ""}${elapsed(Date.now() - row.startedAt)}`);
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
			if (selected === 0) {
				showMain();
				blur();
			} else openEntry(list[selected - 1]);
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
				if (row.agentId === viewing) showMain();
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
			editorTui = tui;
		}

		handleInput(data: string): void {
			if (matchesKey(data, Key.ctrl("b")) && moveToBackground()) return;
			if (selected >= 0 && panelKey(data, this.kb)) return;
			if (swap && selected < 0 && matchesKey(data, Key.escape) && !this.isShowingAutocomplete()) {
				escapeAgent(swap.agentId);
				return;
			}
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

	// --- transcript in the main view ----------------------------------------------------------------------------------------------

	/** The transcript's ScrollView in fullscreen, as far as the swap uses it. */
	interface ScrollLike {
		readonly scrollTop: number;
		readonly isFollowingEnd: boolean;
		readonly viewportHeight: number;
		scrollTo(top: number): void;
		scrollToEnd(): void;
		updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
	}

	/** Pi's document container: header, loaded resources, and the conversation, in that order. */
	type DocumentContainer = Component & { children: Component[]; mouseLayout?: unknown };

	interface Swap {
		agentId: string;
		tui: TUI;
		doc: DocumentContainer;
		/** The document's own children, back in place on return. */
		saved: Component[];
		scroll?: ScrollLike;
		/** The conversation's scroll position when the agent was opened. */
		scrollState?: { top: number; following: boolean };
		component: AgentView;
		timer: NodeJS.Timeout | null;
	}

	let swap: Swap | null = null;

	/**
	 * The document container, the first component of the TUI in both modes, and in fullscreen the transcript's
	 * ScrollView around it. Undefined when Pi's tree does not have that shape.
	 */
	function documentOf(tui: TUI): { doc: DocumentContainer; scroll?: ScrollLike } | undefined {
		const doc = (tui as unknown as { children?: Component[] }).children?.[0] as DocumentContainer | undefined;
		if (!doc || !Array.isArray(doc.children) || doc.children.length < 3) return undefined;
		if (!isViewportTUI(tui)) return { doc };
		const scroll = scrollViewOf((tui as unknown as { layoutRoot?: unknown }).layoutRoot, doc, 0);
		return scroll ? { doc, scroll } : undefined;
	}

	/** Finds the ScrollView whose child is doc in Pi's layout, which diff.ts may have split. */
	function scrollViewOf(node: unknown, doc: Component, depth: number): ScrollLike | undefined {
		if (!node || typeof node !== "object" || depth > 8) return undefined;
		const n = node as { children?: unknown[]; entries?: Array<{ component?: unknown }>; scrollToEnd?: unknown; updateLayout?: unknown };
		if (typeof n.scrollToEnd === "function" && typeof n.updateLayout === "function" && "scrollTop" in n) {
			return n.children?.[0] === doc ? (node as ScrollLike) : undefined;
		}
		for (const entry of n.entries ?? []) {
			const found = scrollViewOf(entry.component, doc, depth + 1);
			if (found) return found;
		}
		return undefined;
	}

	/** Esc on the agent shown: interrupts it while it works, stops it while it waits after that, else shows main. */
	function escapeAgent(agentId: string): void {
		const row = rows.get(agentId);
		if (row?.status !== "running") showMain();
		else pi.events.emit(row.waiting === "instruction" ? "subagents:stop" : "subagents:interrupt", agentId);
	}

	function stateLine(current: Row, theme: Theme): string {
		if (current.status === "running" && current.waiting === "instruction") return theme.fg("warning", "interrupted · waits for your instruction");
		if (current.status === "running") return theme.fg("warning", `${current.waiting === "answer" ? "asks you" : "running"} · ${elapsed(Date.now() - current.startedAt)}`);
		if (current.status === "completed") return theme.fg("success", `✔ completed · ${elapsed(current.durationMs ?? 0)}`);
		return theme.fg("error", `${current.status === "aborted" ? "stopped" : "✘ failed"}${current.error ? ` · ${current.error.split("\n")[0]}` : ""}`);
	}

	function usageLine(current: Row, theme: Theme): string {
		return theme.fg("dim", `${compact(current.tokens)} tokens · ${current.toolCount} tool${current.toolCount === 1 ? "" : "s"} · ${current.model.split("/").at(-1)}`);
	}

	/** An agent's transcript in place of the conversation: a header, then what its session file holds so far. */
	class AgentView implements Component {
		/** The width of the last render, which is the transcript's content width. */
		width = 80;
		private file: string | undefined;
		private cache: { width: number; size: number; lines: string[]; users: number } | undefined;

		/** The user messages in the session file at the last render. */
		get users(): number {
			return this.cache?.users ?? 0;
		}

		constructor(
			readonly row: Row,
			private readonly sessionId: string,
		) {
			this.file = sessionFileOf(sessionId, row.agentId);
		}

		private size(): number {
			try {
				return this.file ? statSync(this.file).size : -1;
			} catch {
				return -1;
			}
		}

		/** True when the session file changed since the last render. */
		changed(): boolean {
			if (!this.file) this.file = sessionFileOf(this.sessionId, this.row.agentId);
			return this.size() !== (this.cache?.size ?? -2);
		}

		render(width: number): string[] {
			this.width = width;
			const theme = ctx?.ui.theme;
			if (!theme) return [];
			const inner = Math.max(1, width - 2);
			const size = this.size();
			if (!this.cache || this.cache.width !== inner || this.cache.size !== size) {
				const body = this.file ? transcriptLines(this.file, inner, theme) : { lines: [theme.fg("dim", "The agent has not started writing yet.")], users: 0 };
				this.cache = { width: inner, size, lines: body.lines.map((line) => ` ${line}`), users: body.users };
			}
			const current = rows.get(this.row.agentId) ?? this.row;
			const working = current.status === "running";
			const help = !working
				? "The prompt writes to this agent, which then goes on · Esc shows the conversation again"
				: current.waiting === "instruction"
					? "The prompt gives this agent its instruction · Esc stops it"
					: "The prompt writes to this agent · Esc interrupts it · ↓ then Enter on main shows the conversation again";
			const head = [
				`${theme.fg("accent", "●")} ${theme.bold(current.type)} ${theme.fg("dim", "›")} ${current.description || current.agentId}`,
				`${stateLine(current, theme)}  ${usageLine(current, theme)}`,
				theme.fg("dim", help),
			];
			// What the user wrote and the agent has not read: it reads a message after its current step.
			const now = Date.now();
			const unread = (sent.get(this.row.agentId) ?? []).filter((m) => this.cache!.users <= m.after && now - m.at < SENT_TTL_MS);
			if (unread.length) sent.set(this.row.agentId, unread);
			else sent.delete(this.row.agentId);
			const waiting = unread.flatMap((m) => [
				...wrapTextWithAnsi(theme.fg("accent", `❯ ${m.text.trim()}`), inner).map((line) => ` ${line}`),
				` ${theme.fg("dim", working ? "  not read yet: the agent reads it after its current step" : "  starting the agent…")}`,
				"",
			]);
			return ["", ...head.map((line) => truncateToWidth(` ${line}`, width, "…")), "", ...this.cache.lines, ...waiting];
		}

		invalidate(): void {
			this.cache = undefined;
		}
	}

	/** Shows the agent's transcript where the conversation is; false when Pi's tree is not the expected one. */
	function showAgent(row: Row): boolean {
		const tui = editorTui ?? widgetTui;
		if (!ctx || !tui) return false;
		const component = new AgentView(row, ctx.sessionManager.getSessionId());
		if (swap) {
			if (swap.agentId === row.agentId) return true;
			swap.doc.children = [component];
		} else {
			const found = documentOf(tui);
			if (!found) return false;
			const scroll = found.scroll;
			swap = {
				agentId: row.agentId,
				tui,
				doc: found.doc,
				saved: found.doc.children,
				scroll,
				scrollState: scroll ? { top: scroll.scrollTop, following: scroll.isFollowingEnd } : undefined,
				component,
				timer: null,
			};
			found.doc.children = [component];
		}
		const current = swap;
		current.agentId = row.agentId;
		current.component = component;
		current.doc.mouseLayout = undefined;
		if (current.timer) clearInterval(current.timer);
		current.timer = setInterval(() => {
			if (swap === current && current.component === component && component.changed()) tui.requestRender();
		}, TRANSCRIPT_POLL_MS);
		current.timer.unref?.();
		current.scroll?.scrollToEnd();
		viewing = row.agentId;
		refresh();
		tui.requestRender(!current.scroll);
		return true;
	}

	/** Puts the conversation back where the agent's transcript is, at the scroll position it had. */
	function showMain(): void {
		const current = swap;
		if (!current) return;
		swap = null;
		if (current.timer) clearInterval(current.timer);
		const added = current.doc.children.filter((child) => child !== current.component);
		current.doc.children = [...current.saved, ...added];
		current.doc.mouseLayout = undefined;
		const { scroll, scrollState } = current;
		if (scroll && scrollState) {
			if (scrollState.following) scroll.scrollToEnd();
			else {
				// The ScrollView still measures the agent's transcript: give it the conversation's height before scrolling.
				scroll.updateLayout(current.doc.render(current.component.width).length, scroll.viewportHeight, () => current.tui.requestRender());
				scroll.scrollTo(scrollState.top);
			}
		}
		if (viewing === current.agentId) viewing = null;
		refresh();
		current.tui.requestRender(!scroll);
	}

	async function openAgent(row: Row): Promise<void> {
		if (!ctx) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (ctx.mode !== "tui") {
			const file = sessionFileOf(sessionId, row.agentId);
			ctx.ui.notify(`Agent ${row.type} ${row.agentId}: ${row.status}${file ? ` — transcript at ${file}` : ""}`, "info");
			return;
		}
		if (showAgent(row)) {
			blur();
			return;
		}
		await openOverlay(row, sessionId);
	}

	// --- transcript overlay, when the main view cannot be swapped ------------------------------------------------------------------

	async function openOverlay(row: Row, sessionId: string): Promise<void> {
		if (!ctx) return;
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
							cache = { width, size: now, lines: file ? transcriptLines(file, inner, theme).lines : [theme.fg("dim", "The agent has not started writing yet.")] };
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
							const head = [
								truncateToWidth(`${stateLine(current, theme)}  ${usageLine(current, theme)}`, Math.max(1, width - 4), "…"),
								"",
							];
							const more = lines.length > rowsAvail ? `  ${offset + 1}–${Math.min(lines.length, offset + rowsAvail)}/${lines.length}` : "";
							return frame(
								theme,
								width,
								`${current.type} › ${current.description || row.agentId}`,
								[...head, ...viewport(lines, offset, rowsAvail)],
								`↑↓ PgUp PgDn scroll · End follow · ${current.status === "running" ? "x stop · " : ""}${isForeground(current) ? "ctrl+b background · " : ""}Esc back${more}`,
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
							if (matchesKey(data, Key.ctrl("b"))) {
								if (isForeground(rows.get(row.agentId) ?? row)) pi.events.emit("subagents:background", row.agentId);
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
		sent.clear();
		scheduled = [];
		selected = -1;
		if (context.mode === "tui") context.ui.setEditorComponent((tui, theme, keybindings) => new AgentsEditor(tui, theme, keybindings));
		pi.events.emit("subagents:request", undefined);
		pi.events.emit("scheduled-tasks:request", undefined);
	});

	pi.on("session_shutdown", () => {
		showMain();
		if (ticker) clearInterval(ticker);
		ticker = null;
		if (ctx?.mode === "tui") ctx.ui.setEditorComponent(undefined);
		if (widgetShown) ctx?.ui.setWidget(WIDGET_KEY, undefined);
		widgetShown = false;
		widgetTui = null;
		ctx?.ui.setStatus(STATUS_KEY, undefined);
		ctx = null;
	});

	// While an agent is shown the prompt writes to it; otherwise what is sent shows the conversation again.
	pi.on("input", (event) => {
		if (event.source !== "interactive") return undefined;
		const current = swap;
		if (!current || !event.text.trim()) {
			showMain();
			return undefined;
		}
		const list = sent.get(current.agentId) ?? [];
		list.push({ text: event.text, after: current.component.users + list.length, at: Date.now() });
		sent.set(current.agentId, list);
		pi.events.emit("subagents:message", { agentId: current.agentId, text: event.text, images: event.images });
		current.scroll?.scrollToEnd();
		current.tui.requestRender();
		return { action: "handled" as const };
	});
	pi.on("user_bash", () => {
		showMain();
	});

	pi.events.on("subagents:state", onState);
	pi.events.on("scheduled-tasks:state", onScheduled);
	pi.events.on("statusline:status-click", (data) => {
		if ((data as { key?: unknown } | undefined)?.key === STATUS_KEY && selected < 0) focusPanel();
	});

	pi.registerCommand("tasks", {
		description: "List the agents of this session and open one, also to write to it",
		handler: async (_args, command) => {
			// Every agent the session still knows, not only those the panel lists: a finished one can be continued.
			const list = [...rows.values()].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt);
			if (list.length === 0) {
				command.ui.notify("No agents right now.", "info");
				return;
			}
			const labels = list.map((r) => `${r.type} — ${r.description || r.agentId} (${statusText(r)})`);
			const answer = await command.ui.select("Agents", labels);
			const index = answer ? labels.indexOf(answer) : -1;
			if (index >= 0) await openAgent(list[index]);
		},
	});
}
