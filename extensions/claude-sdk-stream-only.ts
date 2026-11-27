/**
 * Claude Code on streamed responses only, with tool inputs streamed as the model writes them.
 *
 * When a streamed response stalls, Claude Code repeats the request without streaming and gets the answer as one
 * assistant message per content block, under a new message id and without stream events. pi-claude-agent-sdk (the
 * claude-bridge provider) passes such an answer on, but it ends Pi's response at the first tool call in it, so of
 * parallel tool calls only the first reaches Pi: the others stay parked in the provider's MCP bridge, Claude Code waits
 * for their results, and Pi waits for the response, until the run is aborted.
 * CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK turns the fallback off; a stalled stream then ends as a retried stream or
 * as an error, and the provider passes both on to Pi.
 *
 * The API streams a tool call's input piece by piece only with fine-grained tool streaming (eager_input_streaming on
 * the tool); without it, it holds a long value such as an edit's text back until the value is complete. Claude Code
 * asks for it where a feature flag of its own allows it, and always with CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING.
 * Pi then gets the arguments of a call as they are written, which diff.ts shows live.
 *
 * The provider builds the environment of every Claude Code process it starts from Pi's, at the start of each query,
 * after all extensions are loaded. Setting the variables here therefore applies them to Pi alone, not to the shell. A
 * value set before Pi starts is kept, so CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=0 turns the streamed inputs
 * off.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
	process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK ??= "1";
	process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING ??= "1";
}
