/**
 * Claude Code hooks in Pi: runs the hooks Claude Code would run, at the matching Pi events, with Claude Code's hook
 * protocol (https://code.claude.com/docs/en/hooks): JSON on stdin, exit code 2 blocks, JSON on stdout decides.
 *
 * Hooks come from
 * - ~/.claude/settings.json (CLAUDE_CONFIG_DIR is honoured),
 * - <project>/.claude/settings.json and .claude/settings.local.json, only once the project is trusted in Pi,
 * - hooks/hooks.json of every Claude Code plugin in ~/.pi/agent/claude-plugins (one directory per plugin), with
 *   CLAUDE_PLUGIN_ROOT pointing at the plugin.
 * `disableAllHooks: true` in one of the settings files turns them all off.
 *
 * Events, and the Pi event each one runs at:
 * - SessionStart (startup, resume, clear, fork, compact): session_start and after compaction. Plain stdout and
 *   additionalContext go into the system prompt, so they hold for the whole session and survive compaction.
 * - UserPromptSubmit: input. Blocks the prompt, or adds context next to it.
 * - PreToolUse: tool_call. deny/exit 2 block the call, ask asks the user, updatedInput rewrites it, additionalContext is
 *   appended to the result.
 * - PostToolUse / PostToolUseFailure: tool_result. Exit 2 stderr, decision "block", and additionalContext are appended
 *   to the result; updatedToolOutput replaces it.
 * - Stop: agent_before_settle. Exit 2 or decision "block" continues the run with the reason (at most 8 times in a row,
 *   CLAUDE_CODE_STOP_HOOK_BLOCK_CAP).
 * - SubagentStart / SubagentStop: the same, inside a subagent process (subagents.ts), instead of SessionStart / Stop.
 * - PreCompact (can cancel), PostCompact, SessionEnd, Notification (idle_prompt after 60 s idle).
 * Other events never fire in Pi. Handler types: command and http; prompt, agent, and mcp_tool hooks are skipped.
 *
 * Tools reach hooks under their Claude Code names (bash -> Bash, read -> Read, find -> Glob, …) with Claude Code's
 * tool_input fields (file_path, old_string/new_string, edits[], …). Skill names in hook output are rewritten to Pi's
 * (my-plugin:my-skill -> my-plugin-my-skill). /hooks lists what is configured.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyClaudeInput,
	claudeToolName,
	contentText,
	toClaudeInput,
	toClaudeResponse,
} from "./lib/claude-tools.ts";
import { showText } from "./lib/overlay.ts";

const DEFAULT_TIMEOUT_S = 600;
const PROMPT_TIMEOUT_S = 30;
const SESSION_END_BUDGET_MS = 1_500;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const CONTEXT_CAP = 10_000;
const CONTEXT_PREVIEW = 2_000;
const IDLE_NOTIFICATION_MS = 60_000;
const SESSION_START_WAIT_MS = 120_000;

const SUPPORTED_EVENTS = new Set([
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"PreCompact",
	"PostCompact",
	"SessionEnd",
	"Notification",
]);
const SUPPORTED_TYPES = new Set(["command", "http"]);
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
const CLAUDE_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);

interface Handler {
	type: string;
	command?: string;
	args?: unknown;
	timeout?: number;
	async?: boolean;
	asyncRewake?: boolean;
	shell?: string;
	onFailure?: string;
	if?: string;
	url?: string;
	headers?: Record<string, string>;
	allowedEnvVars?: string[];
}

interface Hook {
	event: string;
	matcher: string;
	handler: Handler;
	source: string;
	pluginRoot?: string;
	pluginName?: string;
}

interface Config {
	hooks: Hook[];
	all: Hook[];
	disabledBy?: string;
	files: string[];
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	error?: string;
}

interface Outcome {
	hook: Hook;
	label: string;
	/** Exit code 2. */
	blocking: boolean;
	/** Could not start, timed out, invalid JSON, or an exit code other than 0 and 2 without valid JSON. */
	failed: boolean;
	failure?: string;
	json?: Record<string, any>;
	/** Plain-text stdout of a successful run. */
	text?: string;
	stderr: string;
}

function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

function readJson(file: string): any {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function listDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function hooksFrom(config: any, source: string, plugin?: { pluginRoot: string; pluginName: string }): Hook[] {
	const out: Hook[] = [];
	const hooks = config?.hooks;
	if (!hooks || typeof hooks !== "object") return out;
	for (const [event, groups] of Object.entries(hooks)) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			if (!group || !Array.isArray(group.hooks)) continue;
			const matcher = typeof group.matcher === "string" ? group.matcher : "";
			for (const handler of group.hooks) {
				if (handler && typeof handler.type === "string") out.push({ event, matcher, handler, source, ...plugin });
			}
		}
	}
	return out;
}

function loadConfig(cwd: string, trusted: boolean): Config {
	const settings: Array<[string, string]> = [[path.join(claudeDir(), "settings.json"), "user"]];
	if (trusted) {
		settings.push([path.join(cwd, ".claude", "settings.json"), "project"]);
		settings.push([path.join(cwd, ".claude", "settings.local.json"), "local"]);
	}
	const files: string[] = [];
	const all: Hook[] = [];
	const seen = new Set<string>();
	let disabledBy: string | undefined;
	for (const [file, source] of settings) {
		const json = readJson(file);
		if (!json) continue;
		files.push(file);
		if (json.disableAllHooks === true) disabledBy = file;
		for (const hook of hooksFrom(json, source)) {
			// The same handler in several settings files runs once.
			const key = `${hook.event}\0${hook.matcher}\0${JSON.stringify(hook.handler)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			all.push(hook);
		}
	}
	const pluginsDir = path.join(getAgentDir(), "claude-plugins");
	for (const name of listDirs(pluginsDir)) {
		const root = path.join(pluginsDir, name);
		const file = path.join(root, "hooks", "hooks.json");
		const json = readJson(file);
		if (!json) continue;
		files.push(file);
		all.push(...hooksFrom(json, `plugin:${name}`, { pluginRoot: root, pluginName: name }));
	}
	return { hooks: disabledBy ? [] : all, all, disabledBy, files };
}

/** Claude Code's matcher rules: "", "*" match all; letters, digits, _ - space , | are an exact list; else a regex. */
function matcherMatches(matcher: string, value: string | undefined): boolean {
	if (matcher === "" || matcher === "*" || value === undefined) return true;
	if (/^[A-Za-z0-9_\-\s,|]+$/.test(matcher)) {
		return matcher
			.split(/[|,]/)
			.map((part) => part.trim())
			.filter(Boolean)
			.includes(value);
	}
	try {
		return new RegExp(matcher).test(value);
	} catch {
		return false;
	}
}

function globToRegExp(glob: string, paths: boolean): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			out += ".*";
			i++;
			if (glob[i + 1] === "/") i++;
		} else if (c === "*") out += paths ? "[^/]*" : ".*";
		else if (c === "?") out += paths ? "[^/]" : ".";
		else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`, "s");
}

/** The handler's `if` rule (permission-rule syntax), best effort: when the call cannot be judged, the hook runs. */
function ifMatches(rule: unknown, toolName: string | undefined, toolInput: Record<string, unknown>, cwd: string): boolean {
	if (rule === undefined) return true;
	if (!toolName || typeof rule !== "string") return false;
	const match = rule.trim().match(/^([A-Za-z0-9_\-]+)(?:\((.*)\))?$/s);
	if (!match) return true;
	if (match[1] !== toolName) return false;
	const pattern = match[2]?.trim();
	if (!pattern || pattern === "*") return true;
	if (toolName === "Bash" || toolName === "PowerShell") {
		const command = String(toolInput.command ?? "");
		if (/\$\(|`|\$[A-Za-z_{]/.test(command) && /\s/.test(pattern)) return true;
		const parts = command.split(/&&|\|\||[;|\n]/);
		for (const inner of command.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) parts.push(...(inner[1] ?? inner[2] ?? "").split(/&&|\|\||[;|]/));
		const subcommands = parts.map((s) => s.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, "")).filter(Boolean);
		const re = globToRegExp(pattern, false);
		const bare = pattern.endsWith(" *") ? pattern.slice(0, -2) : undefined;
		return subcommands.some((s) => re.test(s) || s === bare);
	}
	const target = [toolInput.file_path, toolInput.path, toolInput.url, toolInput.pattern].find((v) => typeof v === "string") as
		| string
		| undefined;
	if (!target) return true;
	const relative = path.isAbsolute(target) ? path.relative(cwd, target) : target;
	const re = globToRegExp(pattern, true);
	if (re.test(relative) || re.test(target)) return true;
	return !pattern.includes("/") && re.test(path.basename(target));
}

function handlerLabel(handler: Handler): string {
	if (handler.type === "http") return handler.url ?? "http";
	const args = Array.isArray(handler.args) ? ` ${handler.args.join(" ")}` : "";
	return `${handler.command ?? handler.type}${args}`;
}

function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// gone
		}
	}
}

function runCommand(
	handler: Handler,
	input: string,
	env: NodeJS.ProcessEnv,
	cwd: string,
	timeoutMs: number,
	substitute: (s: string) => string,
): Promise<RunResult> {
	return new Promise((resolve) => {
		const command = handler.command ?? "";
		const exec = Array.isArray(handler.args);
		const file = exec ? substitute(command) : handler.shell === "powershell" ? "pwsh" : "bash";
		const argv = exec
			? (handler.args as unknown[]).map((arg) => substitute(String(arg)))
			: handler.shell === "powershell"
				? ["-NoProfile", "-Command", command]
				: ["-c", command];
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const finish = (result: RunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(file, argv, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child.pid, "SIGTERM");
			setTimeout(() => killTree(child.pid, "SIGKILL"), 2_000).unref();
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
		child.on("error", (error) => finish({ code: null, stdout, stderr, timedOut, error: error.message }));
		child.on("close", (code) => finish({ code: timedOut ? null : code, stdout, stderr, timedOut }));
	});
}

async function runHttp(handler: Handler, input: string, timeoutMs: number): Promise<RunResult> {
	const allowed = new Set(Array.isArray(handler.allowedEnvVars) ? handler.allowedEnvVars : []);
	const headers: Record<string, string> = { "content-type": "application/json" };
	for (const [key, value] of Object.entries(handler.headers ?? {})) {
		headers[key] = String(value).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) =>
			allowed.has(name) ? (process.env[name] ?? "") : whole,
		);
	}
	try {
		const response = await fetch(String(handler.url), {
			method: "POST",
			headers,
			body: input,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const body = (await response.text()).trim();
		if (!response.ok) return { code: 1, stdout: "", stderr: `HTTP ${response.status}`, timedOut: false };
		if (body && !(body.startsWith("{") && body.endsWith("}"))) {
			return { code: 1, stdout: "", stderr: "response body is not a JSON object", timedOut: false };
		}
		return { code: 0, stdout: body, stderr: "", timedOut: false };
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return { code: null, stdout: "", stderr: "", timedOut, error: timedOut ? undefined : String(error) };
	}
}

/** Claude Code's reading of a hook run: exit code, plain text, or one JSON object on stdout. */
function interpret(hook: Hook, run: RunResult, timeoutS: number): Outcome {
	const label = handlerLabel(hook.handler);
	const stderr = run.stderr.trim();
	const out = run.stdout.trim();
	let json: Record<string, any> | undefined;
	let parseError: string | undefined;
	if (out.startsWith("{") && out.endsWith("}")) {
		try {
			const value = JSON.parse(out);
			if (value && typeof value === "object" && !Array.isArray(value)) json = value;
			else parseError = "hook JSON output is not an object";
		} catch (error) {
			parseError = `invalid hook JSON output: ${error instanceof Error ? error.message : error}`;
		}
	}
	const base = { hook, label, stderr, json };
	if (run.timedOut) return { ...base, json: undefined, blocking: false, failed: true, failure: `timed out after ${timeoutS}s` };
	if (run.error) return { ...base, blocking: false, failed: true, failure: run.error };
	if (run.code === 2) return { ...base, blocking: true, failed: false };
	if (parseError) return { ...base, blocking: false, failed: true, failure: parseError };
	if (run.code === 0) return { ...base, blocking: false, failed: false, text: json ? undefined : out };
	if (json) return { ...base, blocking: false, failed: hook.handler.onFailure === "block", failure: `exit code ${run.code}` };
	return {
		...base,
		blocking: false,
		failed: true,
		failure: `Failed with non-blocking status code: ${firstLine(stderr) || `exit code ${run.code}`}`,
	};
}

export default function (pi: ExtensionAPI) {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH || 0);
	const subagent = depth > 0 ? { id: process.env.PI_SUBAGENT_ID ?? "", type: process.env.PI_SUBAGENT_TYPE ?? "" } : null;
	let config: Config = { hooks: [], all: [], files: [] };
	let projectDir = process.cwd();
	let sessionContext: string[] = [];
	let sessionStartRun: Promise<void> | null = null;
	let promptContext: string[] = [];
	let stopHookActive = false;
	let stopContinuations = 0;
	let idleTimer: NodeJS.Timeout | null = null;
	/** Bumped at every session start and shutdown; async work started for an older value must not touch its ctx. */
	let generation = 0;
	const toolContext = new Map<string, string[]>();
	const toolMeta = new Map<string, { startedAt: number; existed?: boolean; claudeInput: Record<string, unknown> }>();

	const stopCap = Number(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP) || 8;
	const dataDirs = new Set<string>();

	function reload(ctx: ExtensionContext): void {
		config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
	}

	function hooksFor(event: string): Hook[] {
		return config.hooks.filter((hook) => hook.event === event && SUPPORTED_TYPES.has(hook.handler.type));
	}

	/** my-plugin:my-skill -> my-plugin-my-skill, for every plugin-scoped skill Pi knows under the dashed name. */
	function piSkillNames(text: string): string {
		if (!text.includes(":")) return text;
		const skills = new Set(
			pi
				.getCommands()
				.filter((command) => command.source === "skill")
				.map((command) => command.name.replace(/^skill:/, "")),
		);
		return text.replace(/(\/?)\b([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)\b/g, (whole, slash: string, plugin: string, skill: string) => {
			const name = `${plugin}-${skill}`;
			if (!skills.has(name)) return whole;
			return slash ? `/skill:${name}` : name;
		});
	}

	/** Claude Code's 10,000-character cap on hook context: longer text goes to a file, with a preview. */
	function capped(text: string, ctx: ExtensionContext, label: string): string {
		const clean = piSkillNames(text.replace(/<(\/?)system-reminder>/g, "&lt;$1system-reminder>"));
		if (clean.length <= CONTEXT_CAP) return clean;
		const dir = path.join(os.tmpdir(), "pi-hooks", ctx.sessionManager.getSessionId());
		mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${Date.now()}-${label.replace(/[^A-Za-z0-9_-]+/g, "_")}.txt`);
		writeFileSync(file, clean, { mode: 0o600 });
		return `${label} output was ${clean.length} characters and was saved to ${file}. Preview:\n${clean.slice(0, CONTEXT_PREVIEW)}`;
	}

	function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "warning"): void {
		try {
			if (ctx.hasUI) ctx.ui.notify(text, level);
		} catch {
			// The session was replaced meanwhile.
		}
	}

	function commonInput(ctx: ExtensionContext, event: string): Record<string, unknown> {
		const level = pi.getThinkingLevel();
		return {
			session_id: ctx.sessionManager.getSessionId(),
			transcript_path: ctx.sessionManager.getSessionFile() ?? "",
			cwd: ctx.cwd,
			permission_mode: "bypassPermissions",
			hook_event_name: event,
			...(CLAUDE_EFFORT.has(level) ? { effort: { level } } : {}),
			...(subagent ? { agent_id: subagent.id, agent_type: subagent.type } : {}),
		};
	}

	/**
	 * Runs the hooks of `event` whose matcher fits `matchValue`, in parallel, and returns their outcomes. Async hooks
	 * are started and left running; an asyncRewake hook that exits 2 wakes the session with its output.
	 */
	async function fire(
		ctx: ExtensionContext,
		event: string,
		matchValue: string | undefined,
		fields: Record<string, unknown>,
		options: { defaultTimeoutS?: number; toolName?: string; toolInput?: Record<string, unknown>; budgetMs?: number } = {},
	): Promise<Outcome[]> {
		const hooks = hooksFor(event).filter(
			(hook) =>
				matcherMatches(hook.matcher, matchValue) &&
				ifMatches(hook.handler.if, TOOL_EVENTS.has(event) ? options.toolName : undefined, options.toolInput ?? {}, ctx.cwd),
		);
		if (hooks.length === 0) return [];
		const gen = generation;
		const input = JSON.stringify({ ...commonInput(ctx, event), ...fields });
		const cwd = existsSync(ctx.cwd) ? ctx.cwd : existsSync(projectDir) ? projectDir : os.homedir();
		const level = pi.getThinkingLevel();

		const runs = hooks.map(async (hook): Promise<Outcome | null> => {
			const timeoutS = typeof hook.handler.timeout === "number" ? hook.handler.timeout : (options.defaultTimeoutS ?? DEFAULT_TIMEOUT_S);
			const timeoutMs = Math.min(timeoutS * 1000, options.budgetMs ?? Number.POSITIVE_INFINITY);
			const dataDir = hook.pluginName ? path.join(getAgentDir(), "plugin-data", hook.pluginName) : undefined;
			if (dataDir && !dataDirs.has(dataDir)) {
				mkdirSync(dataDir, { recursive: true });
				dataDirs.add(dataDir);
			}
			const env: NodeJS.ProcessEnv = {
				...process.env,
				CLAUDE_PROJECT_DIR: projectDir,
				...(hook.pluginRoot ? { CLAUDE_PLUGIN_ROOT: hook.pluginRoot } : {}),
				...(dataDir ? { CLAUDE_PLUGIN_DATA: dataDir } : {}),
				...(CLAUDE_EFFORT.has(level) ? { CLAUDE_EFFORT: level } : {}),
			};
			const substitute = (s: string) =>
				s
					.replaceAll("${CLAUDE_PROJECT_DIR}", projectDir)
					.replaceAll("${CLAUDE_PLUGIN_ROOT}", hook.pluginRoot ?? "")
					.replaceAll("${CLAUDE_PLUGIN_DATA}", dataDir ?? "");
			const run = () =>
				hook.handler.type === "http"
					? runHttp(hook.handler, input, timeoutMs)
					: runCommand(hook.handler, input, env, cwd, timeoutMs, substitute);
			if (hook.handler.async || hook.handler.asyncRewake) {
				run()
					.then((result) => {
						if (!hook.handler.asyncRewake || result.code !== 2 || gen !== generation) return;
						const text = result.stderr.trim() || result.stdout.trim();
						pi.sendMessage(
							{ customType: "claude-hook", content: `${event} hook (background) reported:\n${capped(text, ctx, event)}`, display: true },
							{ triggerTurn: true, deliverAs: "followUp" },
						);
					})
					.catch(() => {});
				return null;
			}
			return interpret(hook, await run(), timeoutS);
		});
		const outcomes = (await Promise.all(runs)).filter((o): o is Outcome => o !== null);
		if (gen !== generation) return [];
		for (const outcome of outcomes) {
			const where = options.toolName ? `${event}:${options.toolName}` : event;
			if (outcome.failed && outcome.hook.handler.onFailure !== "block") {
				notify(ctx, `${where} hook error: [${outcome.label}]: ${outcome.failure}`);
			}
			const message = outcome.json?.systemMessage;
			if (typeof message === "string" && message.trim()) notify(ctx, piSkillNames(message));
		}
		return outcomes;
	}

	function additionalContext(outcome: Outcome): string | undefined {
		const value = outcome.json?.hookSpecificOutput?.additionalContext;
		return typeof value === "string" && value.trim() ? value : undefined;
	}

	// --- SessionStart / SubagentStart ---------------------------------------------------------------------------

	async function runSessionStart(ctx: ExtensionContext, source: string): Promise<void> {
		const gen = generation;
		const event = subagent ? "SubagentStart" : "SessionStart";
		const fields = subagent ? {} : { source, model: ctx.model?.id, ...(pi.getSessionName() ? { session_title: pi.getSessionName() } : {}) };
		const outcomes = await fire(ctx, event, subagent ? subagent.type : source, fields);
		if (gen !== generation) return;
		const contexts: string[] = [];
		for (const outcome of outcomes) {
			if (outcome.blocking && outcome.stderr) notify(ctx, `${event} hook error: [${outcome.label}]: ${firstLine(outcome.stderr)}`);
			const text = outcome.text ?? additionalContext(outcome);
			if (text) contexts.push(capped(text, ctx, event));
			const title = outcome.json?.hookSpecificOutput?.sessionTitle;
			if (typeof title === "string" && title.trim() && !pi.getSessionName() && source !== "compact") pi.setSessionName(title.trim());
		}
		sessionContext = contexts;
	}

	function startSessionHooks(ctx: ExtensionContext, source: string): void {
		const run = runSessionStart(ctx, source).catch((error) => notify(ctx, `SessionStart hooks failed: ${error}`));
		sessionStartRun = run;
		run.finally(() => {
			if (sessionStartRun === run) sessionStartRun = null;
		});
	}

	pi.on("session_start", (event, ctx) => {
		generation++;
		projectDir = ctx.cwd;
		reload(ctx);
		const source = { startup: "startup", resume: "resume", new: "clear", fork: "fork", reload: "resume" }[event.reason];
		sessionContext = [];
		startSessionHooks(ctx, source);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (sessionStartRun) {
			await Promise.race([sessionStartRun, new Promise((r) => setTimeout(r, SESSION_START_WAIT_MS))]);
		}
		reload(ctx);
		const sections = event.systemPromptOptions.sections as Record<string, string | undefined>;
		if (sessionContext.length > 0) {
			sections.claude_hooks = [
				`Context from Claude Code ${subagent ? "SubagentStart" : "SessionStart"} hooks, read at the start of this session:`,
				...sessionContext,
			].join("\n\n");
		} else {
			delete sections.claude_hooks;
		}
		if (event.messageType === "user") {
			stopHookActive = false;
			stopContinuations = 0;
		}
		if (promptContext.length === 0) return;
		const content = `UserPromptSubmit hook additional context:\n${promptContext.join("\n\n")}`;
		promptContext = [];
		return { message: { customType: "claude-hook-context", content, display: false } };
	});

	// --- UserPromptSubmit ----------------------------------------------------------------------------------------

	pi.on("input", async (event, ctx) => {
		clearIdle();
		// A subagent's task comes from the agent that started it, not from the user.
		if (subagent) return { action: "continue" };
		const commandName = event.text.match(/^\/(\S+)/)?.[1];
		if (commandName && pi.getCommands().some((c) => c.source === "extension" && c.name === commandName)) {
			return { action: "continue" };
		}
		if (hooksFor("UserPromptSubmit").length === 0) return { action: "continue" };
		const title = pi.getSessionName();
		const outcomes = await fire(
			ctx,
			"UserPromptSubmit",
			undefined,
			{ prompt: event.text, ...(title ? { session_title: title } : {}) },
			{ defaultTimeoutS: PROMPT_TIMEOUT_S },
		);
		const contexts: string[] = [];
		let blocked: string | undefined;
		let suppress = false;
		for (const outcome of outcomes) {
			const hso = outcome.json?.hookSpecificOutput ?? {};
			if (hso.suppressOriginalPrompt === true) suppress = true;
			if (outcome.blocking) blocked ??= outcome.stderr || "blocked by hook";
			else if (outcome.failed && outcome.hook.handler.onFailure === "block") {
				blocked ??= `[${outcome.label}] ${outcome.failure}; blocking because onFailure is "block"`;
			}
			if (outcome.json?.decision === "block") blocked ??= String(outcome.json.reason ?? "blocked by hook");
			if (outcome.json?.continue === false) blocked ??= String(outcome.json.stopReason ?? "stopped by hook");
			const text = outcome.text ?? additionalContext(outcome);
			if (text) contexts.push(capped(text, ctx, "UserPromptSubmit"));
			if (typeof hso.sessionTitle === "string" && hso.sessionTitle.trim()) pi.setSessionName(hso.sessionTitle.trim());
		}
		if (blocked !== undefined) {
			const original = suppress ? "" : `\nOriginal prompt: ${event.text}`;
			notify(ctx, `UserPromptSubmit hook blocked the prompt: ${piSkillNames(blocked)}${original}`, "error");
			return { action: "handled" };
		}
		if (contexts.length > 0) {
			if (event.streamingBehavior) {
				pi.sendMessage(
					{ customType: "claude-hook-context", content: `UserPromptSubmit hook additional context:\n${contexts.join("\n\n")}`, display: false },
					{ deliverAs: event.streamingBehavior },
				);
			} else {
				promptContext.push(...contexts);
			}
		}
		return { action: "continue" };
	});

	// --- PreToolUse ----------------------------------------------------------------------------------------------

	const PRECEDENCE: Record<string, number> = { allow: 1, ask: 2, defer: 3, deny: 4 };

	pi.on("tool_call", async (event, ctx) => {
		stopContinuations = 0;
		const toolName = claudeToolName(event.toolName);
		const input = event.input as Record<string, unknown>;
		const claudeInput = toClaudeInput(event.toolName, input, ctx.cwd);
		const existed =
			event.toolName === "write" && typeof claudeInput.file_path === "string" ? existsSync(claudeInput.file_path) : undefined;
		if (toolMeta.size > 500) toolMeta.clear();
		toolMeta.set(event.toolCallId, { startedAt: Date.now(), existed, claudeInput });
		if (hooksFor("PreToolUse").length === 0) return;

		const outcomes = await fire(
			ctx,
			"PreToolUse",
			toolName,
			{ tool_name: toolName, tool_input: claudeInput, tool_use_id: event.toolCallId },
			{ toolName, toolInput: claudeInput },
		);
		let decision: string | undefined;
		const reasons: Record<string, string[]> = { allow: [], ask: [], defer: [], deny: [] };
		const contexts: string[] = [];
		let updated: Record<string, unknown> | undefined;
		let stop: string | undefined;
		const decide = (value: string, reason: string | undefined) => {
			if (!(value in PRECEDENCE)) return;
			if (!decision || PRECEDENCE[value] > PRECEDENCE[decision]) decision = value;
			if (reason) reasons[value].push(reason);
		};
		for (const outcome of outcomes) {
			if (outcome.blocking) {
				decide("deny", `PreToolUse:${toolName} hook error: [${outcome.label}]: ${outcome.stderr || "blocked"}`);
			} else if (outcome.failed && outcome.hook.handler.onFailure === "block") {
				decide("deny", `PreToolUse:${toolName} hook error: [${outcome.label}]: ${outcome.failure}; blocking because onFailure is "block"`);
			}
			const json = outcome.json;
			if (!json) continue;
			const hso = json.hookSpecificOutput ?? {};
			const legacy = json.decision === "approve" ? "allow" : json.decision === "block" ? "deny" : undefined;
			const value = typeof hso.permissionDecision === "string" ? hso.permissionDecision : legacy;
			const reason = typeof hso.permissionDecisionReason === "string" ? hso.permissionDecisionReason : json.reason;
			if (value) decide(value, typeof reason === "string" ? reason : undefined);
			if (!outcome.blocking && hso.updatedInput && typeof hso.updatedInput === "object") updated = hso.updatedInput;
			const context = additionalContext(outcome);
			if (context) contexts.push(capped(context, ctx, "PreToolUse"));
			if (json.continue === false) stop = String(json.stopReason ?? "Stopped by a PreToolUse hook");
		}
		if (contexts.length > 0) toolContext.set(event.toolCallId, contexts.map((c) => `PreToolUse:${toolName} hook additional context: ${c}`));

		if (stop !== undefined) {
			notify(ctx, piSkillNames(stop));
			setTimeout(() => ctx.abort(), 0);
			return { block: true, reason: piSkillNames(stop) };
		}
		if (decision === "deny" || decision === "defer") {
			const reason = reasons[decision].join("\n") || `Blocked by a PreToolUse hook (${decision}).`;
			return { block: true, reason: piSkillNames(reason) };
		}
		if (decision === "ask") {
			const reason = piSkillNames(reasons.ask.join("\n") || "A hook asks for confirmation.");
			if (!ctx.hasUI) return { block: true, reason: `${reason}\n(No one can confirm this call in this mode.)` };
			const ok = await ctx.ui.confirm(`Allow ${toolName}?`, `${reason}\n\n${JSON.stringify(claudeInput, null, 2).slice(0, 1500)}`);
			if (!ok) return { block: true, reason: `The user declined this ${toolName} call. ${reason}` };
		}
		if (updated) applyClaudeInput(event.toolName, input, updated);
	});

	// --- PostToolUse / PostToolUseFailure ------------------------------------------------------------------------

	pi.on("tool_result", async (event, ctx) => {
		const meta = toolMeta.get(event.toolCallId);
		toolMeta.delete(event.toolCallId);
		const extra = toolContext.get(event.toolCallId) ?? [];
		toolContext.delete(event.toolCallId);
		const name = event.isError ? "PostToolUseFailure" : "PostToolUse";
		let replaced: string | undefined;

		if (hooksFor(name).length > 0) {
			const toolName = claudeToolName(event.toolName);
			const claudeInput = meta?.claudeInput ?? toClaudeInput(event.toolName, event.input, ctx.cwd);
			const text = contentText(event.content);
			const fields: Record<string, unknown> = {
				tool_name: toolName,
				tool_input: claudeInput,
				tool_use_id: event.toolCallId,
				...(meta ? { duration_ms: Date.now() - meta.startedAt } : {}),
			};
			if (event.isError) {
				fields.error = text;
				fields.is_interrupt = ctx.signal?.aborted === true;
			} else {
				fields.tool_response = toClaudeResponse(event.toolName, claudeInput, text, event.details, event.structuredContent, meta?.existed);
			}
			const outcomes = await fire(ctx, name, toolName, fields, { toolName, toolInput: claudeInput });
			for (const outcome of outcomes) {
				if (outcome.blocking && outcome.stderr) extra.push(`${name}:${toolName} hook feedback:\n${capped(outcome.stderr, ctx, name)}`);
				const json = outcome.json;
				if (!json) continue;
				if (json.decision === "block" && json.reason) extra.push(`${name}:${toolName} hook: ${capped(String(json.reason), ctx, name)}`);
				const context = additionalContext(outcome);
				if (context) extra.push(`${name}:${toolName} hook additional context: ${capped(context, ctx, name)}`);
				const output = json.hookSpecificOutput?.updatedToolOutput ?? json.hookSpecificOutput?.updatedMCPToolOutput;
				if (!event.isError && output !== undefined) {
					replaced =
						typeof output === "string"
							? output
							: typeof output?.stdout === "string"
								? [output.stdout, output.stderr].filter(Boolean).join("\n")
								: JSON.stringify(output);
				}
				if (json.continue === false) {
					notify(ctx, piSkillNames(String(json.stopReason ?? "Stopped by a hook")));
					setTimeout(() => ctx.abort(), 0);
				}
			}
		}

		if (replaced === undefined && extra.length === 0) return;
		const blocks = extra.map((text) => ({ type: "text" as const, text: `\n${text}` }));
		if (replaced !== undefined) return { content: [{ type: "text", text: replaced }, ...blocks] };
		return { content: [...event.content, ...blocks], structuredContent: event.structuredContent };
	});

	// --- Stop / SubagentStop -------------------------------------------------------------------------------------

	function lastAssistantText(messages: ReadonlyArray<{ role: string; content?: unknown }>): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			return (message.content as Array<{ type: string; text?: string }>)
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
		}
		return "";
	}

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") return;
		const name = subagent ? "SubagentStop" : "Stop";
		if (hooksFor(name).length === 0) return;
		if (stopContinuations >= stopCap) {
			stopContinuations = 0;
			notify(ctx, `${name} hooks continued the run ${stopCap} times in a row; ending the turn.`);
			return;
		}
		const fields: Record<string, unknown> = {
			stop_hook_active: stopHookActive,
			last_assistant_message: lastAssistantText(event.context.contextMessages as Array<{ role: string; content?: unknown }>),
			background_tasks: [],
			session_crons: [],
			...(subagent ? { agent_transcript_path: ctx.sessionManager.getSessionFile() ?? "" } : {}),
		};
		const outcomes = await fire(ctx, name, subagent?.type, fields);
		const feedback: string[] = [];
		for (const outcome of outcomes) {
			if (outcome.blocking) feedback.push(outcome.stderr || "A stop hook asks to continue.");
			if (outcome.json?.decision === "block") feedback.push(String(outcome.json.reason ?? "A stop hook asks to continue."));
			const context = additionalContext(outcome);
			if (context) feedback.push(context);
		}
		if (feedback.length === 0) return;
		stopHookActive = true;
		stopContinuations++;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: "claude-hook",
					content: `${name} hook feedback:\n${feedback.map((f) => capped(f, ctx, name)).join("\n\n")}`,
					display: true,
				},
			],
			continue: true,
		};
	});

	// --- Compaction, session end, idle notification ------------------------------------------------------------

	pi.on("session_before_compact", async (event, ctx) => {
		if (hooksFor("PreCompact").length === 0) return;
		const trigger = event.reason === "manual" ? "manual" : "auto";
		const outcomes = await fire(ctx, "PreCompact", trigger, { trigger, custom_instructions: event.customInstructions ?? "" });
		const block = outcomes.find((o) => o.blocking || o.json?.decision === "block");
		if (!block) return;
		notify(ctx, `PreCompact hook blocked compaction: ${piSkillNames(block.stderr || String(block.json?.reason ?? ""))}`);
		return { cancel: true };
	});

	pi.on("session_compact", async (event, ctx) => {
		const trigger = event.reason === "manual" ? "manual" : "auto";
		if (hooksFor("PostCompact").length > 0) {
			await fire(ctx, "PostCompact", trigger, { trigger, compact_summary: event.compactionEntry.summary });
		}
		if (!subagent) startSessionHooks(ctx, "compact");
	});

	function clearIdle(): void {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
	}

	pi.on("agent_start", () => clearIdle());

	pi.on("agent_settled", (_event, ctx) => {
		clearIdle();
		if (subagent || !ctx.hasUI || hooksFor("Notification").length === 0) return;
		const gen = generation;
		idleTimer = setTimeout(() => {
			idleTimer = null;
			if (gen !== generation) return;
			void fire(ctx, "Notification", "idle_prompt", {
				message: "Claude is waiting for your input",
				notification_type: "idle_prompt",
			});
		}, IDLE_NOTIFICATION_MS);
		idleTimer.unref();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		clearIdle();
		sessionStartRun = null;
		if (subagent || hooksFor("SessionEnd").length === 0) {
			generation++;
			return;
		}
		const reason = { quit: "prompt_input_exit", new: "clear", resume: "resume", fork: "other", reload: "other" }[event.reason];
		const longest = Math.max(0, ...hooksFor("SessionEnd").map((h) => (h.handler.timeout ?? 0) * 1000));
		await fire(ctx, "SessionEnd", reason, { reason }, { budgetMs: Math.min(60_000, Math.max(SESSION_END_BUDGET_MS, longest)) });
		generation++;
	});

	// --- /hooks ---------------------------------------------------------------------------------------------------

	pi.registerCommand("hooks", {
		description: "Show the Claude Code hooks Pi runs (settings files and plugins)",
		handler: async (_args, ctx) => {
			reload(ctx);
			await showText(ctx, "Claude Code hooks", (_width, theme) => {
				const lines: string[] = [];
				if (config.disabledBy) lines.push(theme.fg("warning", `All hooks are off: disableAllHooks in ${config.disabledBy}`), "");
				if (!ctx.isProjectTrusted()) lines.push(theme.fg("muted", "Project hooks (.claude/settings*.json) wait for project trust."), "");
				if (config.all.length === 0) lines.push("No hooks configured.");
				const events = [...new Set(config.all.map((h) => h.event))];
				for (const event of events) {
					const supported = SUPPORTED_EVENTS.has(event);
					lines.push(theme.bold(event) + (supported ? "" : theme.fg("warning", "  (never fires in Pi)")));
					for (const hook of config.all.filter((h) => h.event === event)) {
						const type = hook.handler.type;
						const note = SUPPORTED_TYPES.has(type) ? "" : theme.fg("warning", ` (${type} hooks are skipped)`);
						const matcher = hook.matcher ? `[${hook.matcher}] ` : "";
						const cond = typeof hook.handler.if === "string" ? ` if ${hook.handler.if}` : "";
						lines.push(`  ${theme.fg("accent", hook.source)} ${matcher}${handlerLabel(hook.handler).replace(hook.pluginRoot ?? "\0", "${CLAUDE_PLUGIN_ROOT}")}${cond}${note}`);
					}
					lines.push("");
				}
				lines.push(theme.fg("dim", `Read from: ${config.files.map((f) => f.replace(os.homedir(), "~")).join(", ") || "nothing"}`));
				return lines;
			});
		},
	});
}
