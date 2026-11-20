/**
 * Wait: a tool that waits for something to happen without spending model requests on it — a CI pipeline, a deploy, a
 * service coming up, a file appearing. Each poll the model makes itself is a request that reads the whole context
 * again; this tool polls on its own.
 *
 * - wait runs a shell command, or calls another of Pi's tools (gitlab, openproject, web_fetch, …), every interval
 *   seconds (default 30) until a condition holds: the output matches a regular expression ("match", the default with
 *   match), no longer matches it ("nomatch"), the check succeeds ("success", the default without match), fails
 *   ("failure"), or its output changes ("change"). It gives up after timeout minutes (default 30). The first check
 *   runs at once.
 * - In the foreground the call returns when the condition holds, with the last output; Esc stops it. The tool row
 *   shows the checks so far. When the user sends a message meanwhile, the wait goes on in the background with the
 *   checks it made, and the call returns at once with its id, so a long wait never shuts the user out.
 * - background: true (shell commands only) returns at once. When the condition holds or the wait gives up, a message
 *   brings the result into the conversation: while Pi works, with its next step, so it is not stale by the time it
 *   comes; when Pi is idle, it starts a turn. list: true and /waits list the
 *   background waits, gitlab_pipeline's too; cancel: "<id>" or /waits cancel <id> stops one.
 * - Background waits go on over /reload, and a result that comes while Pi reloads arrives once it has. Another session
 *   (/new, /resume, /fork) ends them, as they belong to the conversation that started them; the next session names
 *   them in a notice. A wait for a tool, which only gets to the background by a message from the user, calls the tool
 *   through the context of its tool call, which the runtime takes along: it ends at /reload, and a message says so.
 * - Other extensions see the background waits on the event bus: "background-waits:state" carries { tool, waits }
 *   whenever they change and on "background-waits:request"; "background-waits:cancel" with { id } stops one.
 *   background-agents.ts lists them in its panel below the prompt, tmux-tab-activity.ts counts them as work, and
 *   gitlab.ts publishes gitlab_pipeline's the same way.
 * - A bash call that sleeps 15 seconds or more right after another bash call that did is refused with a pointer to
 *   wait. {"nudge": false} in ~/.pi/agent/wait.json turns that off.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CONFIG_FILE = path.join(getAgentDir(), "wait.json");
const MESSAGE_TYPE = "wait";
const MAX_OUTPUT = 256 * 1024;
const RESULT_CHARS = 2000;
const RESULT_LINES = 40;
const NUDGE_SLEEP_S = 15;
const NUDGE_WINDOW_MS = 10 * 60_000;
/** The event-bus contract with gitlab.ts, background-agents.ts, and tmux-tab-activity.ts. */
const STATE = "background-waits:state";
const REQUEST = "background-waits:request";
const CANCEL = "background-waits:cancel";
const TOOL = "wait";

type Until = "match" | "nomatch" | "success" | "failure" | "change";
/** How a wait ended; "ended": a wait for a tool, at the /reload of the runtime whose tool context it used. */
type Status = "met" | "timeout" | "cancelled" | "aborted" | "ended";

interface Check {
	ok: boolean;
	output: string;
	code?: number | null;
	note?: string;
}

interface Spec {
	label: string;
	command?: string;
	tool?: string;
	args?: unknown;
	until: Until;
	regex?: RegExp;
	intervalMs: number;
	timeoutMs: number;
}

interface WaitDetails {
	id?: string;
	label: string;
	condition: string;
	status: Status | "running" | "background";
	checks: number;
	elapsedMs: number;
}

interface Background {
	id: string;
	spec: Spec;
	started: number;
	checks: number;
	/** The last line of the last check's output. */
	last?: string;
	/** The end of the last check's output. */
	output?: string;
	abort: AbortController;
	/** The runtime whose tool context the checks use (a wait for a tool): its /reload ends the wait. */
	boundTo?: unknown;
	/** Where the wait stands, for the message its end at a /reload sends. */
	run?: Run;
}

/** Where a wait stands: carried over when a wait in the foreground goes on in the background. */
interface Run {
	started: number;
	checks: number;
	/** The first output, for until "change". */
	baseline?: string;
	last?: Check;
	/** When the next check is due; none before the first. */
	nextAt?: number;
}

// A copy of BackgroundWaitView from wait.ts, the event-bus contract between wait.ts, gitlab.ts, background-agents.ts,
// and tmux-tab-activity.ts: change all alike.
/** A background wait as other extensions see it ("background-waits:state", { tool, waits } for each tool that waits). */
interface BackgroundWaitView {
	/** w1, gp1, …: what cancel and stop_wait take. */
	id: string;
	/** The tool that waits: wait, gitlab_pipeline. */
	tool: string;
	/** What is awaited. */
	label: string;
	/** When the wait ends, in words. */
	until: string;
	startedAt: number;
	checks: number;
	/** What the last check found, in one line. */
	last?: string;
	/** The command each check runs, where there is one. */
	command?: string;
	/** The end of the last check's output, where it says more than last. */
	output?: string;
	intervalMs: number;
	/** When it gives up. */
	deadline: number;
}

/** A result that came while no session runtime could take it, during a /reload. */
interface Held {
	content: string;
	details: WaitDetails;
}

/**
 * The background waits, shared by the session runtimes of this process: /reload loads this file afresh and replaces
 * the runtime, and its pi and ctx throw once replaced. So a wait outlives the runtime that started it and reports to
 * the one current when it ends.
 */
interface Shared {
	/** The current runtime; ready once it is complete, after resources_discover. None during a reload. */
	live?: { pi: ExtensionAPI; ctx: ExtensionContext; ready: boolean };
	waits: Map<string, Background>;
	counter: number;
	held: Held[];
	/** The waits a switch to another session ended, for a notice in that one. */
	ended: string[];
}
const store = globalThis as typeof globalThis & Record<symbol, Shared | undefined>;
const shared: Shared = (store[Symbol.for("pi.wait")] ??= { waits: new Map(), counter: 0, held: [], ended: [] });

function loadNudge(): boolean {
	try {
		return JSON.parse(readFileSync(CONFIG_FILE, "utf8"))?.nudge !== false;
	} catch {
		return true;
	}
}

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A time as HH:MM, with the date before it when it is not today. */
function clock(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return d.toDateString() === new Date().toDateString() ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The end of an output, within RESULT_CHARS and RESULT_LINES. */
function tail(output: string): string {
	const trimmed = output.replace(/\s+$/, "");
	let lines = trimmed.split("\n");
	let cut = false;
	if (lines.length > RESULT_LINES) {
		lines = lines.slice(-RESULT_LINES);
		cut = true;
	}
	let text = lines.join("\n");
	if (text.length > RESULT_CHARS) {
		text = text.slice(-RESULT_CHARS);
		cut = true;
	}
	return cut ? `…\n${text}` : text || "(no output)";
}

function describeCondition(spec: Spec): string {
	switch (spec.until) {
		case "match":
			return `output matches /${spec.regex?.source}/`;
		case "nomatch":
			return `output no longer matches /${spec.regex?.source}/`;
		case "success":
			return spec.command ? "command exits 0" : "the tool call succeeds";
		case "failure":
			return spec.command ? "command fails" : "the tool call fails";
		case "change":
			return "output changes";
	}
}

/** Runs the command in bash, its output (stdout and stderr) kept to the last MAX_OUTPUT characters. */
function runCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<Check> {
	return new Promise((resolve) => {
		let output = "";
		let note: string | undefined;
		const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const add = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
		};
		child.stdout?.on("data", add);
		child.stderr?.on("data", add);
		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		};
		const timer = setTimeout(() => {
			note = `check timed out after ${formatDuration(timeoutMs)}`;
			kill();
		}, timeoutMs);
		const onAbort = () => kill();
		signal.addEventListener("abort", onAbort, { once: true });
		const finish = (code: number | null, error?: Error) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			if (error) note = error.message;
			resolve({ ok: code === 0 && !note, output, code, note });
		};
		child.on("error", (error) => finish(null, error));
		child.on("close", (code) => finish(code));
	});
}

async function runTool(ctx: any, name: string, args: unknown, signal: AbortSignal): Promise<Check> {
	const outcome = await ctx.executeTool(name, args ?? {}, { signal });
	const content: any[] = outcome?.result?.content ?? [];
	const output = content
		.filter((c) => c.type === "text")
		.map((c) => c.text as string)
		.join("\n");
	return { ok: !outcome?.isError, output };
}

/** A check that never throws: a tool context gone stale with its runtime, say, counts as a failed check. */
function safe(check: (signal: AbortSignal) => Promise<Check>): (signal: AbortSignal) => Promise<Check> {
	return async (signal) => {
		try {
			return await check(signal);
		} catch (error) {
			return { ok: false, output: "", note: error instanceof Error ? error.message : String(error) };
		}
	};
}

/** Sleeps, waking once a second for the abort signal and, in the foreground, for a message from the user. */
async function pause(ms: number, signal: AbortSignal, interrupted?: () => boolean): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (signal.aborted || interrupted?.()) return;
		await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
	}
}

function resultText(spec: Spec, status: Status, checks: number, elapsedMs: number, last: Check | undefined, id?: string): string {
	const who = id ? `Background wait ${id} (${spec.label})` : "Waited";
	const span = `${formatDuration(elapsedMs)}, ${checks} check${checks === 1 ? "" : "s"}`;
	const head = {
		met: `${id ? `${who}: condition` : "Condition"} met after ${span}: ${describeCondition(spec)}.`,
		timeout: `${id ? `${who} gave up` : "Gave up"} after ${span}; condition not met: ${describeCondition(spec)}.`,
		cancelled: `${id ? `${who} was cancelled` : "Cancelled"} after ${span}.`,
		aborted: `Aborted after ${span}.`,
		ended: `${who} ended with the /reload after ${span}: a wait for a tool cannot outlive the runtime it calls the tool through. Not yet: ${describeCondition(spec)}. Wait again to go on.`,
	}[status];
	if (!last) return head;
	const exit = spec.command ? ` (${last.note ?? `exit ${last.code}`})` : last.ok ? "" : " (error)";
	return `${head}\nLast output${exit}:\n${tail(last.output)}`;
}

function view(entry: Background): BackgroundWaitView {
	const { spec } = entry;
	return {
		id: entry.id,
		tool: TOOL,
		label: spec.label,
		until: describeCondition(spec),
		startedAt: entry.started,
		checks: entry.checks,
		last: entry.last,
		command: spec.command,
		output: entry.output,
		intervalMs: spec.intervalMs,
		deadline: entry.started + spec.timeoutMs,
	};
}

/** Tells the other extensions about the background waits, through the runtime given or else the current one. */
function publish(via: ExtensionAPI | undefined = shared.live?.pi): void {
	try {
		via?.events.emit(STATE, { tool: TOOL, waits: [...shared.waits.values()].map(view) });
	} catch {
		// A runtime replaced meanwhile; the next one asks at its start.
	}
}

/** Brings a result into the conversation of the current runtime, or keeps it until there is one. */
function deliver(held: Held): void {
	const live = shared.live;
	if (live?.ready) {
		try {
			live.pi.sendMessage(
				{ customType: MESSAGE_TYPE, content: held.content, display: true, details: held.details },
				{ triggerTurn: true, deliverAs: "steer" },
			);
			return;
		} catch {
			// The runtime went away meanwhile: kept for the next one.
		}
	}
	shared.held.push(held);
}

function cancel(id: string): string {
	const entry = shared.waits.get(id);
	if (!entry) return `No background wait ${id}${shared.waits.size ? `; running: ${[...shared.waits.keys()].join(", ")}` : ""}.`;
	entry.abort.abort();
	shared.waits.delete(id);
	publish();
	return `Cancelled background wait ${id} (${entry.spec.label}) after ${formatDuration(Date.now() - entry.started)}.`;
}

/** One line per background wait, of every tool that waits. */
function listText(views: BackgroundWaitView[]): string {
	if (views.length === 0) return "No background waits.";
	const now = Date.now();
	return views
		.map((v) => {
			const span = `${v.checks} check${v.checks === 1 ? "" : "s"} in ${formatDuration(now - v.startedAt)}, every ${formatDuration(v.intervalMs)}`;
			return `${v.id}  ${v.label} (${v.tool}): until ${v.until}; ${span}, gives up at ${clock(v.deadline)}${v.last ? `; last: ${v.last}` : ""}`;
		})
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	let lastSleepPoll: number | undefined;
	/** The background waits of the other tools, as "background-waits:state" brings them. */
	const others = new Map<string, BackgroundWaitView[]>();
	const allViews = () => [...[...shared.waits.values()].map(view), ...[...others.values()].flat()];

	/**
	 * Runs checks until the condition holds, the time is up, or the wait is stopped; in the foreground also until the
	 * user sends a message ("handover"), and then run says where it stands, for the background to go on from there.
	 */
	async function loop(
		spec: Spec,
		check: (signal: AbortSignal) => Promise<Check>,
		signal: AbortSignal,
		run: Run,
		progress: (checks: number, elapsedMs: number, last: Check) => void,
		interrupted?: () => boolean,
	): Promise<Status | "handover"> {
		for (;;) {
			if (run.nextAt !== undefined) {
				await pause(run.nextAt - Date.now(), signal, interrupted);
				if (signal.aborted) return "aborted";
				if (interrupted?.()) return "handover";
			}
			if (signal.aborted) return "aborted";
			const last = await check(signal);
			run.last = last;
			run.checks++;
			if (signal.aborted) return "aborted";
			const met =
				spec.until === "match"
					? !!spec.regex?.test(last.output)
					: spec.until === "nomatch"
						? !spec.regex?.test(last.output)
						: spec.until === "success"
							? last.ok
							: spec.until === "failure"
								? !last.ok
								: run.baseline !== undefined && last.output !== run.baseline;
			if (spec.until === "change" && run.baseline === undefined) run.baseline = last.output;
			const elapsedMs = Date.now() - run.started;
			if (met) return "met";
			if (elapsedMs >= spec.timeoutMs) return "timeout";
			progress(run.checks, elapsedMs, last);
			run.nextAt = Date.now() + Math.min(spec.intervalMs, spec.timeoutMs - elapsedMs);
		}
	}

	/**
	 * Starts a background wait, or goes on in the background with one from the foreground (run). The loop runs on in the
	 * module that started it, and reports through `shared`, never through this runtime's pi. A wait for a tool is bound
	 * to this runtime (boundTo), whose tool context it calls the tool through.
	 */
	function startBackground(spec: Spec, check: (signal: AbortSignal) => Promise<Check>, run: Run = { started: Date.now(), checks: 0 }): Background {
		const id = `w${++shared.counter}`;
		const entry: Background = { id, spec, started: run.started, checks: run.checks, abort: new AbortController(), run };
		if (spec.tool) entry.boundTo = pi;
		const note = (last: Check) => {
			entry.checks = run.checks;
			entry.last = oneLine(last.output.trim().split("\n").at(-1) ?? "", 200) || last.note || undefined;
			entry.output = last.output.trim() ? tail(last.output) : undefined;
		};
		if (run.last) note(run.last);
		shared.waits.set(id, entry);
		publish();
		void loop(spec, safe(check), entry.abort.signal, run, (_checks, _elapsedMs, last) => {
			note(last);
			publish();
		}).then((status) => {
			if (shared.waits.get(id) === entry) shared.waits.delete(id);
			publish();
			if (status === "aborted" || status === "handover") return;
			const elapsedMs = Date.now() - run.started;
			const details: WaitDetails = { id, label: spec.label, condition: describeCondition(spec), status, checks: run.checks, elapsedMs };
			deliver({ content: resultText(spec, status, run.checks, elapsedMs, run.last, id), details });
		});
		return entry;
	}

	const checkTimeout = (spec: Spec) => Math.min(Math.max(spec.intervalMs, 60_000), 300_000);

	pi.on("session_start", (_event, ctx) => {
		shared.live = { pi, ctx, ready: false };
		others.clear();
		if (shared.ended.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Background waits of the previous session ended with it: ${shared.ended.join(", ")}.`, "warning");
		}
		shared.ended = [];
		// The other tools publish theirs, and this file's own handler publishes the waits that went on over a /reload.
		pi.events.emit(REQUEST, undefined);
	});

	// Pi emits resources_discover after session_start, at the start and at /reload alike; a message sent before could
	// start a turn inside the reload. The results that came meanwhile go out then.
	pi.on("resources_discover", () => {
		setTimeout(() => {
			const live = shared.live;
			if (live?.pi !== pi) return;
			live.ready = true;
			for (const held of shared.held.splice(0)) deliver(held);
		}, 0);
	});

	pi.on("session_shutdown", (event) => {
		if (shared.live?.pi === pi) shared.live = undefined;
		if (event.reason === "reload") {
			// The waits for a tool call it through this runtime, which the reload replaces: they end, and the next runtime
			// says so in a message.
			for (const entry of [...shared.waits.values()]) {
				if (entry.boundTo !== pi) continue;
				entry.abort.abort();
				shared.waits.delete(entry.id);
				const checks = entry.run?.checks ?? entry.checks;
				const elapsedMs = Date.now() - entry.started;
				const condition = describeCondition(entry.spec);
				const details: WaitDetails = { id: entry.id, label: entry.spec.label, condition, status: "ended", checks, elapsedMs };
				shared.held.push({ content: resultText(entry.spec, "ended", checks, elapsedMs, entry.run?.last, entry.id), details });
			}
			return;
		}
		// Another session or the end of Pi: the waits belong to the conversation that started them.
		const ended = [
			...[...shared.waits.values()].map((entry) => `${entry.id} (${entry.spec.label})`),
			...shared.held.map((held) => `${held.details.id} (${held.details.label}, its result unread)`),
		];
		for (const entry of shared.waits.values()) entry.abort.abort();
		shared.waits.clear();
		shared.held = [];
		if (event.reason !== "quit") shared.ended.push(...ended);
	});

	pi.events.on(REQUEST, () => publish(pi));
	pi.events.on(STATE, (data) => {
		const { tool, waits } = (data ?? {}) as { tool?: unknown; waits?: unknown };
		if (typeof tool === "string" && tool !== TOOL && Array.isArray(waits)) others.set(tool, waits as BackgroundWaitView[]);
	});
	pi.events.on(CANCEL, (data) => {
		const id = String((data as { id?: unknown } | undefined)?.id);
		if (shared.waits.has(id)) shared.live?.ctx.ui.notify(cancel(id), "info");
	});

	// Polling by sleeping in bash costs a model request per poll; point to wait from the second poll in a row.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" || (event as { parentToolCallId?: string }).parentToolCallId) return undefined;
		const command = String((event.input as { command?: unknown }).command ?? "");
		const sleeps = [...command.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
		const longest = sleeps.length ? Math.max(...sleeps) : 0;
		const now = Date.now();
		if (longest < NUDGE_SLEEP_S) {
			lastSleepPoll = undefined;
			return undefined;
		}
		const previous = lastSleepPoll;
		lastSleepPoll = now;
		if (previous === undefined || now - previous > NUDGE_WINDOW_MS || !loadNudge()) return undefined;
		lastSleepPoll = undefined;
		return {
			block: true,
			reason:
				"Not run: this is the second bash call in a row that sleeps to poll, and every poll is a model request that reads the whole context again. " +
				'Use the wait tool instead, e.g. wait {command: "<check>", match: "<regex>"} or until: "success"; it checks every interval without model requests and returns when the condition holds. ' +
				"For a single pause that is not a poll, run the command again.",
		};
	});

	pi.registerTool({
		name: "wait",
		label: "Wait",
		description:
			"Wait until something happens, checking it without model requests: run a shell command, or call another tool (gitlab, openproject, web_fetch, …), " +
			"every interval seconds (default 30) until the condition holds, at most timeout minutes (default 30). " +
			'until: "match" (output matches the regex match; the default when match is given), "nomatch" (no longer matches), ' +
			'"success" (exit 0, or the tool call succeeds; the default otherwise), "failure", or "change" (output differs from the first check). ' +
			"Returns the last output. When the user sends a message meanwhile, the wait goes on in the background and the call returns at once with its id. " +
			"background: true (shell commands only) returns at once and a message brings the result later; it goes on over /reload. " +
			"list: true lists the background waits (gitlab_pipeline's too), cancel: id stops one. " +
			'Examples: {command: "docker service ps web --format {{.CurrentState}}", match: "^Running"}; ' +
			'{tool: "gitlab", args: {path: "/projects/42/pipelines/1234"}, match: "\\"status\\": \\"(success|failed|canceled)\\""}; ' +
			'{command: "curl -fsS https://example.com/health", until: "success", interval: 10}.',
		promptSnippet: "Wait for a pipeline, deploy, or service without polling (checks run without model requests)",
		promptGuidelines: [
			"wait: use it instead of sleep in bash when you wait for something that has not happened yet (CI pipeline, deploy, container or service start, a file or URL appearing); one wait call replaces a poll per model request.",
			"wait: not for a single check: when the condition should already hold (a container that just answered, a reload that just ran), check it once with bash or the tool itself, and wait only if it does not hold yet.",
			"wait: for GitLab pipelines and jobs, use gitlab_pipeline (action wait) where it is loaded, else poll the gitlab tool with wait (tool and args); never curl with a token.",
		],
		parameters: Type.Object({
			command: Type.Optional(Type.String({ description: "Shell command to run for each check (bash, in the working directory)" })),
			tool: Type.Optional(Type.String({ description: "Name of another tool to call for each check instead of a command" })),
			args: Type.Optional(Type.Any({ description: "Arguments for tool" })),
			match: Type.Optional(Type.String({ description: "JavaScript regular expression (multiline) tested against the output" })),
			until: Type.Optional(
				StringEnum(["match", "nomatch", "success", "failure", "change"] as const, {
					description: "Condition that ends the wait (default: match when match is given, else success)",
				}),
			),
			interval: Type.Optional(Type.Number({ description: "Seconds between checks (default 30, at least 2)" })),
			timeout: Type.Optional(Type.Number({ description: "Minutes before giving up (default 30, at most 1440)" })),
			label: Type.Optional(Type.String({ description: "Short description of what is awaited, shown to the user" })),
			background: Type.Optional(Type.Boolean({ description: "Return at once and report by message later (command only)" })),
			cancel: Type.Optional(Type.String({ description: "Id of a background wait to cancel (no other parameters)" })),
			list: Type.Optional(Type.Boolean({ description: "List the background waits, gitlab_pipeline's too (no other parameters)" })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

		async execute(_id, params, signal, onUpdate, ctx) {
			if (params.cancel) return { content: [{ type: "text", text: cancel(params.cancel) }], details: undefined };
			if (params.list) return { content: [{ type: "text", text: listText(allViews()) }], details: undefined };
			if (!params.command === !params.tool) throw new Error("give either command or tool");
			if (params.tool === "wait") throw new Error("wait cannot wait for itself");
			const inner = (params.args ?? {}) as { action?: unknown; wait?: unknown };
			if (params.tool === "gitlab_pipeline" && (inner.action === "wait" || inner.wait === true)) {
				throw new Error("gitlab_pipeline waits by itself: call it directly with action wait (or wait: true) instead of through wait");
			}
			let regex: RegExp | undefined;
			if (params.match !== undefined) {
				try {
					regex = new RegExp(params.match, "m");
				} catch (error) {
					throw new Error(`match is not a valid regular expression: ${(error as Error).message}`);
				}
			}
			const until = (params.until ?? (regex ? "match" : "success")) as Until;
			if ((until === "match" || until === "nomatch") && !regex) throw new Error(`until "${until}" needs match`);
			const spec: Spec = {
				label: params.label?.trim() || oneLine(params.command ?? `${params.tool} ${JSON.stringify(params.args ?? {})}`, 80),
				command: params.command,
				tool: params.tool,
				args: params.args,
				until,
				regex,
				intervalMs: Math.max(2, params.interval ?? 30) * 1000,
				timeoutMs: Math.min(Math.max(0.1, params.timeout ?? 30), 1440) * 60_000,
			};

			const cwd = ctx.cwd;
			const runCheck = (s: AbortSignal) => runCommand(spec.command as string, cwd, checkTimeout(spec), s);
			if (params.background) {
				if (!spec.command) throw new Error("background works with command only; wait for a tool in the foreground");
				const entry = startBackground(spec, runCheck);
				const details: WaitDetails = { id: entry.id, label: spec.label, condition: describeCondition(spec), status: "background", checks: 0, elapsedMs: 0 };
				return {
					content: [
						{
							type: "text",
							text:
								`Waiting in the background as ${entry.id}: ${describeCondition(spec)}, checking every ${formatDuration(spec.intervalMs)} ` +
								`for up to ${formatDuration(spec.timeoutMs)}. A message brings the result; until then carry on or end your turn.`,
						},
					],
					details,
				};
			}

			const abort = new AbortController();
			const onAbort = () => abort.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) abort.abort();
			const check = spec.command ? runCheck : (s: AbortSignal) => runTool(ctx, spec.tool as string, spec.args, s);
			const condition = describeCondition(spec);
			const run: Run = { started: Date.now(), checks: 0 };
			try {
				const status = await loop(
					spec,
					check,
					abort.signal,
					run,
					(checks, elapsedMs, last) => {
						const details: WaitDetails = { label: spec.label, condition, status: "running", checks, elapsedMs };
						const line = oneLine(last.output.trim().split("\n").at(-1) ?? "", 100);
						onUpdate?.({ content: [{ type: "text", text: `${checks} checks, ${formatDuration(elapsedMs)}${line ? `: ${line}` : ""}` }], details });
					},
					() => ctx.hasPendingMessages(),
				);
				if (status === "aborted") throw new Error("wait aborted");
				const elapsedMs = Date.now() - run.started;
				if (status === "handover") {
					// The user wrote: the wait makes way for them and goes on in the background, from where it stands.
					const entry = startBackground(spec, check, run);
					const details: WaitDetails = { id: entry.id, label: spec.label, condition, status: "background", checks: run.checks, elapsedMs };
					const bound = spec.tool ? " It calls the tool through this runtime, so a /reload ends it." : "";
					const text =
						`The user sent a message, so the wait goes on in the background as ${entry.id}: ${condition}, checking every ` +
						`${formatDuration(spec.intervalMs)}; ${run.checks} check${run.checks === 1 ? "" : "s"} in ${formatDuration(elapsedMs)} so far, ` +
						`gives up at ${clock(run.started + spec.timeoutMs)}.${bound} A message brings the result; answer the user meanwhile.` +
						(run.last ? `\nLast output:\n${tail(run.last.output)}` : "");
					return { content: [{ type: "text", text }], details };
				}
				const details: WaitDetails = { label: spec.label, condition, status, checks: run.checks, elapsedMs };
				return { content: [{ type: "text", text: resultText(spec, status, run.checks, elapsedMs, run.last) }], details };
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("wait "));
			if (args.cancel) return new Text(text + theme.fg("muted", `cancel ${args.cancel}`), 0, 0);
			if (args.list) return new Text(text + theme.fg("muted", "list"), 0, 0);
			const what = args.label || (args.command ? oneLine(String(args.command), 80) : `${args.tool ?? "?"}`);
			text += theme.fg("accent", what);
			const until = args.until ?? (args.match ? "match" : "success");
			text += theme.fg("muted", ` until ${until}${args.match ? ` /${oneLine(String(args.match), 40)}/` : ""}`);
			if (args.background) text += theme.fg("dim", " (background)");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const d = result.details as WaitDetails | undefined;
			const first = result.content[0];
			const body = first?.type === "text" ? first.text : "";
			if (!d || expanded) return new Text(theme.fg("toolOutput", body), 0, 0);
			if (isPartial || d.status === "running") return new Text(theme.fg("warning", `⧗ ${body}`), 0, 0);
			const icon =
				d.status === "met" ? theme.fg("success", "✓") : d.status === "background" ? theme.fg("accent", "◆") : theme.fg("warning", "■");
			return new Text(`${icon} ${theme.fg("muted", body.split("\n")[0])}`, 0, 0);
		},
	});

	pi.registerCommand("waits", {
		description: "List the background waits, gitlab_pipeline's too (/waits cancel <id> stops one of wait's)",
		handler: async (args, ctx) => {
			const [verb, id] = args.trim().split(/\s+/);
			if (verb === "cancel" && id) {
				ctx.ui.notify(cancel(id), "info");
				return;
			}
			ctx.ui.notify(listText(allViews()), "info");
		},
	});
}
