/**
 * Claude Code hooks in Pi: runs the hooks Claude Code would run, at the matching Pi events, with Claude Code's hook
 * protocol (https://code.claude.com/docs/en/hooks): JSON on stdin, exit code 2 blocks, JSON on stdout decides.
 *
 * Hooks come from
 * - ~/.claude/settings.json (CLAUDE_CONFIG_DIR is honoured),
 * - <project>/.claude/settings.json and .claude/settings.local.json, only once the project is trusted in Pi,
 * - hooks/hooks.json of every Claude Code plugin in ~/.pi/agent/claude-plugins (one directory per plugin, or a link
 *   to one) and of every plugin Claude Code installed for the user and enabled in its user settings (a plugin in
 *   claude-plugins replaces an installed one of the same name), with CLAUDE_PLUGIN_ROOT pointing at the plugin.
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

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getPowerShellConfig, getShellConfig } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Key, matchesKey, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function readJson(file: string): any {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** The directories in dir, links to directories included. */
/**
 * The Claude Code plugins Pi uses, by name: every directory in ~/.pi/agent/claude-plugins (or a link to one), then the
 * plugins Claude Code installed for the user (plugins/installed_plugins.json) and enabled in its user settings
 * (enabledPlugins), at their installPath. A name in claude-plugins wins over an installed plugin, and the first of two
 * installed plugins of one name wins over the second. claude-agents.ts carries a copy of this function: change them alike.
 */
function claudePlugins(): { name: string; root: string }[] {
	const plugins = new Map<string, string>();
	const linked = path.join(getAgentDir(), "claude-plugins");
	try {
		for (const name of readdirSync(linked).sort()) {
			try {
				if (statSync(path.join(linked, name)).isDirectory()) plugins.set(name, path.join(linked, name));
			} catch {
				// a broken link
			}
		}
	} catch {
		// no claude-plugins
	}
	const json = (file: string): any => {
		try {
			return JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return undefined;
		}
	};
	const installed = json(path.join(claudeDir(), "plugins", "installed_plugins.json"))?.plugins ?? {};
	const enabled = json(path.join(claudeDir(), "settings.json"))?.enabledPlugins ?? {};
	for (const id of Object.keys(installed).sort()) {
		const name = id.split("@")[0];
		if (!name || enabled[id] !== true || plugins.has(name) || !Array.isArray(installed[id])) continue;
		const entry = installed[id].find((e: any) => e?.scope === "user" && typeof e.installPath === "string");
		if (entry && existsSync(entry.installPath)) plugins.set(name, entry.installPath);
	}
	return [...plugins].map(([name, root]) => ({ name, root }));
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
	for (const { name, root } of claudePlugins()) {
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
	if (process.platform === "win32") {
		// No process groups: taskkill ends the tree, by the System32 path so PATH cannot replace it.
		const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
		try {
			spawn(taskkill, ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).once("error", () => {});
		} catch {
			// gone
		}
		return;
	}
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

/**
 * The shell of a command hook, as Claude Code runs it: bash (on Windows the bash Pi uses, Git Bash) or PowerShell (on
 * Windows the one Pi's powershell tool uses, pwsh 7 or Windows PowerShell).
 */
function hookShell(powershell: boolean, command: string): [string, string[]] {
	if (process.platform === "win32") {
		const shell = powershell ? getPowerShellConfig() : getShellConfig();
		return [shell.shell, powershell ? [...shell.args, command] : ["-c", command]];
	}
	return powershell ? ["pwsh", ["-NoProfile", "-Command", command]] : ["bash", ["-c", command]];
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
		let file: string;
		let argv: string[];
		try {
			[file, argv] = exec
				? [substitute(command), (handler.args as unknown[]).map((arg) => substitute(String(arg)))]
				: hookShell(handler.shell === "powershell", command);
		} catch (error) {
			resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: error instanceof Error ? error.message : String(error) });
			return;
		}
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
			child = spawn(file, argv, { cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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

/**
 * Claude Code <-> Pi tool names and inputs, shared by the extensions that speak Claude Code's formats (hooks, subagent
 * definitions).
 *
 * claude-agents.ts, claude-remote-control.ts carry a copy of this block, or of a part of it: change them alike.
 */
/** Pi tool name -> Claude Code tool name. Tools without an entry keep their name (MCP tools, Agent, …). */
const PI_TO_CLAUDE: Record<string, string> = {
	bash: "Bash",
	powershell: "PowerShell",
	read: "Read",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
	web_fetch: "WebFetch",
	fetch_content: "WebFetch",
	web_search: "WebSearch",
	tool_search: "ToolSearch",
};

function claudeToolName(piName: string): string {
	return PI_TO_CLAUDE[piName] ?? piName;
}

type Input = Record<string, unknown>;

function absolute(cwd: string, value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
	return path.resolve(cwd, expanded);
}

/** The `tool_input` Claude Code would send to a hook for this Pi tool call. File paths are absolute, as there. */
function toClaudeInput(piName: string, input: Input, cwd: string): Input {
	switch (piName) {
		case "bash":
		case "powershell": {
			const out: Input = { command: input.command ?? "", description: input.description ?? "" };
			if (typeof input.timeout === "number") out.timeout = Math.round(input.timeout * 1000);
			return out;
		}
		case "read":
			return { file_path: absolute(cwd, input.path), offset: input.offset, limit: input.limit };
		case "write":
			return { file_path: absolute(cwd, input.path), content: input.content ?? "" };
		case "edit": {
			const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [];
			const out: Input = {
				file_path: absolute(cwd, input.path),
				edits: edits.map((e) => ({ old_string: e.oldText ?? "", new_string: e.newText ?? "" })),
				replace_all: false,
			};
			if (edits.length === 1) {
				out.old_string = edits[0].oldText ?? "";
				out.new_string = edits[0].newText ?? "";
			}
			return out;
		}
		case "grep": {
			const out: Input = { pattern: input.pattern ?? "", output_mode: "content" };
			if (input.path !== undefined) out.path = absolute(cwd, input.path);
			if (input.glob !== undefined) out.glob = input.glob;
			if (input.ignoreCase) out["-i"] = true;
			if (typeof input.context === "number") out["-C"] = input.context;
			if (typeof input.limit === "number") out.head_limit = input.limit;
			return out;
		}
		case "find": {
			const out: Input = { pattern: input.pattern ?? "" };
			if (input.path !== undefined) out.path = absolute(cwd, input.path);
			return out;
		}
		case "ls":
			return { path: absolute(cwd, input.path ?? ".") };
		case "web_search": {
			const queries = Array.isArray(input.queries) ? input.queries : [];
			return { ...input, query: input.query ?? queries[0] ?? "" };
		}
		default:
			return { ...input };
	}
}

/**
 * Applies a hook's `updatedInput` (Claude Code shape) to a Pi tool input, in place. Fields the hook left out keep their
 * Pi value only where Claude Code has no counterpart; Claude Code replaces the whole input.
 */
function applyClaudeInput(piName: string, target: Input, updated: Input): void {
	const set = (key: string, value: unknown) => {
		if (value === undefined) delete target[key];
		else target[key] = value;
	};
	switch (piName) {
		case "bash":
		case "powershell":
			if (typeof updated.command === "string") set("command", updated.command);
			if (typeof updated.timeout === "number") set("timeout", Math.max(1, Math.round(updated.timeout / 1000)));
			return;
		case "read":
			if (typeof updated.file_path === "string") set("path", updated.file_path);
			set("offset", updated.offset);
			set("limit", updated.limit);
			return;
		case "write":
			if (typeof updated.file_path === "string") set("path", updated.file_path);
			if (typeof updated.content === "string") set("content", updated.content);
			return;
		case "edit": {
			if (typeof updated.file_path === "string") set("path", updated.file_path);
			if (Array.isArray(updated.edits)) {
				set(
					"edits",
					(updated.edits as Input[]).map((e) => ({ oldText: String(e.old_string ?? ""), newText: String(e.new_string ?? "") })),
				);
			} else if (typeof updated.old_string === "string" && typeof updated.new_string === "string") {
				set("edits", [{ oldText: updated.old_string, newText: updated.new_string }]);
			}
			return;
		}
		case "grep":
			if (typeof updated.pattern === "string") set("pattern", updated.pattern);
			if ("path" in updated) set("path", updated.path);
			if ("glob" in updated) set("glob", updated.glob);
			if ("-i" in updated) set("ignoreCase", updated["-i"] === true ? true : undefined);
			return;
		case "find":
			if (typeof updated.pattern === "string") set("pattern", updated.pattern);
			if ("path" in updated) set("path", updated.path);
			return;
		case "ls":
			if ("path" in updated) set("path", updated.path);
			return;
		default:
			for (const key of Object.keys(target)) if (!(key in updated)) delete target[key];
			Object.assign(target, updated);
	}
}

/** Text of a tool result's content blocks. */
function contentText(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
		.join("\n");
}

/** The `tool_response` Claude Code would send to a PostToolUse hook, as far as Pi's result allows. */
function toClaudeResponse(
	piName: string,
	claudeInput: Input,
	text: string,
	details: unknown,
	structured: unknown,
	existedBefore: boolean | undefined,
): unknown {
	switch (piName) {
		case "bash":
		case "powershell":
			return { stdout: text, stderr: "", interrupted: false, isImage: false };
		case "write":
			return {
				type: existedBefore ? "update" : "create",
				filePath: claudeInput.file_path,
				content: claudeInput.content,
			};
		case "edit": {
			const patch = (details as { patch?: unknown } | undefined)?.patch;
			return {
				filePath: claudeInput.file_path,
				oldString: claudeInput.old_string,
				newString: claudeInput.new_string,
				replaceAll: false,
				userModified: false,
				...(typeof patch === "string" ? { patch } : {}),
			};
		}
		case "read":
			return { type: "text", file: { filePath: claudeInput.file_path, content: text } };
		default:
			return structured ?? text;
	}
}

/**
 * Framed, scrollable boxes for the extensions that show more than a notification can hold: overlays for /hooks,
 * /agents, and /cron, and the frame and scrolling of the boxes /btw and the /diff dialog show above the prompt.
 *
 * background-agents.ts, btw.ts, claude-remote-control.ts, diff.ts, scheduled-tasks.ts, subagents.ts carry a copy of
 * this block, or of a part of it: change them alike.
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
