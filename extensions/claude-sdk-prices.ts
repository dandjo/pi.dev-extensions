/**
 * Claude SDK prices: list prices for the models of the claude-bridge provider (pi-claude-agent-sdk).
 *
 * pi-claude-agent-sdk registers its models with every price at 0 (buildModels in its models.ts), because a Claude
 * subscription is not billed per token. Pi computes the cost of a reply from the model's prices, so every reply,
 * the status line, the subagents panel, and the model ladder of subagents.ts (which needs a price for every rung)
 * showed nothing.
 *
 * - At session_start and before each prompt, every claude-bridge model without a price gets the prices of the model
 *   with the same id at the provider anthropic (Pi's catalog, input, output, cache read, cache write, and tiers),
 *   registered again under claude-bridge with only the models changed. Pi refreshes the session's current model
 *   from the registry on that, so the next reply is priced.
 * - The prices are Anthropic's API list prices: what the tokens would cost on the API, not what the subscription
 *   costs. Replies before this extension ran keep their cost of 0.
 * - A model without a twin at anthropic keeps 0. Once all are priced, nothing is registered again.
 * - Any other provider: nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "claude-bridge";
const PRICE_SOURCE = "anthropic";

type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number };

function priced(cost: Cost | undefined): boolean {
	return !!cost && cost.input + cost.output + cost.cacheRead + cost.cacheWrite > 0;
}

/** Registers the claude-bridge models again with the anthropic prices where they have none. */
function addPrices(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const config = ctx.modelRegistry.getRegisteredProviderConfig(PROVIDER);
	if (!config?.models?.length) return;
	let changed = false;
	const models = config.models.map((model) => {
		if (priced(model.cost as Cost | undefined)) return model;
		const twin = ctx.modelRegistry.find(PRICE_SOURCE, model.id);
		if (!twin || !priced(twin.cost)) return model;
		changed = true;
		return { ...model, cost: { ...twin.cost } };
	});
	// Pi validates a registration on its own, before it merges it into the earlier one: the whole configuration
	// again (the same stream function among it), with only the models changed.
	if (changed) pi.registerProvider(PROVIDER, { ...config, models });
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => addPrices(pi, ctx));
	// A provider registered after session_start (pi-claude-agent-sdk does so in a session with a registry of its own)
	// is priced before its first request.
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.model?.provider === PROVIDER && !priced(ctx.model.cost)) addPrices(pi, ctx);
	});
}
