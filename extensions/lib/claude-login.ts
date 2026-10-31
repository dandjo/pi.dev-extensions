/**
 * Claude Code's claude.ai login, renewed once it has run out. Claude Code renews its OAuth token only when it makes a
 * request, and the claude-sdk provider ends its processes when they idle, so after about eight hours without a prompt
 * the token has run out: Remote Control cannot renew its connection, and the status line gets no plan limits.
 *
 * Pi never refreshes the token itself: that would rotate Claude Code's refresh token behind its back. A short Claude
 * Code process (Agent SDK, no prompt, no settings, nothing persisted) is asked for its usage instead (get_usage): a
 * request without a model call, which Claude Code sends only after renewing the token under its own lock.
 *
 * One renewal runs at a time in a Pi process, whichever extension asks, and the next one waits RETRY_MS after it
 * started. After one that leaves no valid token the wait doubles, up to MAX_RETRY_MS, so a login that needs /login
 * does not start a Claude Code process every few minutes while Pi stays open.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const SDK_DIR = path.join(getAgentDir(), "npm", "node_modules", "@anthropic-ai", "claude-agent-sdk");
const RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;
const TIMEOUT_MS = 30_000;
/** A token that runs out within this margin counts as run out. */
const MARGIN_MS = 60_000;

/** The part of the Agent SDK's query that a renewal uses. */
interface ClaudeSdk {
	query(args: { prompt: AsyncIterable<never>; options: Record<string, unknown> }): {
		usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?: { skipBehaviors?: boolean }): Promise<unknown>;
		close(): void;
	};
}

/** Process-wide, so the extensions and the runtimes /reload replaces share one renewal and one wait. */
interface Gate {
	running: Promise<boolean> | null;
	nextAt: number;
	retryMs: number;
}

const gate = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi.claude-login.renewal.v1")] ??= {
	running: null,
	nextAt: 0,
	retryMs: RETRY_MS,
}) as Gate;

export function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/** Whether Claude Code's access token is valid for at least another minute. */
export async function claudeCodeLoginValid(): Promise<boolean> {
	try {
		const o = JSON.parse(await readFile(path.join(claudeDir(), ".credentials.json"), "utf8"))?.claudeAiOauth;
		return typeof o?.accessToken === "string" && o.accessToken !== "" && (!o.expiresAt || o.expiresAt > Date.now() + MARGIN_MS);
	} catch {
		return false;
	}
}

async function askClaudeCodeForUsage(): Promise<void> {
	const sdk = (await import(pathToFileURL(path.join(SDK_DIR, "sdk.mjs")).href)) as ClaudeSdk;
	const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => {}) }) };
	const env: Record<string, string | undefined> = {
		...process.env,
		// The subscription login, as the claude-sdk provider runs Claude Code; and usage counts as nonessential traffic.
		ANTHROPIC_API_KEY: undefined,
		ANTHROPIC_AUTH_TOKEN: undefined,
		CLAUDE_CODE_USE_BEDROCK: undefined,
		CLAUDE_CODE_USE_VERTEX: undefined,
		CLAUDE_CODE_USE_FOUNDRY: undefined,
		CLAUDECODE: undefined,
		CLAUDE_CODE_ENTRYPOINT: undefined,
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: undefined,
	};
	const q = sdk.query({
		prompt: idle,
		options: { cwd: os.tmpdir(), tools: [], mcpServers: {}, settingSources: [], strictMcpConfig: true, persistSession: false, env, stderr: () => {} },
	});
	try {
		await Promise.race([
			q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref?.()),
		]);
	} finally {
		try {
			q.close();
		} catch {
			// already gone
		}
	}
}

/**
 * Has Claude Code renew its run-out claude.ai login; true when its token is valid afterwards. Joins a renewal that is
 * running, and answers false at once while the wait after the last one lasts.
 */
export function renewClaudeLogin(): Promise<boolean> {
	if (gate.running) return gate.running;
	if (Date.now() < gate.nextAt) return Promise.resolve(false);
	gate.nextAt = Date.now() + gate.retryMs;
	const running = askClaudeCodeForUsage()
		.catch(() => {
			// whether the token is valid now decides
		})
		.then(() => claudeCodeLoginValid())
		.then((valid) => {
			gate.retryMs = valid ? RETRY_MS : Math.min(gate.retryMs * 2, MAX_RETRY_MS);
			return valid;
		})
		.finally(() => {
			if (gate.running === running) gate.running = null;
		});
	gate.running = running;
	return running;
}
