/**
 * Claude login: has Claude Code renew its claude.ai login once it has run out, for the extensions that need a valid
 * token while no prompt runs. claude-usage.ts asks for it to fetch the plan limits, claude-remote-control.ts to renew
 * its connection. On its own this file does nothing: no request and no process until an extension asks.
 *
 * Claude Code renews its OAuth token only when it makes a request, and the claude-sdk provider ends its processes when
 * they idle, so after about eight hours without a prompt the token has run out. Pi never refreshes the token itself:
 * that would rotate Claude Code's refresh token behind its back. A short Claude Code process (Agent SDK, no prompt, no
 * settings, nothing persisted) is asked for its usage instead (get_usage): a request without a model call, which
 * Claude Code sends only after renewing the token under its own lock.
 *
 * One renewal runs at a time in a Pi process, whichever extension asks, and the next one waits RETRY_MS after it
 * started. After one that leaves no valid token the wait doubles, up to MAX_RETRY_MS, so a login that needs /login
 * does not start a Claude Code process every few minutes while Pi stays open.
 *
 * Other extensions reach it through the event bus, whatever the load order: "claude-login:source" carries a
 * ClaudeLoginSource, at load and on every "claude-login:source-request". An extension that finds none goes without
 * the renewal.
 */

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;
const TIMEOUT_MS = 30_000;
/** A token that runs out within this margin counts as run out. */
const MARGIN_MS = 60_000;

/** What "claude-login:source" carries. */
export interface ClaudeLoginSource {
	/**
	 * Has Claude Code renew its run-out claude.ai login; true when its token is valid afterwards. Joins a renewal that is
	 * running, and answers false at once while the wait after the last one lasts. Never rejects. To be called once the
	 * caller found no valid token, not before.
	 */
	renew(): Promise<boolean>;
}

function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

const execFileAsync = promisify(execFile);

/**
 * Claude Code's stored login, the JSON with claudeAiOauth, or undefined. On macOS Claude Code keeps it in the login
 * keychain as the generic password "Claude Code-credentials" (with CLAUDE_CONFIG_DIR set, followed by "-" and the first
 * eight hex digits of that directory's SHA-256), and .credentials.json is only its fallback; elsewhere the file is the
 * store. macOS 26 prints a password with non-ASCII content as hex, which is decoded here.
 * claude-remote-control.ts, claude-usage.ts carry a copy of this function: change them alike.
 */
async function claudeCodeCredentials(): Promise<any> {
	if (process.platform === "darwin") {
		const dir = process.env.CLAUDE_CONFIG_DIR;
		const suffix = dir ? `-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}` : "";
		try {
			const { stdout } = await execFileAsync(
				"/usr/bin/security",
				["find-generic-password", "-s", `Claude Code-credentials${suffix}`, "-w"],
				{ timeout: 5_000 },
			);
			const raw = stdout.trim();
			const parsed = JSON.parse(/^(?:[0-9a-f]{2})+$/i.test(raw) ? Buffer.from(raw, "hex").toString("utf8") : raw);
			if (parsed?.claudeAiOauth) return parsed;
		} catch {
			// no keychain item: the file
		}
	}
	try {
		return JSON.parse(await readFile(path.join(claudeDir(), ".credentials.json"), "utf8"));
	} catch {
		return undefined;
	}
}

/** Where npm keeps global packages (Pi's legacy installs), asked once; undefined without npm. */
let npmGlobalRoot: string | null | undefined;
function globalNpmRoot(): string | undefined {
	if (npmGlobalRoot === undefined) {
		const windows = process.platform === "win32";
		try {
			npmGlobalRoot =
				execFileSync(windows ? "npm.cmd" : "npm", ["root", "-g"], {
					encoding: "utf8",
					timeout: 10_000,
					stdio: ["ignore", "pipe", "ignore"],
					shell: windows,
				}).trim() || null;
		} catch {
			npmGlobalRoot = null;
		}
	}
	return npmGlobalRoot ?? undefined;
}

/**
 * The Claude Agent SDK that pi-claude-subscription brings, wherever Pi installed that package: in the user scope
 * (~/.pi/agent/npm), the project scope (.pi/npm), or npm's global root (Pi's legacy installs); hoisted, or below the
 * package itself. Undefined when it is in none of them.
 * claude-remote-control.ts carries a copy of this function: change them alike.
 */
function claudeSdkDir(): string | undefined {
	const find = (roots: string[]) => {
		for (const root of roots) {
			const nested = path.join(root, "pi-claude-subscription", "node_modules");
			for (const base of [root, nested]) {
				const dir = path.join(base, "@anthropic-ai", "claude-agent-sdk");
				if (existsSync(path.join(dir, "sdk.mjs"))) return dir;
			}
		}
		return undefined;
	};
	const local = find([path.join(getAgentDir(), "npm", "node_modules"), path.join(process.cwd(), ".pi", "npm", "node_modules")]);
	if (local) return local;
	const global = globalNpmRoot();
	return global ? find([global]) : undefined;
}

/** The part of the Agent SDK's query that a renewal uses. */
interface ClaudeSdk {
	query(args: { prompt: AsyncIterable<never>; options: Record<string, unknown> }): {
		usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?: { skipBehaviors?: boolean }): Promise<unknown>;
		close(): void;
	};
}

/** Process-wide, so the runtimes /reload replaces share one renewal and one wait. */
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

/** Whether Claude Code's access token is valid for at least another minute. */
async function claudeCodeLoginValid(): Promise<boolean> {
	try {
		const o = (await claudeCodeCredentials())?.claudeAiOauth;
		return typeof o?.accessToken === "string" && o.accessToken !== "" && (!o.expiresAt || o.expiresAt > Date.now() + MARGIN_MS);
	} catch {
		return false;
	}
}

async function askClaudeCodeForUsage(): Promise<void> {
	const sdkDir = claudeSdkDir();
	if (!sdkDir) throw new Error("The Claude Agent SDK is not installed: `pi install npm:pi-claude-subscription` brings it (see the README).");
	const sdk = (await import(pathToFileURL(path.join(sdkDir, "sdk.mjs")).href)) as ClaudeSdk;
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
function renewClaudeLogin(): Promise<boolean> {
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

export default function (pi: ExtensionAPI) {
	const source: ClaudeLoginSource = { renew: () => renewClaudeLogin() };
	pi.events.on("claude-login:source-request", () => pi.events.emit("claude-login:source", source));
	pi.events.emit("claude-login:source", source);
}
