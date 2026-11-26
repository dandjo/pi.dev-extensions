/**
 * Claude SDK rules: Pi's <rules> for the claude-bridge provider (pi-claude-agent-sdk).
 *
 * pi-claude-agent-sdk runs Claude Code with its own system prompt and appends only the portable parts of Pi's:
 * context files, skills, a custom prompt, appended text, and the sections extensions add
 * (systemPromptOptions.sections). Pi's <rules> section is not among them, and with it every guideline the tools
 * bring (promptGuidelines of a tool, an extension's run-time guidelines): Claude sees each tool's description, but
 * not when to use it, or not.
 *
 * - While a claude-bridge model runs, this extension builds the rules as Pi does (buildRules in Pi's
 *   system-prompt.js: the bash hint for file operations, the guidelines of the visible tools, the other guidelines,
 *   and Pi's two closing ones, each once) and adds them as the section "rules". Pi lets a section of that name take
 *   the place of its own rules, with the same text, so Pi's prompt stays as it was; the provider passes the section
 *   on. Handlers run in load order: a guideline an extension loaded after this one adds in its own before_agent_start
 *   is missing (bash-timeout.ts, which adds one there, loads before it).
 * - A custom prompt (a SYSTEM.md of the user's) has no rules in Pi either; nothing is added then.
 * - Any other provider: nothing.
 * - The rules change only with the tools and guidelines, so the prompt stays the same from turn to turn and the
 *   provider keeps its Claude Code session (a changed prompt costs it a session import without cache).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "claude-bridge";

/** The rules as Pi renders them, a copy of buildRules in Pi's system-prompt.js: change it alike. */
function buildRules(selectedTools: string[], toolGuidelines: Record<string, string[]>, promptGuidelines: string[]): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string) => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};
	const hasBash = selectedTools.includes("bash");
	const hasPowerShell = selectedTools.includes("powershell");
	if ((hasBash || hasPowerShell) && !selectedTools.includes("grep") && !selectedTools.includes("find") && !selectedTools.includes("ls")) {
		if (hasBash && hasPowerShell) addRule("Use bash or PowerShell for file operations like listing, searching, and finding files");
		else if (hasPowerShell) addRule("Use PowerShell for file operations like listing, searching, and finding files");
		else addRule("Use bash for file operations like ls, rg, find");
	}
	for (const name of selectedTools) for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	for (const rule of promptGuidelines) addRule(rule);
	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
		const sections = options.sections as Record<string, string | undefined>;
		if (ctx.model?.provider !== PROVIDER || options.customPrompt) {
			delete sections.rules;
			return;
		}
		const visible = options.selectedTools.filter((name) => !options.hiddenTools.includes(name));
		sections.rules = buildRules(visible, options.toolGuidelines, options.promptGuidelines);
	});
}
