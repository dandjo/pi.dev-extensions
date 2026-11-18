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
 * - Opening an agent shows its transcript in place of the conversation above the prompt, as Claude Code does; the
 *   panel shows the name of the agent shown in bold. The view follows the end while the agent works and scrolls like
 *   the conversation (wheel, PgUp PgDn).
 * - The transcript is drawn as Pi draws the conversation, with Pi's own components (UserMessageComponent,
 *   AssistantMessageComponent, ToolExecutionComponent) and the settings that shape them (hideThinkingBlock,
 *   outputPad, codeBlockIndent, images). A tool call is drawn with the renderers Pi resolves for that tool in the
 *   conversation (pi.registerToolRenderer: the resolution of each tool the conversation drew is kept, so other
 *   extensions' renderers, compact-tools.ts included, apply too), else with Pi's own definition for its built-in
 *   tools, else in Pi's plain form. Ctrl+O expands and collapses the view's tool calls, as it does the conversation's.
 * - While an agent is shown, the prompt writes to it (subagents:message): a working agent reads the message after
 *   its current step, a finished one starts again with it, and the message stands under the transcript until the
 *   agent has read it. Esc interrupts a working agent (subagents:interrupt), which then waits for an instruction;
 *   Esc again stops it, and Esc on an agent that does not work shows the conversation again. A ! command still
 *   goes to main and shows the conversation. An agent's report arrives in the conversation when it finishes.
 * - The swap exchanges the children of Pi's document container (the first component of the TUI, in fullscreen the
 *   child of the transcript's ScrollView) and restores them, and the conversation's scroll position, on return and at
 *   session_shutdown. Pi keeps writing to its own containers meanwhile. When Pi's tree does not have that shape, the
 *   transcript opens in an overlay instead (↑↓ PgUp PgDn scroll, x stops the agent, Esc returns).
 * - The transcript is read from the agent's session file under ~/.pi/agent/subagents/<session id>/, on from where it
 *   was read last, every TRANSCRIPT_POLL_MS. What the agent is writing right now comes from its events
 *   (subagents:watch, then subagents:event): its text, thinking, and tool arguments as they stream, its tools' output
 *   as it comes, until the file holds the message. Over RPC a message_update carries only the change, which is applied
 *   to the message. The panel replaces the editor with a subclass of Pi's own, so another extension that replaces the
 *   editor wins over it.
 * - Scheduled tasks (scheduled-tasks.ts, scheduled-tasks:state) are listed below the agents with their schedule and
 *   next run: Enter opens the task in its manager, x deletes it. The panel also exists while only tasks are scheduled.
 * - The mouse: the row under the pointer gets the selection marker, and when the pointer leaves the panel the marker
 *   goes back to the row selected with the keys (none while the prompt has the focus); Pi reports no leaving, so the
 *   TUI's mouse moves are observed (observeMouseMoves). A key that acts on a row (↑↓, Enter, x) acts on the one with
 *   the marker, as in the AskUserQuestion dialog. A click on a row opens it, a click on `main` returns to the
 *   prompt, and a click on "↓ to manage" in the status line (statusline:status-click) moves into the panel.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	CustomEditor,
	getAgentDir,
	getMarkdownTheme,
	ToolExecutionComponent,
	type ToolDefinition,
	type ToolRenderers,
	UserMessageComponent,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	isViewportTUI,
	Key,
	matchesKey,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import * as path from "node:path";

/**
 * The mouse moves of the terminal, for the pointer leaving a component: Pi hands a move only to the component under the
 * pointer, and its full-screen TUI takes mouse reports before onTerminalInput sees them. So the TUI's handleMouseEvent
 * is wrapped, once per TUI, and calls the observers registered on it with every move before Pi dispatches it. Without
 * that method (the regular TUI, another Pi version) nothing is observed. ask-user-question.ts and background-agents.ts
 * carry a copy of this block: change both alike, and keep the key and the shape.
 */
const MOUSE_MOVES = Symbol.for("pi.tui.mouse-moves.v1");
type MouseMoveObserver = (x: number, y: number) => void;
function observeMouseMoves(tui: object, observer: MouseMoveObserver): () => void {
	const host = tui as { [MOUSE_MOVES]?: Set<MouseMoveObserver>; handleMouseEvent?: unknown };
	let observers = host[MOUSE_MOVES];
	if (!observers) {
		if (typeof host.handleMouseEvent !== "function") return () => {};
		const original = host.handleMouseEvent as (raw: { button: number; x: number; y: number; release?: boolean }) => unknown;
		const set = new Set<MouseMoveObserver>();
		observers = set;
		host[MOUSE_MOVES] = set;
		host.handleMouseEvent = function (this: unknown, raw: { button: number; x: number; y: number; release?: boolean }) {
			// A move: the motion bit without the wheel bit, and not a button release.
			if (!raw.release && (raw.button & 32) !== 0 && (raw.button & 64) === 0) {
				for (const observe of [...set]) {
					try {
						observe(raw.x, raw.y);
					} catch {
						// an observer's failure must not cost the TUI its mouse
					}
				}
			}
			return original.call(this, raw);
		};
	}
	const own = observers;
	own.add(observer);
	return () => {
		own.delete(observer);
	};
}

const SESSIONS_ROOT = path.join(getAgentDir(), "subagents");
const WIDGET_KEY = "background-agents";
const STATUS_KEY = "background-agents";
const MAX_VISIBLE_ROWS = 5;
/** The panel's rows start where the editor's text and the status line do. */
const INDENT = " ";
const FINISHED_TTL_MS = 30_000;
const TICK_MS = 1_000;
const TRANSCRIPT_POLL_MS = 500;
const MAX_NAME_WIDTH = 28;
/** Pi's own tools, drawn with their definitions while Pi has not drawn a call of them in this session yet. */
const BUILT_IN_TOOLS: Record<string, (cwd: string) => ToolDefinition<any, any, any>> = {
	bash: createBashToolDefinition,
	read: createReadToolDefinition,
	edit: createEditToolDefinition,
	write: createWriteToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};
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

/**
 * A message to the agent as Pi draws the user's messages: a block in the user message colours across the width, one
 * column and one line of padding. note, when given, follows inside the block, dimmed.
 */
function userBlock(text: string, width: number, theme: Theme, note?: string): string[] {
	const inner = Math.max(1, width - 2);
	const fill = (line: string) => theme.bg("userMessageBg", ` ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} `);
	const body = text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(theme.fg("userMessageText", line), inner) : [""]));
	if (note) body.push(theme.fg("dim", note));
	return [fill(""), ...body.map(fill), fill("")];
}

/** The parts of Pi's settings the conversation is drawn with. */
interface Look {
	hideThinkingBlock: boolean;
	outputPad: number;
	showImages: boolean;
	imageWidthCells?: number;
	markdown: ReturnType<typeof getMarkdownTheme>;
}

/** What a transcript takes from the extension. */
interface TranscriptHost {
	tui: TUI;
	cwd: string;
	look: Look;
	/** The renderers Pi draws calls of this tool with, as far as they are known. */
	renderers(toolName: string): ToolRenderers | ToolDefinition<any, any, any> | undefined;
}

/** A message the subagent writes or wrote, with its tool calls, until the session file holds it. */
interface Streaming {
	component: AssistantMessageComponent;
	message: AssistantMessage;
	tools: ToolExecutionComponent[];
	ended: boolean;
	/** The arguments of the tool calls being written, as the text that came so far, by content index. */
	raw: Map<number, string>;
}

/**
 * The arguments of a tool call from the start of their JSON text, for the live view: what has come so far, with open
 * strings, arrays, and objects closed, and an unfinished last member dropped; undefined when nothing parses yet.
 */
function partialJson(text: string): Record<string, unknown> | undefined {
	const parse = (candidate: string) => {
		try {
			const value = JSON.parse(candidate);
			return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	};
	const closers: string[] = [];
	let inString = false;
	let escaped = false;
	/** Where the last member at any depth ended: the text up to there parses once closed. */
	let lastCut = -1;
	let cutClosers: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === "{") closers.push("}");
		else if (c === "[") closers.push("]");
		else if (c === "}" || c === "]") closers.pop();
		else if (c === ",") {
			lastCut = i;
			cutClosers = [...closers];
		}
	}
	const close = (list: string[]) => [...list].reverse().join("");
	// An escape the text breaks off in goes: a string closed after a lone backslash does not parse.
	const open = inString && escaped ? text.slice(0, -1) : text;
	return (
		parse(text) ??
		parse(open + (inString ? '"' : "") + close(closers)) ??
		(lastCut >= 0 ? parse(text.slice(0, lastCut) + close(cutClosers)) : undefined)
	);
}

/**
 * A subagent's transcript drawn with Pi's own components, as the conversation is: the messages of its session file in
 * their order, read on as the file grows, and after them what the subagent is writing right now, from its events
 * ("subagents:event"), until the file holds it. Pi writes a message to the file right after its message_end event.
 */
class Transcript {
	/** The components of the messages in the session file, in order. */
	private readonly body: Component[] = [];
	private readonly tail: Streaming[] = [];
	/** The tool calls without a result in the session file yet, by tool call id. */
	private readonly pending = new Map<string, ToolExecutionComponent>();
	/** The timestamps of the assistant messages in the session file: a late event of one of them is dropped. */
	private readonly filed = new Set<number>();
	private file: string | undefined;
	private offset = 0;
	/** The start of a line the file does not end yet. */
	private rest = Buffer.alloc(0);
	private expanded = false;
	/** The user messages in the session file. */
	users = 0;

	constructor(
		private readonly locate: () => string | undefined,
		private readonly host: TranscriptHost,
	) {}

	/** True once the session file exists. */
	get started(): boolean {
		return this.file !== undefined;
	}

	/** Reads what the session file gained since the last call; true when it gained a line. */
	read(): boolean {
		this.file ??= this.locate();
		if (!this.file) return false;
		let size: number;
		try {
			size = statSync(this.file).size;
		} catch {
			return false;
		}
		// A file written anew starts the transcript again.
		if (size < this.offset) this.restart();
		if (size === this.offset) return false;
		const chunk = Buffer.alloc(size - this.offset);
		let got = 0;
		let fd: number | undefined;
		try {
			fd = openSync(this.file, "r");
			got = readSync(fd, chunk, 0, chunk.length, this.offset);
		} catch {
			return false;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
		this.offset += got;
		const data = Buffer.concat([this.rest, chunk.subarray(0, got)]);
		let start = 0;
		let lines = 0;
		for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
			this.entry(data.subarray(start, end).toString("utf8"));
			start = end + 1;
			lines++;
		}
		this.rest = Buffer.from(data.subarray(start));
		return lines > 0;
	}

	private restart(): void {
		this.body.length = 0;
		this.pending.clear();
		this.filed.clear();
		this.offset = 0;
		this.rest = Buffer.alloc(0);
		this.users = 0;
	}

	private entry(line: string): void {
		if (!line.trim()) return;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			return;
		}
		if (entry?.type !== "message" || !entry.message) return;
		const message = entry.message;
		if (message.role === "user") {
			this.users++;
			const text =
				typeof message.content === "string"
					? message.content
					: (message.content ?? []).map((part: any) => (part.type === "text" ? part.text : "[image]")).join("\n");
			this.body.push(new UserMessageComponent(text, this.host.look.markdown, this.host.look.outputPad));
		} else if (message.role === "assistant") {
			this.assistant(message as AssistantMessage);
		} else if (message.role === "toolResult") {
			const tool = this.pending.get(message.toolCallId);
			if (!tool) return;
			tool.updateResult(message);
			this.pending.delete(message.toolCallId);
		}
	}

	/** An assistant message of the session file: the one written live takes its place, with its tool calls. */
	private assistant(message: AssistantMessage): void {
		this.filed.add(message.timestamp);
		let at = this.tail.findIndex((s) => s.message.timestamp === message.timestamp);
		if (at < 0 && this.tail[0]?.ended) at = 0;
		let component: AssistantMessageComponent;
		if (at >= 0) {
			component = this.tail[at].component;
			component.updateContent(message, false);
			this.tail.splice(0, at + 1);
		} else {
			component = new AssistantMessageComponent(message, this.host.look.hideThinkingBlock, this.host.look.markdown, undefined, this.host.look.outputPad);
		}
		this.body.push(component);
		const failed = message.stopReason === "aborted" || message.stopReason === "error";
		for (const part of message.content ?? []) {
			if (part.type !== "toolCall") continue;
			const tool = this.pending.get(part.id) ?? this.tool(part.name, part.id, part.arguments);
			this.body.push(tool);
			if (failed) {
				const text = message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error");
				tool.updateResult({ content: [{ type: "text", text }], isError: true });
				this.pending.delete(part.id);
			} else {
				this.pending.set(part.id, tool);
			}
		}
	}

	private tool(name: string, id: string, args: unknown): ToolExecutionComponent {
		const look = this.host.look;
		const tool = new ToolExecutionComponent(
			name,
			id,
			args,
			{ showImages: look.showImages, imageWidthCells: look.imageWidthCells, outputPad: look.outputPad },
			this.host.renderers(name),
			this.host.tui,
			this.host.cwd,
		);
		tool.setExpanded(this.expanded);
		return tool;
	}

	/** The message being written: the last one of the tail that has not ended, or a new one for `message`. */
	private streaming(message: AssistantMessage): Streaming {
		const last = this.tail.at(-1);
		if (last && !last.ended) return last;
		const component = new AssistantMessageComponent(undefined, this.host.look.hideThinkingBlock, this.host.look.markdown, undefined, this.host.look.outputPad);
		const streaming: Streaming = { component, message: { ...message, content: [...(message.content ?? [])] }, tools: [], ended: false, raw: new Map() };
		this.tail.push(streaming);
		return streaming;
	}

	/**
	 * A change of the message being written, from the RPC stream: there message_update carries only what changed (the
	 * docs' "Reconstruct streaming messages"), the deltas of its text, thinking, and tool call blocks. False when the
	 * update changes nothing shown.
	 */
	private apply(streaming: Streaming, update: any): boolean {
		const content = streaming.message.content as any[];
		const at = update?.contentIndex;
		if (typeof at !== "number") return false;
		const block = content[at];
		switch (update.type) {
			case "text_start":
				content[at] = { type: "text", text: "" };
				return true;
			case "text_delta":
				if (block?.type !== "text") return false;
				content[at] = { ...block, text: block.text + String(update.delta ?? "") };
				return true;
			case "text_end":
				content[at] = { ...block, type: "text", text: String(update.content ?? block?.text ?? "") };
				return true;
			case "thinking_start":
				content[at] = { type: "thinking", thinking: "" };
				return true;
			case "thinking_delta":
				if (block?.type !== "thinking") return false;
				content[at] = { ...block, thinking: block.thinking + String(update.delta ?? "") };
				return true;
			case "thinking_end":
				content[at] = { ...block, type: "thinking", thinking: String(update.content ?? block?.thinking ?? "") };
				return true;
			case "toolcall_start":
				content[at] = { type: "toolCall", id: String(update.id ?? ""), name: String(update.toolName ?? ""), arguments: {} };
				streaming.raw.set(at, "");
				return true;
			case "toolcall_delta": {
				if (block?.type !== "toolCall") return false;
				const raw = (streaming.raw.get(at) ?? "") + String(update.delta ?? "");
				streaming.raw.set(at, raw);
				const args = partialJson(raw);
				if (!args) return false;
				content[at] = { ...block, arguments: args };
				return true;
			}
			case "toolcall_end":
				if (!update.toolCall) return false;
				content[at] = update.toolCall;
				streaming.raw.delete(at);
				return true;
			default:
				return false;
		}
	}

	/** The tool calls of the message being written: new ones get their component, known ones their arguments. */
	private syncTools(streaming: Streaming): void {
		for (const part of streaming.message.content ?? []) {
			if (part.type !== "toolCall" || !part.id) continue;
			const known = this.pending.get(part.id);
			if (known) {
				known.updateArgs(part.arguments);
				continue;
			}
			const tool = this.tool(part.name, part.id, part.arguments);
			streaming.tools.push(tool);
			this.pending.set(part.id, tool);
		}
	}

	/** An event of the subagent as it comes, handled as Pi handles its own; true when the transcript changed. */
	event(event: any): boolean {
		switch (event?.type) {
			case "message_start": {
				const message = event.message as AssistantMessage | undefined;
				if (message?.role !== "assistant" || this.filed.has(message.timestamp)) return false;
				const streaming = this.streaming(message);
				streaming.component.updateContent(streaming.message, true);
				this.syncTools(streaming);
				return true;
			}
			case "message_update": {
				const streaming = this.tail.at(-1);
				if (!streaming || streaming.ended) return false;
				// In process the event carries the whole message; over RPC only the change.
				const whole = event.message as AssistantMessage | undefined;
				if (whole?.role === "assistant") streaming.message = { ...whole, content: [...(whole.content ?? [])] };
				else if (!this.apply(streaming, event.assistantMessageEvent)) return false;
				if (event.usage) streaming.message.usage = event.usage;
				streaming.component.updateContent(streaming.message, true);
				this.syncTools(streaming);
				return true;
			}
			case "message_end": {
				const message = event.message as AssistantMessage | undefined;
				if (message?.role !== "assistant" || this.filed.has(message.timestamp)) return false;
				const streaming = this.streaming(message);
				streaming.message = message;
				streaming.ended = true;
				streaming.component.updateContent(message, false);
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					const text = message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error");
					for (const tool of streaming.tools) tool.updateResult({ content: [{ type: "text", text }], isError: true });
				} else {
					for (const tool of streaming.tools) tool.setArgsComplete();
				}
				// The file holds the message by now, as a rule: it takes its place at once.
				this.read();
				return true;
			}
			case "tool_execution_start": {
				if (event.parentToolCallId) return false;
				let tool = this.pending.get(event.toolCallId);
				if (!tool) {
					tool = this.tool(event.toolName, event.toolCallId, event.args);
					this.pending.set(event.toolCallId, tool);
					const last = this.tail.at(-1);
					if (last) last.tools.push(tool);
					else this.body.push(tool);
				}
				tool.markExecutionStarted();
				return true;
			}
			case "tool_execution_update": {
				const tool = this.pending.get(event.toolCallId);
				if (!tool) return false;
				tool.updateResult({ ...event.partialResult, isError: false }, true);
				return true;
			}
			case "tool_execution_end": {
				const tool = this.pending.get(event.toolCallId);
				if (!tool) return false;
				tool.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
				return true;
			}
			case "agent_end": {
				// A message cut off before its end does not reach the file: it goes, as in Pi's own view.
				const cut = this.tail.filter((s) => !s.ended);
				if (cut.length === 0) return false;
				const tools = new Set(cut.flatMap((s) => s.tools));
				for (const [id, tool] of this.pending) if (tools.has(tool)) this.pending.delete(id);
				this.tail.splice(0, this.tail.length, ...this.tail.filter((s) => s.ended));
				return true;
			}
			default:
				return false;
		}
	}

	private components(): Component[] {
		return [...this.body, ...this.tail.flatMap((s) => [s.component, ...s.tools])];
	}

	/** Opens or closes the tool output, as ctrl+o does in the conversation. */
	toggleExpanded(): void {
		this.expanded = !this.expanded;
		for (const component of this.components()) (component as { setExpanded?: (expanded: boolean) => void }).setExpanded?.(this.expanded);
	}

	render(width: number): string[] {
		return this.components().flatMap((component) => component.render(width));
	}

	invalidate(): void {
		for (const component of this.components()) component.invalidate();
	}
}

// --- Extension -----------------------------------------------------------------------------------------------------------------

/**
 * Framed, scrollable boxes for the extensions that show more than a notification can hold: overlays for /hooks,
 * /agents, /cron, and /memory, and the frame and scrolling of the boxes /btw and the /diff dialog show above the
 * prompt.
 *
 * btw.ts, claude-code-hooks.ts, claude-remote-control.ts, diff.ts, memory.ts, scheduled-tasks.ts, subagents.ts carry a copy
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
	/** The row under the pointer (selection index), which has the marker while the pointer is there. */
	let hovered: number | undefined;
	let stopWatching: (() => void) | null = null;
	let scroll = 0;
	let viewing: string | null = null;
	let widgetShown = false;
	let widgetTui: TUI | null = null;
	let editorTui: TUI | null = null;
	let ticker: NodeJS.Timeout | null = null;
	/** What was written to an agent from its transcript and is not in its session file yet, by agentId. */
	const sent = new Map<string, { text: string; after: number; at: number }[]>();
	/**
	 * The renderers Pi resolved for each tool it drew in this session, as the remaining resolvers and the tool give them.
	 */
	const resolved = new Map<string, () => ToolRenderers | undefined>();
	/** The transcript shown now, which takes the events of its subagent as they come. */
	let watched: { agentId: string; transcript: Transcript; tui: TUI } | null = null;

	// Pi resolves a tool's renderers whenever it draws a call of it: the resolution is kept, so a subagent's calls of the
	// tool are drawn as the conversation draws them.
	pi.registerToolRenderer((toolName, next) => {
		resolved.set(toolName, next);
		return next();
	});

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
				// The pointer leaving the panel: every move first clears the row under the pointer, and the panel's own move
				// handler, which Pi calls right after for a move over the panel, sets it again. A move elsewhere leaves it clear.
				stopWatching?.();
				stopWatching = observeMouseMoves(tui, () => {
					if (hovered === undefined) return;
					hovered = undefined;
					queueMicrotask(() => {
						if (hovered === undefined) widgetTui?.requestRender();
					});
				});
				return {
					render: (width: number) => renderPanel(width, theme),
					handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
						if (event.type === "move") {
							const over = panelLines[event.y];
							if (over === hovered) return undefined;
							hovered = over;
							widgetTui?.requestRender();
							return { handled: true, render: true };
						}
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
						stopWatching?.();
						stopWatching = null;
						hovered = undefined;
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
		// The marker: on the row under the pointer, else on the row selected with the keys.
		const marked = hovered !== undefined && hovered <= list.length ? hovered : selected;
		const lines: string[] = [];
		const total = list.length;
		if (selected - 1 < scroll) scroll = Math.max(0, selected - 1);
		if (selected - 1 >= scroll + MAX_VISIBLE_ROWS) scroll = selected - MAX_VISIBLE_ROWS;
		scroll = Math.max(0, Math.min(scroll, Math.max(0, total - MAX_VISIBLE_ROWS)));
		const visible = list.slice(scroll, scroll + MAX_VISIBLE_ROWS);

		// The selected row as Pi's own lists and the AskUserQuestion dialog mark theirs: an arrow, the accent colour, and
		// the selection background across the width.
		const pointer = (isSelected: boolean) => (isSelected ? theme.fg("accent", "→ ") : "  ");
		const inner = Math.max(0, width - INDENT.length);
		const line = (text: string, isSelected: boolean) => {
			const cut = INDENT + truncateToWidth(text, inner, "…");
			return isSelected ? theme.bg("selectedBg", cut + " ".repeat(Math.max(0, width - visibleWidth(cut)))) : cut;
		};

		// No status marks of their own: the selection has Pi's arrow, the conversation shown has a bold name, and the
		// state is the word at the end of a row.
		const mainName = viewing ? "main" : theme.bold("main");
		let main = `${pointer(marked === 0)}${marked === 0 ? theme.fg("accent", mainName) : focused || !viewing ? mainName : theme.fg("dim", mainName)}`;
		if (scroll > 0) {
			const more = theme.fg("dim", `↑ ${scroll} more`);
			main = `${truncateToWidth(main, Math.max(0, inner - visibleWidth(more) - 1), "…")} ${more}`;
		}
		panelLines[lines.length] = 0;
		lines.push(line(main, marked === 0));

		const label = (entry: Entry) => (entry.kind === "agent" ? entry.row.type : entry.task.kind === "loop wakeup" ? "↻ loop" : "↻ scheduled");
		const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(4, ...list.map((e) => label(e).length)));
		const statuses = visible.map((e) => (e.kind === "agent" ? statusText(e.row) : `${e.task.kind === "loop wakeup" ? "" : `${e.task.schedule} · `}next ${e.task.next}`));
		const statusWidth = Math.max(...statuses.map((s) => s.length), 0);
		visible.forEach((entry, i) => {
			const index = scroll + i + 1;
			const isSelected = marked === index;
			const name = truncateToWidth(label(entry), nameWidth, "…").padEnd(nameWidth);
			const descWidth = Math.max(8, inner - 2 - nameWidth - 3 - statusWidth - 2);
			const desc = truncateToWidth((entry.kind === "agent" ? entry.row.description : entry.task.prompt) || "", descWidth, "…").padEnd(descWidth);
			const status = statuses[i].padStart(statusWidth);
			panelLines[lines.length] = index;
			const shown = entry.kind === "agent" && entry.row.agentId === viewing;
			if (isSelected) {
				const text = `${shown ? theme.bold(name) : name} › ${desc}  ${status}`;
				lines.push(line(`${pointer(true)}${theme.fg("accent", text)}`, true));
				return;
			}
			// Finished agents and, while the panel is not in use, every row recede, all but the agent shown.
			const recede = entry.kind === "scheduled" ? !focused : !shown && (entry.row.status === "completed" || !focused);
			const tone = (text: string) => (recede ? theme.fg("dim", text) : text);
			const state = entry.kind === "agent" ? statusColor(entry.row, status, theme, recede) : tone(status);
			lines.push(line(`${pointer(false)}${shown ? theme.bold(name) : tone(name)} ${theme.fg("dim", "›")} ${tone(desc)}  ${state}`, false));
		});
		if (scroll + visible.length < total) lines.push(INDENT + theme.fg("dim", `    ↓ ${total - scroll - visible.length} more`));
		// A rule under the panel: it stands between two rules like the editor, apart from the footer below.
		lines.push(theme.fg("borderMuted", "─".repeat(Math.max(0, width))));
		return lines;
	}

	/**
	 * The state at the end of an agent's row in the colour of the state: what needs you, what failed, what is done; a
	 * running agent's in the tone of its row.
	 */
	function statusColor(row: Row, status: string, theme: Theme, recede: boolean): string {
		if (row.status === "running") {
			if (row.waiting) return theme.fg("warning", status);
			const text = recede ? theme.fg("dim", status) : status;
			return text.replace(/\d+ queued/, (m) => theme.fg("warning", m));
		}
		if (row.status === "completed") return theme.fg("success", status);
		return theme.fg("error", status);
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
		// A key that acts on a row acts on the one with the marker, as in the AskUserQuestion dialog: the row under the
		// pointer becomes the one selected with the keys.
		const acts =
			matchesKey(data, Key.down) ||
			matchesKey(data, Key.up) ||
			keybindings.matches(data, "tui.editor.cursorDown") ||
			keybindings.matches(data, "tui.editor.cursorUp") ||
			data === "\x0e" ||
			data === "\x10" ||
			matchesKey(data, Key.enter) ||
			data === "x";
		if (acts && hovered !== undefined && hovered <= list.length) selected = hovered;
		if (acts) hovered = undefined;
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
			if (swap && this.kb.matches(data, "app.tools.expand")) {
				swap.component.transcript.toggleExpanded();
				swap.tui.requestRender();
				return;
			}
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
		if (current.status === "completed") return theme.fg("success", `✓ completed · ${elapsed(current.durationMs ?? 0)}`);
		return theme.fg("error", `${current.status === "aborted" ? "stopped" : "✗ failed"}${current.error ? ` · ${current.error.split("\n")[0]}` : ""}`);
	}

	function usageLine(current: Row, theme: Theme): string {
		return theme.fg("dim", `${compact(current.tokens)} tokens · ${current.toolCount} tool${current.toolCount === 1 ? "" : "s"} · ${current.model.split("/").at(-1)}`);
	}

	/** A transcript of the agent in `row`, drawn with Pi's settings for `tui`. */
	function transcriptFor(row: Row, sessionId: string, tui: TUI): Transcript {
		const settings = pi.getSettings();
		const markdown = getMarkdownTheme();
		const indent = settings.markdown?.codeBlockIndent;
		const cwd = ctx?.cwd ?? process.cwd();
		const builtIn = new Map<string, ToolDefinition<any, any, any>>();
		return new Transcript(() => sessionFileOf(sessionId, row.agentId), {
			tui,
			cwd,
			look: {
				hideThinkingBlock: settings.hideThinkingBlock ?? false,
				outputPad: settings.outputPad === 0 ? 0 : 1,
				showImages: settings.terminal?.showImages ?? true,
				imageWidthCells: settings.terminal?.imageWidthCells,
				markdown: indent === undefined ? markdown : { ...markdown, codeBlockIndent: indent },
			},
			renderers: (name) => {
				const next = resolved.get(name);
				if (next) return next();
				const make = BUILT_IN_TOOLS[name];
				if (!make) return undefined;
				if (!builtIn.has(name)) builtIn.set(name, make(cwd));
				return builtIn.get(name);
			},
		});
	}

	/** The first key bound to `keybinding`, for a help line. */
	function keyOf(keybindings: KeybindingsManager, keybinding: Parameters<KeybindingsManager["getKeys"]>[0]): string {
		return keybindings.getKeys(keybinding)[0] ?? "ctrl+o";
	}

	/** Takes the events of the agent a transcript shows as they come (subagents:watch); null ends that. */
	function watch(next: { agentId: string; transcript: Transcript; tui: TUI } | null): void {
		watched = next;
		pi.events.emit("subagents:watch", next?.agentId ?? null);
	}

	/** The transcript's lines for `width`, or what stands there, after `pad`, while it has none. */
	function transcriptBody(transcript: Transcript, width: number, theme: Theme, pad = ""): string[] {
		if (!transcript.started) return [pad + theme.fg("dim", "The agent has not started writing yet.")];
		const lines = transcript.render(width);
		return lines.length ? lines : [pad + theme.fg("dim", "Nothing yet.")];
	}

	/** An agent's transcript in place of the conversation: a header, then its messages as the conversation draws them. */
	class AgentView implements Component {
		/** The width of the last render, which is the transcript's content width. */
		width = 80;

		/** The user messages in the session file at the last render. */
		get users(): number {
			return this.transcript.users;
		}

		constructor(
			readonly row: Row,
			readonly transcript: Transcript,
		) {}

		render(width: number): string[] {
			this.width = width;
			const theme = ctx?.ui.theme;
			if (!theme) return [];
			const inner = Math.max(1, width - 2);
			this.transcript.read();
			const current = rows.get(this.row.agentId) ?? this.row;
			const working = current.status === "running";
			const help = !working
				? "The prompt writes to this agent, which then goes on · Esc shows the conversation again"
				: current.waiting === "instruction"
					? "The prompt gives this agent its instruction · Esc stops it"
					: "The prompt writes to this agent · Esc interrupts it · ↓ then Enter on main shows the conversation again";
			const head = [
				`${theme.fg("accent", theme.bold(current.type))} ${theme.fg("dim", "›")} ${current.description || current.agentId}`,
				`${stateLine(current, theme)}  ${usageLine(current, theme)}`,
				theme.fg("dim", help),
			];
			// What the user wrote and the agent has not read: it reads a message after its current step.
			const now = Date.now();
			const users = this.transcript.users;
			const unread = (sent.get(this.row.agentId) ?? []).filter((m) => users <= m.after && now - m.at < SENT_TTL_MS);
			if (unread.length) sent.set(this.row.agentId, unread);
			else sent.delete(this.row.agentId);
			const waiting = unread.flatMap((m) => [
				"",
				...userBlock(m.text.trim(), inner, theme, working ? "not read yet: the agent reads it after its current step" : "starting the agent…").map((line) => ` ${line}`),
			]);
			const body = transcriptBody(this.transcript, width, theme, " ");
			return ["", ...head.map((line) => truncateToWidth(` ${line}`, width, "…")), "", ...body, ...waiting];
		}

		invalidate(): void {
			this.transcript.invalidate();
		}
	}

	/** Shows the agent's transcript where the conversation is; false when Pi's tree is not the expected one. */
	function showAgent(row: Row): boolean {
		const tui = editorTui ?? widgetTui;
		if (!ctx || !tui) return false;
		const component = new AgentView(row, transcriptFor(row, ctx.sessionManager.getSessionId(), tui));
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
			if (swap === current && current.component === component && component.transcript.read()) tui.requestRender();
		}, TRANSCRIPT_POLL_MS);
		current.timer.unref?.();
		watch({ agentId: row.agentId, transcript: component.transcript, tui });
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
		if (watched?.transcript === current.component.transcript) watch(null);
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
				(tui, theme, keybindings, done) => {
					const transcript = transcriptFor(row, sessionId, tui);
					watch({ agentId: row.agentId, transcript, tui });
					let offset = 0;
					let follow = true;
					let lastWidth = 80;
					const body = (width: number) => {
						lastWidth = width;
						transcript.read();
						return transcriptBody(transcript, Math.max(1, width - 4), theme);
					};
					const timer = setInterval(() => {
						if (transcript.read()) tui.requestRender();
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
								`↑↓ PgUp PgDn scroll · End follow · ${keyOf(keybindings, "app.tools.expand")} tool output · ${current.status === "running" ? "x stop · " : ""}${isForeground(current) ? "ctrl+b background · " : ""}Esc back${more}`,
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
							if (keybindings.matches(data, "app.tools.expand")) {
								transcript.toggleExpanded();
								tui.requestRender();
								return;
							}
							const lines = body(lastWidth);
							const rowsAvail = Math.max(3, bodyRows(tui) - 2);
							const next = scrollKey(data, offset, lines.length, rowsAvail);
							if (next !== undefined) {
								offset = next;
								follow = next >= Math.max(0, lines.length - rowsAvail);
								tui.requestRender();
							}
						},
						invalidate(): void {
							transcript.invalidate();
						},
						dispose(): void {
							clearInterval(timer);
							if (watched?.transcript === transcript) watch(null);
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
		hovered = undefined;
		if (context.mode === "tui") context.ui.setEditorComponent((tui, theme, keybindings) => new AgentsEditor(tui, theme, keybindings));
		pi.events.emit("subagents:request", undefined);
		pi.events.emit("scheduled-tasks:request", undefined);
	});

	pi.on("session_shutdown", () => {
		showMain();
		if (ticker) clearInterval(ticker);
		ticker = null;
		if (ctx?.mode === "tui") ctx.ui.setEditorComponent(undefined);
		stopWatching?.();
		stopWatching = null;
		hovered = undefined;
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
	pi.events.on("subagents:event", (data) => {
		const { agentId, event } = (data ?? {}) as { agentId?: unknown; event?: unknown };
		const current = watched;
		if (!current || agentId !== current.agentId) return;
		if (current.transcript.event(event)) current.tui.requestRender();
	});
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
