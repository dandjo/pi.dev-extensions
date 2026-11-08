/**
 * Claude Code memory bridge.
 *
 * Loads Claude Code's auto memory for the current project (~/.claude/projects/<key>/memory/MEMORY.md) into
 * the system prompt, read live on every run so it stays in sync with Claude Code. The topic files the index
 * links to are read on demand. The project key is the absolute path with every non-alphanumeric character
 * replaced by "-"; the working directory and its parents are tried, nearest first. Subagents (PI_SUBAGENT_DEPTH) get
 * no memory, as in Claude Code.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_INDEX_LINES = 200;

function memoryDirFor(cwd: string): string | null {
	const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		const candidate = path.join(projects, dir.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
		if (existsSync(path.join(candidate, "MEMORY.md"))) return candidate;
		if (dir === path.dirname(dir)) return null;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const dir = memoryDirFor(ctx.cwd);
		if (dir && ctx.hasUI) ctx.ui.notify(`Claude Code memory: ${dir.replace(os.homedir(), "~")}`, "info");
	});

	pi.on("before_agent_start", (event) => {
		const sections = event.systemPromptOptions.sections;
		const dir = process.env.PI_SUBAGENT_DEPTH ? null : memoryDirFor(event.systemPromptOptions.cwd);
		if (!dir) {
			delete sections.claude_memory;
			return;
		}

		let index = readFileSync(path.join(dir, "MEMORY.md"), "utf8").trim();
		const lines = index.split("\n");
		if (lines.length > MAX_INDEX_LINES) index = `${lines.slice(0, MAX_INDEX_LINES).join("\n")}\n…`;

		sections.claude_memory = [
			`Persistent memory for this project, carried over from Claude Code. Directory: ${dir}`,
			"The index below links topic files (relative to that directory). Read a topic file when it is relevant to the task before acting; treat entries as dated observations and verify them against the current state when it matters.",
			"",
			index,
		].join("\n");
	});
}
