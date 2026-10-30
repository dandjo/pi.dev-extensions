/**
 * The current conversation as plain text, for side requests that must not touch the conversation itself (/btw, the
 * /goal evaluator). A request without tools cannot carry tool-call blocks, so the transcript goes in as text.
 *
 * Pi does not load this file as an extension: it sits in a subdirectory without index.ts. Extensions import it.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface TranscriptOptions {
	/** Characters kept of each tool result. */
	toolResultChars: number;
	/** Characters kept of the whole transcript; the oldest part goes first. */
	maxChars: number;
	/** Messages to use instead of the session's current context. */
	messages?: AgentMessage[];
}

function text(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map((part) => (part.type === "text" ? part.text : part.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

function cut(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n[… ${value.length - max} more characters]`;
}

/** The conversation the model currently sees (compaction summary included), as `[Role]: …` blocks. */
export function conversationText(ctx: ExtensionContext, options: TranscriptOptions): string {
	const messages =
		options.messages ?? buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
	const parts: string[] = [];
	for (const message of convertToLlm(messages)) {
		if (message.role === "user") {
			const body = text(message.content).trim();
			if (body) parts.push(`[User]: ${body}`);
		} else if (message.role === "assistant") {
			const said = message.content
				.filter((part) => part.type === "text")
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("\n")
				.trim();
			if (said) parts.push(`[Assistant]: ${said}`);
			const calls = message.content
				.filter((part) => part.type === "toolCall")
				.map((part) => (part.type === "toolCall" ? `${part.name}(${cut(JSON.stringify(part.arguments), 2_000)})` : ""));
			if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		} else if (message.role === "toolResult") {
			const body = text(message.content).trim();
			if (body) parts.push(`[Tool result${message.isError ? " (error)" : ""}]: ${cut(body, options.toolResultChars)}`);
		}
	}
	let joined = parts.join("\n\n");
	if (joined.length > options.maxChars) {
		joined = `[… earlier conversation left out …]\n\n${joined.slice(joined.length - options.maxChars)}`;
	}
	return joined;
}
