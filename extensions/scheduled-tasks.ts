/**
 * Session-scoped scheduled tasks: Claude Code's /loop and its cron tools CronCreate, CronList, CronDelete, and
 * ScheduleWakeup (https://code.claude.com/docs/en/scheduled-tasks).
 *
 * - /loop <interval> <prompt> runs the prompt now and then on a fixed schedule ("5m", "2h", "every 30 minutes";
 *   s/m/h/d). An interval that no cron step fits is rounded to the nearest one that does, and said so.
 * - /loop <prompt> is self-paced: after each iteration the model calls ScheduleWakeup with a delay between one minute
 *   and one hour, or with stop: true when the work is done. An iteration that does neither gets one fallback wakeup
 *   20 minutes later; when that one does not reschedule either, the loop ends. Esc on an empty editor while the loop
 *   waits, or /loop stop, cancels it.
 * - /loop alone runs .claude/loop.md (or .pi/loop.md, ~/.claude/loop.md, ~/.pi/agent/loop.md), read fresh at every
 *   iteration, else a built-in maintenance prompt.
 * - The model schedules tasks itself with CronCreate (5-field cron, local time, recurring or one-shot), lists them with
 *   CronList, and cancels them with CronDelete. /cron does the same by hand: /cron, /cron add|once <m h dom mon dow>
 *   <prompt>, /cron delete <id>|all.
 * - In the interactive terminal /cron opens the task manager, a box above the prompt as /btw shows it: the tasks by
 *   next run, ↑↓ or the pointer select, Enter or a click shows a task (schedule, next run, expiry, the whole
 *   prompt), x deletes it, Esc goes back and closes. A click on "↻ … scheduled" in the status line opens it too (statusline:status-click), and background-agents.ts
 *   lists the tasks in its panel below the prompt (↓ from the prompt), from the state this file publishes
 *   (scheduled-tasks:state; scheduled-tasks:open and scheduled-tasks:delete act on a task). /cron from the Claude app
 *   comes through scheduled-tasks:command and is answered there as text, the list included.
 * - Tasks fire only while this session is open and idle, between turns, one at a time and without catch-up for missed
 *   runs. Recurring tasks expire after 7 days (one last run, then they are deleted); a session holds at most 50.
 *   Tasks are stored in the session and restored on resume, except expired ones, one-shots already due, and
 *   self-paced loops. CLAUDE_CODE_DISABLE_CRON=1 turns all of it off.
 */

import { type ExtensionAPI, type ExtensionContext, getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_TASKS = 50;
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const TICK_MS = 1000;
const FALLBACK_WAKEUP_S = 20 * 60;
const MIN_WAKEUP_S = 60;
const MAX_WAKEUP_S = 3600;
const LOOP_FILE_MAX = 25_000;
const LOOP_FILE = "\u0000loop.md";

const MAINTENANCE_PROMPT = `Maintenance pass, in this order; stop at the first item that has work:
1. Continue any unfinished work from this conversation.
2. Tend to the current branch's merge or pull request: new review comments, failed CI runs, merge conflicts.
3. When nothing else is pending, run one cleanup pass on code this session touched: look for bugs or simplifications and fix them.
Do not start new initiatives outside this scope. Irreversible actions such as pushing, merging, or deleting proceed only when they continue something the conversation already authorized. If everything is quiet, say so in one line.`;

interface Task {
	id: string;
	cron: string;
	prompt: string;
	recurring: boolean;
	createdAt: number;
	nextRun: number;
	/** Self-paced loop wakeup: the loop it belongs to. */
	loop?: string;
}

/** A scheduled task as other extensions see it (scheduled-tasks:state). */
export interface ScheduledTaskView {
	id: string;
	kind: "recurring" | "one-shot" | "loop wakeup";
	/** The schedule in words where it has a common shape ("daily at 11:00"), else the cron expression. */
	schedule: string;
	nextRun: number;
	/** nextRun as the status line shows it. */
	next: string;
	prompt: string;
}

interface SelfLoop {
	id: string;
	prompt: string;
	/** The current iteration called ScheduleWakeup (or stop). */
	rescheduled: boolean;
	/** The pending wakeup is the fallback after an iteration that did not reschedule. */
	fallback: boolean;
	/** An iteration of this loop is running. */
	iterating: boolean;
}

// --- Cron --------------------------------------------------------------------------------------------------------

interface CronSpec {
	minute: number[];
	hour: number[];
	dom: Set<number>;
	month: Set<number>;
	dow: Set<number>;
	domAny: boolean;
	dowAny: boolean;
}

function parseField(field: string, min: number, max: number, name: string): number[] {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		const match = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
		if (!match) throw new Error(`invalid ${name} field "${field}"`);
		const step = match[4] ? Number(match[4]) : 1;
		if (step < 1) throw new Error(`invalid step in ${name} field "${field}"`);
		let from = min;
		let to = max;
		if (match[1] !== "*") {
			from = Number(match[2]);
			to = match[3] !== undefined ? Number(match[3]) : match[4] ? max : from;
		}
		if (from < min || to > max || from > to) throw new Error(`${name} value out of range in "${field}" (${min}-${max})`);
		for (let v = from; v <= to; v += step) values.add(v);
	}
	return [...values].sort((a, b) => a - b);
}

function parseCron(expression: string): CronSpec {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error(`a cron expression has 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
	const [m, h, dom, mon, dow] = fields;
	return {
		minute: parseField(m, 0, 59, "minute"),
		hour: parseField(h, 0, 23, "hour"),
		dom: new Set(parseField(dom, 1, 31, "day-of-month")),
		month: new Set(parseField(mon, 1, 12, "month")),
		dow: new Set(parseField(dow, 0, 7, "day-of-week").map((d) => (d === 7 ? 0 : d))),
		domAny: dom === "*",
		dowAny: dow === "*",
	};
}

function dayMatches(spec: CronSpec, date: Date): boolean {
	if (!spec.month.has(date.getMonth() + 1)) return false;
	const dom = spec.dom.has(date.getDate());
	const dow = spec.dow.has(date.getDay());
	if (spec.domAny && spec.dowAny) return true;
	if (spec.domAny) return dow;
	if (spec.dowAny) return dom;
	return dom || dow;
}

/** The first minute after `after` that matches, in local time; undefined when none within five years. */
function nextRun(spec: CronSpec, after: number): number | undefined {
	const start = new Date(after);
	start.setSeconds(0, 0);
	start.setMinutes(start.getMinutes() + 1);
	const day = new Date(start);
	day.setHours(0, 0, 0, 0);
	for (let i = 0; i < 366 * 5; i++) {
		if (dayMatches(spec, day)) {
			const sameDay = day.getTime() === new Date(start).setHours(0, 0, 0, 0);
			for (const hour of spec.hour) {
				if (sameDay && hour < start.getHours()) continue;
				for (const minute of spec.minute) {
					if (sameDay && hour === start.getHours() && minute < start.getMinutes()) continue;
					const at = new Date(day);
					at.setHours(hour, minute, 0, 0);
					return at.getTime();
				}
			}
		}
		day.setDate(day.getDate() + 1);
	}
	return undefined;
}

/**
 * The locale of a POSIX category as LC_ALL, the category's own variable, or LANG name it (de_AT.UTF-8 is de-AT), the
 * first one set winning; undefined for C and POSIX or an unknown one, which leaves Intl its default. Node's Intl reads
 * LANG alone, so LC_TIME=de_AT under LANG=en_US would otherwise show US dates. claude-usage.ts carries a copy of this
 * function: change them alike.
 */
function posixLocale(category: "LC_TIME" | "LC_MONETARY"): string | undefined {
	for (const value of [process.env.LC_ALL, process.env[category], process.env.LANG]) {
		if (!value) continue;
		const tag = value.split(/[.@]/)[0].replace(/_/g, "-");
		if (tag === "C" || tag === "POSIX") return undefined;
		try {
			return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0 ? tag : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** Times and dates in the locale of LC_TIME (or LC_ALL, else LANG). */
const TIME_LOCALE = posixLocale("LC_TIME");

/** The time of day in the locale ("21:29", "09:29 PM"). */
function timeOfDay(date: Date): string {
	return date.toLocaleTimeString(TIME_LOCALE, { hour: "2-digit", minute: "2-digit" });
}

function clock(ms: number): string {
	const date = new Date(ms);
	const today = new Date().toDateString() === date.toDateString();
	const time = timeOfDay(date);
	return today ? time : `${date.toLocaleDateString(TIME_LOCALE, { weekday: "short", day: "2-digit", month: "2-digit" })} ${time}`;
}

function zone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The schedule in words for the common shapes of a cron expression, else the expression itself. */
function describeCron(cron: string): string {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) return cron;
	const [m, h, dom, mon, dow] = fields;
	const num = (s: string) => /^\d+$/.test(s);
	const step = (s: string) => s.match(/^\*\/(\d+)$/)?.[1];
	const at = () => timeOfDay(new Date(2000, 0, 1, Number(h), Number(m)));
	const everyDay = dom === "*" && mon === "*";
	if (everyDay && dow === "*") {
		if (m === "*" && h === "*") return "every minute";
		if (step(m) && h === "*") return `every ${step(m)} min`;
		if (num(m) && h === "*") return `hourly at :${m.padStart(2, "0")}`;
		if (num(m) && step(h)) return `every ${step(h)} h at :${m.padStart(2, "0")}`;
		if (num(m) && num(h)) return `daily at ${at()}`;
	}
	if (everyDay && num(m) && num(h) && /^[0-7]$/.test(dow)) return `${WEEKDAYS[Number(dow) % 7]} at ${at()}`;
	if (everyDay && num(m) && num(h) && dow === "1-5") return `weekdays at ${at()}`;
	if (step(dom) && mon === "*" && dow === "*" && num(m) && num(h)) return `every ${step(dom)} days at ${at()}`;
	if (num(dom) && num(mon) && dow === "*" && num(m) && num(h)) {
		const day = new Date(2000, Number(mon) - 1, Number(dom)).toLocaleDateString(TIME_LOCALE, { day: "2-digit", month: "2-digit" });
		return `on ${day} at ${at()}`;
	}
	return cron;
}

// --- Intervals ---------------------------------------------------------------------------------------------------

const MINUTE_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];

function nearest(value: number, steps: number[]): number {
	return steps.reduce((best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best), steps[0]);
}

const UNITS: Record<string, number> = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400 };

/** Splits "/loop" arguments into an interval in seconds (leading "5m" or trailing "every 2 hours") and the prompt. */
function splitInterval(args: string): { seconds?: number; prompt: string } {
	const lead = args.match(/^(\d+)\s*(s|secs?|m|mins?|h|hrs?|d)\b\s*/i);
	if (lead) return { seconds: Number(lead[1]) * UNITS[lead[2].toLowerCase()], prompt: args.slice(lead[0].length).trim() };
	const trail = args.match(/\s*\bevery\s+(?:(\d+)\s*)?(seconds?|minutes?|mins?|hours?|hrs?|days?|s|m|h|d)\s*$/i);
	if (trail) {
		const unit = trail[2].toLowerCase();
		return { seconds: Number(trail[1] ?? 1) * (UNITS[unit] ?? UNITS[unit.replace(/s$/, "")]), prompt: args.slice(0, trail.index).trim() };
	}
	return { prompt: args.trim() };
}

/** A cron expression for "every `seconds`", rounded to a clean cron step, with a note when it was rounded. */
function intervalCron(seconds: number): { cron: string; label: string; note?: string } {
	const now = new Date();
	const minutes = Math.max(1, Math.ceil(seconds / 60));
	const asked = seconds < 60 ? `${seconds}s` : seconds % 3600 === 0 && seconds < 86400 ? `${seconds / 3600}h` : seconds % 86400 === 0 ? `${seconds / 86400}d` : `${minutes}m`;
	if (minutes < 60) {
		const step = nearest(minutes, MINUTE_STEPS);
		const cron = step === 1 ? "* * * * *" : `*/${step} * * * *`;
		const note =
			step !== minutes
				? `${asked} does not map to a clean cron step; running every ${step}m instead.`
				: seconds % 60 !== 0
					? `Cron has one-minute granularity; ${seconds}s is rounded up to ${step}m.`
					: undefined;
		return { cron, label: `every ${step}m`, note };
	}
	if (minutes < 24 * 60) {
		const hours = Math.max(1, Math.round(minutes / 60));
		const step = nearest(hours, HOUR_STEPS);
		const note = step * 60 !== minutes ? `${asked} does not map to a clean cron step; running every ${step}h instead.` : undefined;
		return { cron: `${now.getMinutes()} ${step === 1 ? "*" : `*/${step}`} * * *`, label: `every ${step}h`, note };
	}
	const days = Math.max(1, Math.round(minutes / 1440));
	const note = days * 1440 !== minutes ? `${asked} does not map to a clean cron step; running every ${days}d instead.` : undefined;
	return { cron: `${now.getMinutes()} ${now.getHours()} ${days === 1 ? "*" : `*/${days}`} * *`, label: `every ${days}d`, note };
}

function loopFile(cwd: string): { file: string; text: string } | undefined {
	const candidates = [
		path.join(cwd, ".claude", "loop.md"),
		path.join(cwd, ".pi", "loop.md"),
		path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "loop.md"),
		path.join(getAgentDir(), "loop.md"),
	];
	for (const file of candidates) {
		try {
			const text = readFileSync(file, "utf8");
			return { file, text: text.length > LOOP_FILE_MAX ? text.slice(0, LOOP_FILE_MAX) : text };
		} catch {
			// next
		}
	}
	return undefined;
}

// --- Extension ---------------------------------------------------------------------------------------------------

/**
 * Framed, scrollable boxes for the extensions that show more than a notification can hold: overlays for /hooks,
 * /agents, and /cron, and the frame and scrolling of the boxes /btw and the /diff dialog show above the prompt.
 *
 * background-agents.ts, btw.ts, claude-hooks.ts, claude-remote-control.ts, diff.ts, subagents.ts carry a copy of this
 * block, or of a part of it: change them alike.
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

/** The visible slice of `lines`, padded to `rows` so the frame keeps its height while scrolling. */
function viewport(lines: string[], offset: number, rows: number): string[] {
	const visible = lines.slice(offset, offset + rows);
	return lines.length > rows ? [...visible, ...Array(Math.max(0, rows - visible.length)).fill("")] : visible;
}

export default function (pi: ExtensionAPI) {
	if (Number(process.env.PI_SUBAGENT_DEPTH || 0) > 0 || process.env.CLAUDE_CODE_DISABLE_CRON === "1") return;

	let tasks: Task[] = [];
	let loop: SelfLoop | null = null;
	let ctxRef: ExtensionContext | null = null;
	let ticker: NodeJS.Timeout | null = null;
	let unsubscribeInput: (() => void) | null = null;
	let firing = false;
	/** The open task manager, which renders afresh when the tasks change. */
	let manager: { refresh(): void; show(id?: string): void } | null = null;

	const newId = () => randomBytes(4).toString("hex");

	function persist(): void {
		pi.appendEntry("scheduled-tasks", { tasks: tasks.filter((t) => !t.loop) });
	}

	const promptText = (task: Task) => (task.prompt === LOOP_FILE ? "(loop.md / maintenance prompt)" : task.prompt);
	const kindOf = (task: Task): ScheduledTaskView["kind"] => (task.loop ? "loop wakeup" : task.recurring ? "recurring" : "one-shot");
	const scheduleOf = (task: Task) => (task.loop ? "loop wakeup" : task.recurring ? describeCron(task.cron) : "once");
	const byNextRun = () => tasks.slice().sort((a, b) => a.nextRun - b.nextRun);

	/** The tasks for other extensions, and the open task manager brought up to date. */
	function publish(): void {
		const views: ScheduledTaskView[] = byNextRun().map((t) => ({
			id: t.id,
			kind: kindOf(t),
			schedule: scheduleOf(t),
			nextRun: t.nextRun,
			next: clock(t.nextRun),
			prompt: promptText(t).replace(/\s+/g, " "),
		}));
		pi.events.emit("scheduled-tasks:state", views);
		manager?.refresh();
	}

	function status(): void {
		publish();
		if (!ctxRef?.hasUI) return;
		if (tasks.length === 0) {
			ctxRef.ui.setStatus("scheduled", undefined);
			return;
		}
		const next = Math.min(...tasks.map((t) => t.nextRun));
		const label = loop && tasks.some((t) => t.loop) ? "loop waiting" : `${tasks.length} scheduled`;
		ctxRef.ui.setStatus("scheduled", `↻ ${label} · next ${clock(next)}`);
	}

	function setWakeupTool(active: boolean): void {
		const tools = pi.getActiveTools().filter((t) => t !== "ScheduleWakeup");
		pi.setActiveTools(active ? [...tools, "ScheduleWakeup"] : tools);
	}

	function endLoop(reason: string, notify = true): void {
		if (!loop) return;
		tasks = tasks.filter((t) => t.loop !== loop?.id);
		loop = null;
		setWakeupTool(false);
		status();
		if (notify && ctxRef?.hasUI) ctxRef.ui.notify(reason, "info");
	}

	function add(cron: string, prompt: string, recurring: boolean): Task {
		if (tasks.filter((t) => !t.loop).length >= MAX_TASKS) throw new Error(`A session holds at most ${MAX_TASKS} scheduled tasks; delete one first.`);
		const spec = parseCron(cron);
		const now = Date.now();
		const next = nextRun(spec, now);
		if (next === undefined) throw new Error(`"${cron}" never matches within the next five years.`);
		const task: Task = { id: newId(), cron: cron.trim().split(/\s+/).join(" "), prompt, recurring, createdAt: now, nextRun: next };
		tasks.push(task);
		persist();
		status();
		return task;
	}

	function remove(id: string): Task | undefined {
		const task = tasks.find((t) => t.id === id);
		if (!task) return undefined;
		if (task.loop) {
			endLoop("Pending wakeup cancelled.", false);
			return task;
		}
		tasks = tasks.filter((t) => t.id !== id);
		persist();
		status();
		return task;
	}

	function scheduleWakeup(seconds: number): Task {
		if (!loop) throw new Error("No self-paced /loop is running.");
		tasks = tasks.filter((t) => t.loop !== loop?.id);
		const at = Date.now() + seconds * 1000;
		const when = new Date(at);
		const task: Task = {
			id: newId(),
			cron: `${when.getMinutes()} ${when.getHours()} ${when.getDate()} ${when.getMonth() + 1} *`,
			prompt: loop.prompt,
			recurring: false,
			createdAt: Date.now(),
			nextRun: at,
			loop: loop.id,
		};
		tasks.push(task);
		status();
		return task;
	}

	function iterationPrompt(prompt: string): string {
		return `${prompt}\n\n(This runs as a self-paced /loop. When this iteration's work is done, call ScheduleWakeup: delaySeconds between ${MIN_WAKEUP_S} and ${MAX_WAKEUP_S} with a one-line reason — short while something is about to change, such as a running build; long when nothing is pending — or stop: true once the loop's work is complete and nothing more needs checking.)`;
	}

	function resolvePrompt(task: Task, ctx: ExtensionContext): string {
		if (task.prompt !== LOOP_FILE) return task.prompt;
		return loopFile(ctx.cwd)?.text.trim() || MAINTENANCE_PROMPT;
	}

	/** Sends a prompt as the next user turn. Skill and prompt-template invocations are expanded; other commands are not. */
	function send(prompt: string): void {
		const name = prompt.match(/^\/(\S+)/)?.[1];
		const expandable = name ? pi.getCommands().some((c) => c.name === name && c.source !== "extension") : false;
		pi.sendUserMessage(prompt, { expandPromptTemplates: expandable });
	}

	function fire(task: Task, ctx: ExtensionContext): void {
		const now = Date.now();
		const prompt = resolvePrompt(task, ctx);
		if (task.loop) {
			tasks = tasks.filter((t) => t.id !== task.id);
			if (!loop || loop.id !== task.loop) return;
			loop.rescheduled = false;
			loop.iterating = true;
			status();
			send(iterationPrompt(prompt));
			return;
		}
		if (!task.recurring) {
			tasks = tasks.filter((t) => t.id !== task.id);
			persist();
		} else if (now - task.createdAt >= EXPIRY_MS) {
			tasks = tasks.filter((t) => t.id !== task.id);
			persist();
			if (ctx.hasUI) ctx.ui.notify(`Scheduled task ${task.id} expired after 7 days; this is its last run.`, "info");
		} else {
			task.nextRun = nextRun(parseCron(task.cron), now) ?? Number.POSITIVE_INFINITY;
		}
		status();
		send(prompt);
	}

	function tick(): void {
		const ctx = ctxRef;
		if (!ctx || firing || tasks.length === 0) return;
		const now = Date.now();
		const due = tasks.filter((t) => t.nextRun <= now).sort((a, b) => a.nextRun - b.nextRun)[0];
		if (!due) return;
		try {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		} catch {
			return;
		}
		firing = true;
		try {
			fire(due, ctx);
		} finally {
			firing = false;
		}
	}

	function restore(ctx: ExtensionContext): void {
		tasks = [];
		loop = null;
		let saved: Task[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "scheduled-tasks") saved = (entry.data as { tasks?: Task[] })?.tasks ?? [];
		}
		const now = Date.now();
		for (const task of saved) {
			if (task.recurring && now - task.createdAt >= EXPIRY_MS) continue;
			if (!task.recurring && task.nextRun <= now) continue;
			try {
				const next = task.recurring ? nextRun(parseCron(task.cron), now) : task.nextRun;
				if (next !== undefined) tasks.push({ ...task, nextRun: next });
			} catch {
				// unreadable schedule: drop it
			}
		}
		if (tasks.length !== saved.length && saved.length > 0) persist();
	}

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		restore(ctx);
		setWakeupTool(false);
		status();
		if (ticker) clearInterval(ticker);
		ticker = setInterval(tick, TICK_MS);
		ticker.unref();
		unsubscribeInput?.();
		unsubscribeInput = null;
		if (ctx.mode === "tui") {
			unsubscribeInput = ctx.ui.onTerminalInput((data) => {
				if (data !== "\x1b" || !loop || loop.iterating || !tasks.some((t) => t.loop === loop?.id)) return undefined;
				if (!ctx.isIdle() || ctx.ui.getEditorText().trim()) return undefined;
				endLoop("Pending wakeup cancelled.");
				return { consume: true };
			});
		}
	});

	pi.on("session_shutdown", () => {
		if (ticker) clearInterval(ticker);
		ticker = null;
		unsubscribeInput?.();
		unsubscribeInput = null;
		for (const off of unsubscribeEvents) off();
		ctxRef = null;
	});

	// --- Task manager -----------------------------------------------------------------------------------------------

	/**
	 * The task manager, a box above the prompt as /btw shows it: the tasks by next run, ↑↓ or the pointer select, Enter
	 * or a click shows the task, x deletes it, Esc goes back and closes. Opened with a task id, it shows that task, and
	 * Esc closes it.
	 */
	async function openManager(ctx: ExtensionContext, id?: string): Promise<void> {
		if (manager) {
			manager.show(id);
			return;
		}
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				let selected = Math.max(0, byNextRun().findIndex((t) => t.id === id));
				let detail: string | undefined = id;
				const direct = id !== undefined;
				let offset = 0;
				/** Task index of each body line of the list, for the pointer. */
				let hits: (number | undefined)[] = [];
				const refresh = () => tui.requestRender();
				/** Body rows of the box: at most half the terminal, so the conversation above stays readable (as /btw). */
				const maxRows = () => Math.max(4, Math.floor(tui.terminal.rows * 0.5) - 3);

				const listBody = (inner: number): string[] => {
					const list = byNextRun();
					selected = Math.min(selected, Math.max(0, list.length - 1));
					const lines = [theme.fg("muted", `Now ${clock(Date.now())} (${zone()})`), ""];
					hits = [];
					if (list.length === 0) lines.push("No scheduled tasks.");
					const nextWidth = Math.max(0, ...list.map((t) => visibleWidth(clock(t.nextRun))));
					const scheduleWidth = Math.min(24, Math.max(0, ...list.map((t) => visibleWidth(scheduleOf(t)))));
					list.forEach((task, i) => {
						const focused = i === selected;
						const schedule = truncateToWidth(scheduleOf(task), scheduleWidth, "…", true);
						const row = `${focused ? "❯ " : "  "}${theme.fg("accent", task.id)}  ${clock(task.nextRun).padEnd(nextWidth)}  ${schedule}  ${theme.fg("muted", promptText(task).replace(/\s+/g, " "))}`;
						const cut = truncateToWidth(row, inner, "…");
						hits[lines.length] = i;
						lines.push(focused ? theme.bg("selectedBg", cut + " ".repeat(Math.max(0, inner - visibleWidth(cut)))) : cut);
					});
					if (loop) lines.push("", theme.fg("muted", `Self-paced loop running: ${loop.prompt === LOOP_FILE ? "loop.md / maintenance prompt" : loop.prompt}`));
					return lines;
				};

				const detailBody = (task: Task, inner: number): string[] => {
					const label = (name: string) => theme.fg("muted", name.padEnd(10));
					const lines = [
						`${label("ID")}${theme.fg("accent", task.id)}`,
						`${label("Schedule")}${scheduleOf(task)}${task.loop ? "" : ` (${task.cron})`} · ${kindOf(task)}`,
						`${label("Next run")}${clock(task.nextRun)} (${zone()})`,
						`${label("Created")}${clock(task.createdAt)}`,
					];
					if (task.recurring) lines.push(`${label("Expires")}${clock(task.createdAt + EXPIRY_MS)}`);
					lines.push("", theme.fg("muted", "Prompt"));
					for (const line of promptText(task).split("\n")) lines.push(...(line ? wrapTextWithAnsi(line, inner) : [""]));
					return lines;
				};

				const close = () => {
					manager = null;
					done();
				};
				const back = () => {
					if (direct) {
						close();
						return;
					}
					detail = undefined;
					offset = 0;
					refresh();
				};
				const open = (task: Task | undefined) => {
					if (!task) return;
					detail = task.id;
					offset = 0;
					refresh();
				};
				const erase = (task: Task | undefined) => {
					if (!task) return;
					remove(task.id);
					ctx.ui.notify(`Deleted ${task.id}.`, "info");
					if (detail) back();
					else refresh();
				};

				manager = {
					refresh,
					show(next) {
						const index = byNextRun().findIndex((t) => t.id === next);
						if (index >= 0) {
							selected = index;
							detail = next;
							offset = 0;
						}
						refresh();
					},
				};

				const detailTask = () => (detail ? tasks.find((t) => t.id === detail) : undefined);
				const bodyFor = (inner: number) => {
					const task = detailTask();
					if (detail && !task) detail = undefined;
					return task ? detailBody(task, inner) : listBody(inner);
				};

				function render(w: number): string[] {
					const inner = Math.max(1, w - 4);
					const lines = bodyFor(inner);
					const rows = Math.min(maxRows(), Math.max(1, lines.length));
					if (detailTask()) {
						offset = Math.min(offset, Math.max(0, lines.length - rows));
					} else {
						// The list scrolls so that the selected row stays in view.
						const line = hits.indexOf(selected);
						if (line >= 0 && line < offset) offset = line;
						if (line >= offset + rows) offset = line - rows + 1;
						offset = Math.max(0, Math.min(offset, lines.length - rows));
					}
					const task = detailTask();
					const more = lines.length > rows ? `  ${offset + 1}–${Math.min(lines.length, offset + rows)}/${lines.length}` : "";
					const help = task
						? `↑↓ scroll · x delete · Esc ${direct ? "close" : "back"}${more}`
						: `↑↓ select · Enter details · x delete · Esc close${more}`;
					const title = task ? `Scheduled task ${task.id}` : "Scheduled tasks";
					return frame(theme, w, title, viewport(lines, offset, rows), help);
				}

				function handleInput(data: string): void {
					const task = detailTask();
					const list = byNextRun();
					if (matchesKey(data, Key.escape) || data === "q") {
						if (task) back();
						else close();
						return;
					}
					if (data === "x" || matchesKey(data, Key.delete)) {
						erase(task ?? list[selected]);
						return;
					}
					if (task) {
						if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace)) {
							back();
							return;
						}
						if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
						else if (matchesKey(data, Key.down)) offset++;
						else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - maxRows());
						else if (matchesKey(data, Key.pageDown)) offset += maxRows();
						else return;
						refresh();
						return;
					}
					if (list.length === 0) return;
					if (matchesKey(data, Key.up)) selected = (selected + list.length - 1) % list.length;
					else if (matchesKey(data, Key.down)) selected = (selected + 1) % list.length;
					else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
						open(list[selected]);
						return;
					} else return;
					refresh();
				}

				/** Body lines start one row below the box's top edge. */
				function handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					const task = detailTask();
					if (event.type === "wheel" && event.wheelDelta) {
						const list = byNextRun();
						if (task) offset = Math.max(0, offset + (event.wheelDelta < 0 ? -1 : 1));
						else if (list.length > 0) selected = Math.max(0, Math.min(list.length - 1, selected + (event.wheelDelta < 0 ? -1 : 1)));
						refresh();
						return { handled: true };
					}
					if (task) return undefined;
					const index = hits[offset + event.y - 1];
					if (index === undefined) return undefined;
					if (event.type === "move") {
						if (index === selected) return undefined;
						selected = index;
						refresh();
						return { handled: true, render: true };
					}
					if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
					selected = index;
					if (event.type === "click") open(byNextRun()[index]);
					else refresh();
					return { handled: true };
				}

				return {
					render,
					handleInput,
					handleMouse,
					invalidate(): void {},
					dispose(): void {
						manager = null;
					},
				};
			},
		);
	}

	const unsubscribeEvents = [
		pi.events.on("scheduled-tasks:request", () => publish()),
		pi.events.on("scheduled-tasks:open", (data) => {
			const id = (data as { id?: unknown } | undefined)?.id;
			if (ctxRef?.mode === "tui") void openManager(ctxRef, typeof id === "string" ? id : undefined);
		}),
		pi.events.on("scheduled-tasks:delete", (data) => {
			const task = typeof data === "string" ? remove(data) : undefined;
			if (task && ctxRef?.hasUI) ctxRef.ui.notify(`Deleted ${task.id}.`, "info");
		}),
		pi.events.on("statusline:status-click", (data) => {
			if ((data as { key?: unknown } | undefined)?.key === "scheduled" && ctxRef?.mode === "tui") void openManager(ctxRef);
		}),
		// /cron from the Claude app (claude-remote-control.ts): carried out here, answered there, nothing opens in the terminal.
		pi.events.on("scheduled-tasks:command", (data) => {
			const request = data as { args?: unknown; reply?: (text: string) => void } | undefined;
			if (typeof request?.reply !== "function") return;
			request.reply(cronCommand(typeof request.args === "string" ? request.args.trim() : "").message);
		}),
	];

	pi.on("agent_settled", (event) => {
		if (!loop?.iterating) return;
		loop.iterating = false;
		if (event.aborted) {
			endLoop("Self-paced loop stopped (the iteration was interrupted).");
			return;
		}
		if (loop.rescheduled) {
			loop.fallback = false;
			return;
		}
		if (loop.fallback) {
			endLoop("Self-paced loop ended: two iterations in a row did not schedule a next wakeup.");
			return;
		}
		loop.fallback = true;
		scheduleWakeup(FALLBACK_WAKEUP_S);
		if (ctxRef?.hasUI) ctxRef.ui.notify(`The loop iteration did not schedule a wakeup; checking again at ${clock(Date.now() + FALLBACK_WAKEUP_S * 1000)}.`, "info");
	});

	// --- Tools ------------------------------------------------------------------------------------------------------

	pi.registerTool({
		name: "CronCreate",
		label: "Schedule",
		description: [
			"Schedule a prompt to run later in this session, once or on a recurring schedule.",
			"cron is a standard 5-field expression in the user's local timezone: minute hour day-of-month month day-of-week (*, n, a-b, */n, a,b; Sunday is 0 or 7; no L, W, ? or names).",
			"For a one-time reminder (\"in 45 minutes\", \"at 3pm\"), pin minute, hour, day-of-month, and month, and set recurring: false. Run `date` first when you need the current local time.",
			"Tasks fire only while this session is open and idle, between turns. Recurring tasks expire after 7 days. At most 50 tasks.",
			"The prompt runs as if the user had sent it, so write it as a complete instruction.",
		].join("\n"),
		promptSnippet: "CronCreate/CronList/CronDelete: schedule prompts in this session (reminders, polling)",
		parameters: Type.Object({
			cron: Type.String({ description: 'Standard 5-field cron expression in local time, e.g. "*/5 * * * *" or "30 14 23 10 *".' }),
			prompt: Type.String({ description: "The prompt to run when the task fires." }),
			recurring: Type.Optional(Type.Boolean({ description: "true (default): fire on every match until deleted or expired. false: fire once, then delete." })),
		}),
		async execute(_id, params) {
			const task = add(params.cron, params.prompt, params.recurring !== false);
			return {
				content: [
					{
						type: "text",
						text: `Scheduled ${task.id} (${task.cron}, ${task.recurring ? "recurring, expires in 7 days" : "one-shot"}). Next run: ${clock(task.nextRun)} (${zone()}).`,
					},
				],
				details: { task },
			};
		},
		renderResult(result, _options, theme) {
			const task = (result.details as { task?: Task } | undefined)?.task;
			if (!task) return new Text("", 0, 0);
			return new Text(`${theme.fg("success", "↻ ")}${theme.fg("accent", task.id)} ${task.cron} ${theme.fg("muted", `next run ${clock(task.nextRun)}`)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "CronList",
		label: "Scheduled tasks",
		description: "List the scheduled tasks of this session with their IDs, schedules, next run times, and prompts.",
		parameters: Type.Object({}),
		async execute() {
			const lines = tasks
				.slice()
				.sort((a, b) => a.nextRun - b.nextRun)
				.map((t) => `${t.id} · ${t.loop ? "loop wakeup" : t.cron} · ${t.recurring ? "recurring" : "one-shot"} · next run ${clock(t.nextRun)} · ${t.prompt === LOOP_FILE ? "(loop.md / maintenance prompt)" : t.prompt}`);
			const now = `Now: ${clock(Date.now())} (${zone()}).`;
			return { content: [{ type: "text", text: lines.length ? `${now}\n${lines.join("\n")}` : `${now}\nNo scheduled tasks.` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "CronDelete",
		label: "Unschedule",
		description: "Cancel a scheduled task of this session by its ID.",
		parameters: Type.Object({ id: Type.String({ description: "The 8-character task ID from CronCreate or CronList." }) }),
		async execute(_id, params) {
			const task = remove(params.id.trim());
			if (!task) throw new Error(`No scheduled task with ID ${params.id}.`);
			return { content: [{ type: "text", text: `Cancelled ${task.id} (${task.loop ? "loop wakeup" : task.cron}).` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "ScheduleWakeup",
		label: "Schedule wakeup",
		description: `Schedule the next iteration of the running self-paced /loop. Pick delaySeconds between ${MIN_WAKEUP_S} and ${MAX_WAKEUP_S} from what you observed: short while something is about to change, long when nothing is pending. Pass stop: true instead once the loop's work is complete.`,
		parameters: Type.Object({
			delaySeconds: Type.Optional(Type.Number({ description: `Seconds until the next iteration, ${MIN_WAKEUP_S}-${MAX_WAKEUP_S}.` })),
			reason: Type.Optional(Type.String({ description: "One line on why this delay (or why the loop stops)." })),
			stop: Type.Optional(Type.Boolean({ description: "End the loop instead of scheduling another iteration." })),
		}),
		defaultActive: false,
		async execute(_id, params) {
			if (!loop) throw new Error("No self-paced /loop is running.");
			if (params.stop) {
				loop.rescheduled = true;
				endLoop(`Self-paced loop ended${params.reason ? `: ${params.reason}` : "."}`);
				return { content: [{ type: "text", text: "Loop stopped. No further iterations are scheduled." }], details: undefined };
			}
			const seconds = Math.min(MAX_WAKEUP_S, Math.max(MIN_WAKEUP_S, Math.round(params.delaySeconds ?? 600)));
			loop.rescheduled = true;
			loop.fallback = false;
			const task = scheduleWakeup(seconds);
			const text = `Next iteration at ${clock(task.nextRun)} (in ${Math.round(seconds / 60)} min)${params.reason ? ` — ${params.reason}` : ""}.`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	// --- Commands ---------------------------------------------------------------------------------------------------

	pi.registerCommand("loop", {
		description: "Run a prompt repeatedly: /loop [interval] [prompt], /loop stop",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const text = args.trim();
			if (text === "stop") {
				if (loop) endLoop("Self-paced loop stopped.");
				else ctx.ui.notify("No self-paced loop is running. Fixed-interval loops are cancelled with /cron delete <id>.", "info");
				return;
			}
			const { seconds, prompt: given } = splitInterval(text);
			const prompt = given || LOOP_FILE;
			const shown = given || (loopFile(ctx.cwd)?.file.replace(os.homedir(), "~") ?? "the built-in maintenance prompt");
			try {
				if (seconds !== undefined) {
					const { cron, label, note } = intervalCron(seconds);
					const task = add(cron, prompt, true);
					ctx.ui.notify(`${note ? `${note}\n` : ""}Loop ${task.id} scheduled ${label} (${cron}); next run ${clock(task.nextRun)}. Runs now, then on schedule. /cron delete ${task.id} stops it.`, "info");
					send(resolvePrompt(task, ctx));
					return;
				}
				if (loop) endLoop("Replaced the running self-paced loop.", false);
				loop = { id: newId(), prompt, rescheduled: false, fallback: false, iterating: true };
				setWakeupTool(true);
				status();
				ctx.ui.notify(`Self-paced loop started with ${shown}. Esc while it waits, or /loop stop, ends it.`, "info");
				send(iterationPrompt(resolvePrompt({ prompt } as Task, ctx)));
			} catch (error) {
				ctx.ui.notify(`/loop: ${error instanceof Error ? error.message : error}`, "error");
			}
		},
	});

	pi.registerCommand("cron", {
		description: "Scheduled tasks: /cron (list), /cron add|once <m h dom mon dow> <prompt>, /cron delete <id>|all",
		getArgumentCompletions: (prefix) => {
			if (!prefix) return null;
			const subs = ["add ", "once ", "delete "];
			if (!prefix.includes(" ")) {
				const matches = subs.filter((s) => s.startsWith(prefix));
				return matches.length ? matches.map((s) => ({ value: s, label: s.trim() })) : null;
			}
			const del = prefix.match(/^delete (\S*)$/);
			if (!del) return null;
			const ids = [...tasks.map((t) => t.id), "all"].filter((id) => id.startsWith(del[1]) && id !== del[1]);
			return ids.length ? ids.map((id) => ({ value: `delete ${id}`, label: id })) : null;
		},
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const text = args.trim();
			if (!text && ctx.mode === "tui") {
				await openManager(ctx);
				return;
			}
			const result = cronCommand(text);
			ctx.ui.notify(result.message, result.level);
		},
	});

	/** The task list as text: for /cron outside the interactive terminal, and in the Claude app. */
	function listText(): string {
		const lines = [`Now ${clock(Date.now())} (${zone()})`, ""];
		const list = byNextRun();
		if (list.length === 0) lines.push("No scheduled tasks.");
		for (const t of list) {
			const schedule = t.loop || !t.recurring ? scheduleOf(t) : `${scheduleOf(t)} (${t.cron})`;
			lines.push(`- ${t.id} · next ${clock(t.nextRun)} · ${schedule} · ${promptText(t).replace(/\s+/g, " ")}`);
		}
		if (loop) lines.push("", `Self-paced loop running: ${loop.prompt === LOOP_FILE ? "loop.md / maintenance prompt" : loop.prompt}`);
		lines.push("", "/cron delete <id> cancels a task; /cron add|once <m h dom mon dow> <prompt> schedules one; /loop stop ends a self-paced loop.");
		return lines.join("\n");
	}

	/** /cron's arguments carried out, as the text the command answers with: the list without arguments. */
	function cronCommand(text: string): { message: string; level: "info" | "warning" | "error" } {
		const create = text.match(/^(add|once)\s+((?:\S+\s+){4}\S+)\s+([\s\S]+)$/);
		if (create) {
			try {
				const task = add(create[2], create[3].trim(), create[1] === "add");
				return { message: `Scheduled ${task.id} (${task.cron}, ${task.recurring ? "recurring" : "one-shot"}); next run ${clock(task.nextRun)}.`, level: "info" };
			} catch (error) {
				return { message: `/cron: ${error instanceof Error ? error.message : error}`, level: "error" };
			}
		}
		const del = text.match(/^(?:delete|rm|remove)\s+(\S+)$/);
		if (del) {
			if (del[1] === "all") {
				const count = tasks.length;
				tasks = [];
				if (loop) endLoop("", false);
				persist();
				status();
				return { message: `Deleted ${count} scheduled task${count === 1 ? "" : "s"}.`, level: "info" };
			}
			const task = remove(del[1]);
			return task ? { message: `Deleted ${task.id}.`, level: "info" } : { message: `No scheduled task ${del[1]}.`, level: "warning" };
		}
		if (text) return { message: "Usage: /cron, /cron add <m h dom mon dow> <prompt>, /cron once <m h dom mon dow> <prompt>, /cron delete <id>|all", level: "warning" };
		return { message: listText(), level: "info" };
	}
}
