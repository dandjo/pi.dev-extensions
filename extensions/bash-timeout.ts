/**
 * Bash timeout: a default timeout for the bash tool, as Claude Code has. Pi's bash runs a command without a time limit
 * unless the model gives one, so a command that never ends — a script that leaves a browser or a server open — holds
 * the session until the user presses Esc, 42 minutes in one case.
 *
 * - A bash tool call without timeout gets the default, 120 seconds as in Claude Code. A call that gives its own keeps
 *   it. Pi stops the command with everything it started when the time is up. Whether the call came with one is read
 *   from its arguments as the model sent them (tool_execution_start): a default another extension set before this
 *   handler runs (pi-claude-agent-sdk sets 120 seconds for its claude-bridge models) gives way to this one, so the
 *   setting and the hint below apply there as well.
 * - The model learns of the default from a guideline of the bash tool, so it sets timeout itself for a build, a test
 *   run, or an install that takes longer: Pi renders it into its prompt's <rules>. A custom prompt (a SYSTEM.md of the
 *   user's) gets it in its "Guidelines:" list when it has one, and goes without otherwise. pi-claude-agent-sdk (the
 *   claude-bridge provider) passes Claude Code only the portable parts of Pi's prompt (context files, skills, a custom
 *   prompt, appended text, sections), not its rules, so the guideline does not reach its models either. Either way,
 *   the hint after a timeout tells the model.
 * - A command the default stopped comes back with a hint: run it again with the timeout it needs, use the wait tool
 *   for something that has not happened yet, or find the process that did not end.
 * - {"seconds": n} in ~/.pi/agent/bash-timeout.json changes the default; 0 turns it off. The user's own ! commands
 *   are not tool calls and keep running without a limit.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = path.join(getAgentDir(), "bash-timeout.json");
const DEFAULT_SECONDS = 120;

function loadSeconds(): number {
	try {
		const seconds = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))?.seconds;
		return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_SECONDS;
	} catch {
		return DEFAULT_SECONDS;
	}
}

export default function (pi: ExtensionAPI) {
	/** The bash calls that run with the default, by tool call id. */
	const defaulted = new Map<string, number>();
	/** The bash calls the model sent without timeout, by tool call id, until their tool_call. */
	const untimed = new Set<string>();

	pi.on("before_agent_start", (event) => {
		const seconds = loadSeconds();
		const options = event.systemPromptOptions;
		if (seconds <= 0 || !options.selectedTools?.includes("bash")) return undefined;
		const guideline =
			`bash: a call without timeout stops after ${seconds} seconds. Give timeout (seconds) for a command that takes longer, ` +
			"such as a build, a test run, or an install; wait for something that has not happened yet with the wait tool instead. " +
			"A script that starts a browser or a server must close it, or the call never ends.";
		const guidelines = (options.toolGuidelines ??= {});
		const list = (guidelines.bash ??= []);
		if (!list.includes(guideline)) list.push(guideline);
		// A prompt rendered already ignores toolGuidelines from here on.
		const marker = "\nGuidelines:\n";
		const prompt = options.customPrompt;
		if (prompt?.includes(marker) && !prompt.includes(guideline)) {
			const at = prompt.indexOf(marker) + marker.length;
			options.customPrompt = `${prompt.slice(0, at)}- ${guideline}\n${prompt.slice(at)}`;
		}
		return undefined;
	});

	// The arguments as the model sent them: tool_call hands out a copy that other extensions may have changed already.
	pi.on("tool_execution_start", (event) => {
		if (event.toolName === "bash" && (event.args as { timeout?: unknown } | undefined)?.timeout === undefined) untimed.add(event.toolCallId);
	});
	pi.on("tool_execution_end", (event) => {
		untimed.delete(event.toolCallId);
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return undefined;
		const input = event.input as { timeout?: unknown };
		if (!untimed.delete(event.toolCallId) && input.timeout !== undefined) return undefined;
		const seconds = loadSeconds();
		if (seconds <= 0) return undefined;
		input.timeout = seconds;
		defaulted.set(event.toolCallId, seconds);
		return undefined;
	});

	pi.on("tool_result", (event) => {
		const seconds = defaulted.get(event.toolCallId);
		if (seconds === undefined) return undefined;
		defaulted.delete(event.toolCallId);
		const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		if (!event.isError || !text.includes(`Command timed out after ${seconds} seconds`)) return undefined;
		const hint =
			`\n\nThis call gave no timeout and ran into the default of ${seconds} seconds; the command and what it started were stopped. ` +
			"If it needs longer (a build, a test run, an install), run it again with timeout set to what it needs. " +
			"If it waits for something that has not happened yet, use the wait tool. " +
			"If it should have ended by now, a process it started may still be open (a browser, a server in the foreground): close it in the script instead of raising the timeout.";
		return { content: [...event.content, { type: "text", text: hint }] };
	});
}
