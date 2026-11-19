/**
 * Claude Code agents: Claude Code's agent definitions and settings for the agent tool of subagents.ts
 * (https://code.claude.com/docs/en/sub-agents). It reads Claude Code's formats only and works with any provider.
 *
 * - Agent definitions from ~/.claude/agents (CLAUDE_CONFIG_DIR is honoured), above ~/.pi/agent/agents; from
 *   <project>/.claude/agents at every level of the walk up, below that level's .pi/agents, once the project is
 *   trusted; and from agents/ of every Claude Code plugin in ~/.pi/agent/claude-code-plugins (one directory per
 *   plugin) and of every plugin Claude Code installed for the user and enabled in its user settings, named
 *   <plugin>:<name>, unless the switch files of claude-code-plugins.ts turn the plugin off.
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

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/**
 * Whether a plugin is on: the switch files of claude-code-plugins.ts can turn it off, claude-code-plugins.json in Pi's
 * agent directory and, once the project is trusted, <cwd>/.pi/claude-code-plugins.json over it ("plugins":
 * {"<name>": false}; a project's true turns on what the user's file turns off). A file that cannot be read counts as
 * none. claude-code-hooks.ts carries a copy of this function, claude-code-plugins.ts the same rule: change them alike.
 */
function pluginOn(name: string, cwd: string, trusted: boolean): boolean {
	const files = [path.join(getAgentDir(), "claude-code-plugins.json")];
	if (trusted) files.push(path.join(cwd, ".pi", "claude-code-plugins.json"));
	let on = true;
	for (const file of files) {
		try {
			const value = JSON.parse(readFileSync(file, "utf8"))?.plugins?.[name];
			if (typeof value === "boolean") on = value;
		} catch {
			// no such file, or not JSON
		}
	}
	return on;
}

/**
 * The Claude Code plugins Pi uses, by name: every directory in ~/.pi/agent/claude-code-plugins (or a link to one),
 * then the plugins Claude Code installed for the user (plugins/installed_plugins.json) and enabled in
 * its user settings (enabledPlugins), at their installPath. Of two plugins of one name, the one found first wins; a
 * plugin the switch files turn off (pluginOn) is left out, in either place.
 * claude-code-hooks.ts carries a copy of this function: change them alike.
 */
function claudePlugins(cwd: string, trusted: boolean): { name: string; root: string }[] {
	const plugins = new Map<string, string>();
	const linked = path.join(getAgentDir(), "claude-code-plugins");
	try {
		for (const name of readdirSync(linked).sort()) {
			if (!pluginOn(name, cwd, trusted)) continue;
			try {
				if (statSync(path.join(linked, name)).isDirectory()) plugins.set(name, path.join(linked, name));
			} catch {
				// a broken link
			}
		}
	} catch {
		// no such folder
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
		if (!pluginOn(name, cwd, trusted)) continue;
		const entry = installed[id].find((e: any) => e?.scope === "user" && typeof e.installPath === "string");
		if (entry && existsSync(entry.installPath)) plugins.set(name, entry.installPath);
	}
	return [...plugins].map(([name, root]) => ({ name, root }));
}

function pluginAgentDirs(cwd: string, trusted: boolean): { plugin: string; dir: string }[] {
	return claudePlugins(cwd, trusted).map(({ name, root }) => ({ plugin: name, dir: path.join(root, "agents") }));
}

/**
 * Claude Code <-> Pi tool names and inputs, shared by the extensions that speak Claude Code's formats (hooks, subagent
 * definitions).
 *
 * claude-code-hooks.ts, claude-remote-control.ts carry a copy of this block, or of a part of it: change them alike.
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
	ScheduleWakeup: ["schedule_wakeup"],
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
	/** Directories of plugin agents, which are named <plugin>:<name> and rank below every user and project agent. */
	pluginAgentDirs?: () => { plugin: string; dir: string }[];
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
	// The session's directory and whether its project is trusted, for the project's plugin switches.
	let cwd = process.cwd();
	let trusted = false;
	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
		trusted = ctx.isProjectTrusted();
	});
	const provider: SubagentsProvider = {
		id: "claude-code-agents",
		pluginAgentDirs: () => pluginAgentDirs(cwd, trusted),
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
