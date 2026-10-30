/**
 * Claude Code <-> Pi tool names and inputs, shared by the extensions that speak Claude Code's formats (hooks, subagent
 * definitions).
 *
 * Pi does not load this file as an extension: it sits in a subdirectory without index.ts. Extensions import it.
 */

import * as path from "node:path";

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

/** Claude Code tool name -> the Pi tools that provide it. An empty list: Pi has no equivalent. */
const CLAUDE_TO_PI: Record<string, string[]> = {
	Bash: ["bash"],
	PowerShell: ["powershell"],
	Read: ["read"],
	Edit: ["edit"],
	MultiEdit: ["edit"],
	Write: ["write"],
	Grep: ["grep"],
	Glob: ["find"],
	LS: ["ls"],
	WebFetch: ["web_fetch", "fetch_content"],
	WebSearch: ["web_search", "get_search_content"],
	ToolSearch: ["tool_search"],
	Task: ["Agent"],
	Agent: ["Agent"],
	NotebookEdit: [],
	NotebookRead: [],
	TodoWrite: [],
	TodoRead: [],
	Skill: [],
	LSP: [],
	Monitor: [],
	TaskStop: [],
};

export function claudeToolName(piName: string): string {
	return PI_TO_CLAUDE[piName] ?? piName;
}

/**
 * The Pi tools a tool entry of a Claude Code definition names. Accepts Claude Code names, Pi names, and permission-rule
 * specifiers such as `Bash(git *)`, which name the whole tool. Unknown names come back unchanged, so MCP tools and Pi
 * extension tools pass through.
 */
export function piToolNames(entry: string): string[] {
	const name = entry.trim().replace(/\(.*\)$/s, "").trim();
	if (!name) return [];
	return CLAUDE_TO_PI[name] ?? [name];
}

type Input = Record<string, unknown>;

function absolute(cwd: string, value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const expanded = value === "~" || value.startsWith("~/") ? path.join(process.env.HOME ?? "", value.slice(1)) : value;
	return path.resolve(cwd, expanded);
}

/** The `tool_input` Claude Code would send to a hook for this Pi tool call. File paths are absolute, as there. */
export function toClaudeInput(piName: string, input: Input, cwd: string): Input {
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
export function applyClaudeInput(piName: string, target: Input, updated: Input): void {
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
export function contentText(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
		.join("\n");
}

/** The `tool_response` Claude Code would send to a PostToolUse hook, as far as Pi's result allows. */
export function toClaudeResponse(
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
