/**
 * Claude agents: Claude Code's agent definitions and settings for the Agent tool of subagents.ts
 * (https://code.claude.com/docs/en/sub-agents).
 *
 * - Agent definitions from ~/.claude/agents (CLAUDE_CONFIG_DIR is honoured), above ~/.pi/agent/agents; from
 *   <project>/.claude/agents at every level of the walk up, below that level's .pi/agents, once the project is
 *   trusted; and from agents/ of every Claude Code plugin in ~/.pi/agent/claude-plugins (one directory per
 *   plugin), named <plugin>:<name>.
 * - Tool entries of every definition in Claude Code's names (Read, Bash, Glob, …) and permission rules (Bash(git *))
 *   name the matching Pi tools (lib/claude-tools.ts).
 * - model: sonnet, opus, haiku, and fable resolve to the newest model of that family on the current provider.
 * - CLAUDE_CODE_SUBAGENT_MODEL is the model when neither the call nor the definition names one;
 *   CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH (default 3) and CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS (default 20) set how deep
 *   subagents nest and how many run at once.
 *
 * All of it reaches subagents.ts through the event bus ("subagents:provider"); without it this file does nothing.
 */

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { piToolNames } from "./lib/claude-tools.ts";
import type { SubagentsProvider } from "./subagents.ts";

function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

function pluginAgentDirs(): { plugin: string; dir: string }[] {
	const pluginsDir = path.join(getAgentDir(), "claude-plugins");
	let plugins: string[] = [];
	try {
		plugins = readdirSync(pluginsDir).sort();
	} catch {
		// no plugins
	}
	return plugins.map((plugin) => ({ plugin, dir: path.join(pluginsDir, plugin, "agents") }));
}

export default function (pi: ExtensionAPI) {
	const provider: SubagentsProvider = {
		id: "claude-agents",
		pluginAgentDirs,
		userAgentDirs: () => [path.join(claudeDir(), "agents")],
		projectAgentDirs: (dir) => [path.join(dir, ".claude", "agents")],
		toolNames: piToolNames,
		modelFamilies: ["sonnet", "opus", "haiku", "fable"],
		defaultModel: () => process.env.CLAUDE_CODE_SUBAGENT_MODEL,
		maxDepth: Number(process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH) || undefined,
		maxConcurrent: Number(process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS) || undefined,
	};
	pi.events.on("subagents:provider-request", () => pi.events.emit("subagents:provider", provider));
	pi.events.emit("subagents:provider", provider);
}
