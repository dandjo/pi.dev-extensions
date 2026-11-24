/**
 * Claude Code agents: Claude Code's agent definitions and settings for the agent tool of subagents.ts
 * (https://code.claude.com/docs/en/sub-agents). It reads Claude Code's formats only and works with any provider.
 *
 * - Agent definitions from ~/.claude/agents (CLAUDE_CONFIG_DIR is honoured), above ~/.pi/agent/agents, and from
 *   <project>/.claude/agents at every level of the walk up, below that level's .pi/agents, once the project is
 *   trusted.
 * - Tool entries of every definition in Claude Code's names (Read, Bash, Glob, …) and permission rules (Bash(git *))
 *   name the matching Pi tools (CLAUDE_TO_PI below).
 * - model: sonnet, opus, haiku, and fable resolve to the newest model of that family on the current provider. They
 *   carry the tiers of subagents.ts: haiku is small, sonnet inherit, opus and fable large, so a provider without the
 *   family falls back to that tier, and a tier asked for on a Claude provider picks haiku, or opus before fable.
 * - CLAUDE_CODE_SUBAGENT_MODEL is the model when neither the call nor the definition names one;
 *   CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH (default 3) and CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS (default 20) set how deep
 *   subagents nest and how many run at once.
 *
 * All of it reaches subagents.ts through the event bus ("subagents:provider"); without it this file does nothing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";

function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/**
 * Claude Code <-> Pi tool names and inputs, shared by the extensions that speak Claude Code's formats (subagent
 * definitions, Remote Control).
 *
 * claude-remote-control.ts carries a copy of a part of this block: change them alike.
 */
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
	Task: ["agent"],
	Agent: ["agent"],
	AskUserQuestion: ["ask_user_question"],
	CronCreate: ["cron_create"],
	CronList: ["cron_list"],
	CronDelete: ["cron_delete"],
	ScheduleWakeup: [],
	ListAgents: ["list_agents"],
	SendMessage: ["send_message"],
	NotebookEdit: [],
	NotebookRead: [],
	TodoWrite: [],
	TodoRead: [],
	Skill: [],
	LSP: [],
	Monitor: [],
	TaskStop: [],
};

/**
 * The Pi tools a tool entry of a Claude Code definition names. Accepts Claude Code names, Pi names, and permission-rule
 * specifiers such as `Bash(git *)`, which name the whole tool. Unknown names come back unchanged, so MCP tools and Pi
 * extension tools pass through.
 */
function piToolNames(entry: string): string[] {
	const name = entry.trim().replace(/\(.*\)$/s, "").trim();
	if (!name) return [];
	return CLAUDE_TO_PI[name] ?? [name];
}

// A copy of SubagentsProvider from subagents.ts, the event-bus contract between the two: change both alike.
/** What another extension adds to the agent tool ("subagents:provider" on the event bus). */
interface SubagentsProvider {
	/** Providers apply in the order of their ids; one emitted again under the same id replaces the earlier one. */
	id: string;
	/** User agent directories, ranking above ~/.pi/agent/agents. */
	userAgentDirs?: () => string[];
	/** Project agent directories at one level of the walk up from the working directory, below its .pi/agents. */
	projectAgentDirs?: (dir: string) => string[];
	/** The Pi tools an entry of a definition's tools or disallowedTools names; undefined leaves the entry as it is. */
	toolNames?: (entry: string) => string[] | undefined;
	/** Model families that resolve to the newest model of the current provider whose id contains them. */
	modelFamilies?: string[];
	/**
	 * The tier of a family: a family the current provider lacks falls back to it, and a tier asked for picks the first
	 * family of that tier the provider has, in the order given here.
	 */
	familyTiers?: Record<string, "small" | "large" | "inherit">;
	/** The model when neither the call nor the definition names one. */
	defaultModel?: () => string | undefined;
	/** How deep subagents nest (default 3) and how many run at once (default 20). */
	maxDepth?: number;
	maxConcurrent?: number;
}

export default function (pi: ExtensionAPI) {
	const provider: SubagentsProvider = {
		id: "claude-code-agents",
		userAgentDirs: () => [path.join(claudeDir(), "agents")],
		projectAgentDirs: (dir) => [path.join(dir, ".claude", "agents")],
		toolNames: piToolNames,
		modelFamilies: ["sonnet", "opus", "haiku", "fable"],
		familyTiers: { haiku: "small", sonnet: "inherit", opus: "large", fable: "large" },
		defaultModel: () => process.env.CLAUDE_CODE_SUBAGENT_MODEL,
		maxDepth: Number(process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH) || undefined,
		maxConcurrent: Number(process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS) || undefined,
	};
	pi.events.on("subagents:provider-request", () => pi.events.emit("subagents:provider", provider));
	pi.events.emit("subagents:provider", provider);
}
