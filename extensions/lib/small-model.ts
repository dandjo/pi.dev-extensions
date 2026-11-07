/**
 * Small-model calls for side tasks (session titles, page answers), whatever provider and model are in use.
 *
 * Pi does not load this file as an extension: it sits in a subdirectory without index.ts. Extensions import it.
 *
 * The model: among the models of the current model's provider that have working credentials and read text, the
 * one with the lowest list price (input + output per million tokens), if it is cheaper than the current model;
 * otherwise the current model. So a side task never moves to another provider or account. On providers that serve
 * several makers' models with the maker in the id ("anthropic/claude-…" on OpenRouter, "us.anthropic.claude-…" on
 * Bedrock), only models of the current maker qualify. A current model without a price (local, unknown) is kept.
 * PI_SMALL_MODEL=<provider>/<model-id> overrides the choice.
 */

import { type Api, type AssistantMessage, type Model, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Output tokens on top of the answer for a model that cannot turn thinking off (Claude Haiku 5.5, for one): its
 * thinking counts against the output limit, and even at the lowest level it sometimes thinks for a few hundred tokens.
 */
const THINKING_ROOM = 4_096;

/**
 * Side requests run one at a time, across every extension that loads this file. A provider that runs one process per
 * request may otherwise close the conversation's own process while it waits for tool results: pi-claude-subscription
 * keeps at most three Claude Code processes and closes the least recently used one outside a call.
 */
const gate: { tail: Promise<unknown> } = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi.small-model.gate")] ??= {
	tail: Promise.resolve(),
}) as { tail: Promise<unknown> };

/** Runs `run` after every side request queued before it has finished. */
export function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
	const result = gate.tail.then(run, run);
	gate.tail = result.catch(() => {});
	return result;
}

function price(model: Model<Api>): number {
	return model.cost.input + model.cost.output;
}

/** The model maker named at the start of an id, or "" when the id names none. */
function maker(id: string): string {
	const match = id.match(/^([a-z0-9-]+)\//i) ?? id.match(/^(?:[a-z]{2,6}\.)?([a-z][a-z0-9-]*)\.[a-z]/i);
	return match ? match[1].toLowerCase() : "";
}

export async function pickSmallModel(ctx: ExtensionContext): Promise<Model<Api> | undefined> {
	const override = process.env.PI_SMALL_MODEL?.trim();
	if (override) {
		const slash = override.indexOf("/");
		const model = slash > 0 ? ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1)) : undefined;
		if (model) return model;
	}

	const current = ctx.model;
	if (!current || !(price(current) > 0)) return current;
	const currentMaker = maker(current.id);
	let best = current;
	for (const model of await ctx.modelRegistry.getAvailableOfType("chat", current.provider)) {
		if (!model.input.includes("text") || maker(model.id) !== currentMaker) continue;
		if (price(model) > 0 && price(model) < price(best)) best = model;
	}
	return best;
}

/** The lowest thinking level the model accepts, so a side task does not think at length. Undefined is "off". */
function lowestThinking(model: Model<Api>): "minimal" | "low" | undefined {
	const map = model.thinkingLevelMap;
	if (!model.reasoning || map?.off !== null) return undefined;
	return map?.minimal !== null ? "minimal" : "low";
}

/**
 * One request without tools or history, queued behind other side requests and cancelled after two minutes. maxTokens
 * is the size of the answer; a model that must think gets THINKING_ROOM on top. The reply's stopReason is "error" or
 * "aborted" when it failed.
 */
export function askModel(
	ctx: ExtensionContext,
	model: Model<Api>,
	systemPrompt: string,
	text: string,
	options: { maxTokens: number; signal?: AbortSignal },
): Promise<AssistantMessage> {
	const reasoning = lowestThinking(model);
	const maxTokens = options.maxTokens + (reasoning ? THINKING_ROOM : 0);
	return oneAtATime(() => {
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		return ctx.modelRegistry
			.streamSimple(
				model,
				{ systemPrompt, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] },
				{
					maxTokens: Math.min(maxTokens, model.maxTokens),
					reasoning,
					signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			)
			.result();
	});
}

export function replyText(reply: AssistantMessage): string {
	return reply.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

export function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}
