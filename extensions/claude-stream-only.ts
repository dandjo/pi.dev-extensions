/**
 * Claude Code on streamed responses only.
 *
 * When a streamed response stalls, Claude Code repeats the request without streaming and gets the answer as one
 * finished message. pi-claude-subscription builds Pi's response from the stream events alone, so that answer never
 * reaches Pi: a tool call in it stays parked in the provider's MCP bridge, Claude Code waits for its result (up to
 * MCP_TOOL_TIMEOUT, which the provider sets to seven days), and Pi waits for the response, until the run is aborted.
 * CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK turns the fallback off; a stalled stream then ends as a retried stream or
 * as an error, and the provider passes both on to Pi.
 *
 * The provider hands Pi's environment to every Claude Code process it starts, and starts the first one on the first
 * request, after all extensions are loaded. Setting the variable here therefore applies it to Pi alone, not to the
 * shell. A value set before Pi starts is kept.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
	process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK ??= "1";
}
