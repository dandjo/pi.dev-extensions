/**
 * Claude Code on streamed responses only.
 *
 * When a streamed response stalls, Claude Code repeats the request without streaming and gets the answer as one
 * assistant message per content block, under a new message id and without stream events. pi-claude-agent-sdk (the
 * claude-bridge provider) passes such an answer on, but it ends Pi's response at the first tool call in it, so of
 * parallel tool calls only the first reaches Pi: the others stay parked in the provider's MCP bridge, Claude Code waits
 * for their results, and Pi waits for the response, until the run is aborted.
 * CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK turns the fallback off; a stalled stream then ends as a retried stream or
 * as an error, and the provider passes both on to Pi.
 *
 * The provider builds the environment of every Claude Code process it starts from Pi's, at the start of each query,
 * after all extensions are loaded. Setting the variable here therefore applies it to Pi alone, not to the shell. A
 * value set before Pi starts is kept.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
	process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK ??= "1";
}
