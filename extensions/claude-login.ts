/**
 * Claude login: hands out the claude.ai token, and renews a login once it has run out, for the extensions that need a
 * valid token while no prompt runs. claude-usage.ts asks for it to fetch the plan limits, claude-remote-control.ts for
 * its connection. On its own this file does nothing: no request and no process until an extension asks.
 *
 * Two logins can carry such a token, and each is renewed by its owner:
 *
 * - Pi's own Anthropic login (/login, ~/.pi/agent/auth.json). Pi renews it only when a request goes through its
 *   anthropic provider, which never happens while the sessions run on the claude-sdk provider: the login then runs out
 *   after about eight hours although its refresh token still holds. Here Pi is asked for the provider's authentication
 *   (ctx.modelRegistry.getProviderAuth), which renews a token about to run out under the lock of Pi's credential
 *   store, so several Pi sessions renew once and none loses the rotated refresh token.
 * - Claude Code's login (~/.claude/.credentials.json). Claude Code renews its OAuth token only when it makes a
 *   request, and the claude-sdk provider ends its processes when they idle, so after about eight hours without a
 *   prompt the token has run out. Pi never refreshes that token itself: that would rotate Claude Code's refresh token
 *   behind its back. A short Claude Code process (Agent SDK, no prompt, no settings, nothing persisted) is asked for
 *   its usage instead (get_usage): a request without a model call, which Claude Code sends only after renewing the
 *   token under its own lock.
 *
 * Pi's login comes first, as its renewal is one request and no process; Claude Code's is used when Pi has no login of
 * its own, its renewal left none valid, or it belongs to another account. Neither renewal helps a login whose refresh
 * token is gone or refused: that needs /login again.
 *
 * The account: while CLAUDE_CODE_OAUTH_TOKEN is set (a token of `claude setup-token`), Claude Code runs the claude-sdk
 * provider's prompts on it, as it outranks the stored login. A login of another account would then show the limits
 * of an account the prompts do not run on, and connect Remote Control to it, so token() passes over a login whose
 * organization differs from that token's. The organization comes from the anthropic-organization-id header that
 * GET /v1/models answers with: a request every token may make (the setup token cannot ask for its profile), without
 * a model call. It is asked once per token and kept by the token's hash. An organization that cannot be told now (no
 * network, a refused token) counts as matching, and is asked again at a later call. An organization is one account
 * on a Pro or Max plan; on Team and Enterprise its members share it, so the check cannot tell them apart.
 *
 * One renewal of each kind runs at a time in a Pi process, whichever extension asks, and the next one waits RETRY_MS
 * after it started. After one that leaves no valid token the wait doubles, up to MAX_RETRY_MS, so a login that needs
 * /login does not start a Claude Code process, or ask the token endpoint, every few minutes while Pi stays open.
 *
 * Other extensions reach it through the event bus, whatever the load order: "claude-login:source" carries a
 * ClaudeLoginSource, at load and on every "claude-login:source-request". An extension that finds none reads the
 * logins itself, without the renewal and the account check.
 */

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
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
const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
const ORGANIZATION_HEADER = "anthropic-organization-id";
const ORGANIZATION_TIMEOUT_MS = 5_000;
/** A token whose organization could not be told is asked again after this wait. */
const ORGANIZATION_RETRY_MS = 60_000;
/** Organizations kept; a renewal brings a new token, so older ones are dropped. */
const ORGANIZATION_CACHE_SIZE = 16;

/** What "claude-login:source" carries. */
export interface ClaudeLoginSource {
	/**
	 * Renews a run-out claude.ai login: Pi's own through Pi's credential store, else Claude Code's through Claude Code.
	 * True when one of the two tokens is valid afterwards. Joins a renewal that is running, and answers false at once
	 * while the wait after the last one lasts. Never rejects. To be called once the caller found no valid token, not
	 * before. token() does this itself.
	 */
	renew(): Promise<boolean>;
	/**
	 * The claude.ai access token to use: Pi's own login first, then Claude Code's, valid for at least another minute.
	 * With renew (the default) a run-out login is renewed by its owner first, as renew() does. While
	 * CLAUDE_CODE_OAUTH_TOKEN is set, a login of another organization is passed over. Without a token, reason says
	 * whether there was none or only ones of another account. Never rejects.
	 */
	token(options?: { renew?: boolean }): Promise<ClaudeLoginToken | ClaudeLoginRefusal>;
}

/** What token() answers with a token: whose login it is, and whether it was renewed for this call. */
export interface ClaudeLoginToken {
	value: string;
	source: "pi" | "claude-code";
	renewed: boolean;
}

/** What token() answers without one: no valid login, or only logins of another account than CLAUDE_CODE_OAUTH_TOKEN. */
export interface ClaudeLoginRefusal {
	value?: undefined;
	reason: "none" | "other-account";
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

/** The same for the renewal of Pi's own login. */
const piGate = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi.claude-login.pi-renewal.v1")] ??= {
	running: null,
	nextAt: 0,
	retryMs: RETRY_MS,
}) as Gate;

/**
 * Pi's own Anthropic login as auth.json holds it: whether it is an OAuth login that can be renewed, whether it is
 * valid, and its access token while it is.
 */
async function piLogin(): Promise<{ renewable: boolean; valid: boolean; access?: string }> {
	try {
		const a = JSON.parse(await readFile(path.join(getAgentDir(), "auth.json"), "utf8"))?.anthropic;
		if (a?.type !== "oauth") return { renewable: false, valid: false };
		const valid = typeof a.access === "string" && a.access !== "" && typeof a.expires === "number" && a.expires > Date.now() + MARGIN_MS;
		return { renewable: typeof a.refresh === "string" && a.refresh !== "", valid, ...(valid ? { access: a.access } : {}) };
	} catch {
		return { renewable: false, valid: false };
	}
}

/**
 * Has Pi renew its own run-out Anthropic login; true when its token is valid afterwards, false as well when Pi has no
 * such login. Pi resolves the provider's authentication and, for an OAuth token about to run out, refreshes it under
 * the lock of its credential store. Joins a renewal that is running, and answers false at once while the wait after
 * the last failed one lasts.
 */
async function renewPiLogin(ctx: ExtensionContext | null): Promise<boolean> {
	const login = await piLogin();
	if (login.valid) return true;
	if (!ctx || !login.renewable) return false;
	if (piGate.running) return piGate.running;
	if (Date.now() < piGate.nextAt) return false;
	piGate.nextAt = Date.now() + piGate.retryMs;
	const running = ctx.modelRegistry
		.getProviderAuth("anthropic")
		.catch(() => {
			// whether the token is valid now decides
		})
		.then(() => piLogin())
		.then(({ valid }) => {
			piGate.retryMs = valid ? RETRY_MS : Math.min(piGate.retryMs * 2, MAX_RETRY_MS);
			if (valid) piGate.nextAt = 0; // a renewed login runs out again hours later, and is then renewed at once
			return valid;
		})
		.finally(() => {
			if (piGate.running === running) piGate.running = null;
		});
	piGate.running = running;
	return running;
}

/** Claude Code's access token while it is valid for at least another minute, else undefined. */
async function claudeCodeAccess(): Promise<string | undefined> {
	try {
		const o = (await claudeCodeCredentials())?.claudeAiOauth;
		const valid = typeof o?.accessToken === "string" && o.accessToken !== "" && (!o.expiresAt || o.expiresAt > Date.now() + MARGIN_MS);
		return valid ? o.accessToken : undefined;
	} catch {
		return undefined;
	}
}

/** Whether Claude Code's access token is valid for at least another minute. */
async function claudeCodeLoginValid(): Promise<boolean> {
	return (await claudeCodeAccess()) !== undefined;
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
		// It outranks the stored login, which would then be neither used nor renewed.
		CLAUDE_CODE_OAUTH_TOKEN: undefined,
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

/** Process-wide, so the runtimes /reload replaces share what they learnt. */
interface Organizations {
	/** Token hash -> organization id, oldest first. */
	known: Map<string, string>;
	/** Token hash -> when its organization could last not be told. */
	failedAt: Map<string, number>;
	/** Token hash -> the request that is running. */
	asking: Map<string, Promise<string | undefined>>;
}

const organizations = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi.claude-login.organizations.v1")] ??= {
	known: new Map(),
	failedAt: new Map(),
	asking: new Map(),
}) as Organizations;

function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/**
 * The organization a claude.ai token belongs to, from the header GET /v1/models answers with, or undefined when it
 * cannot be told now; asked again ORGANIZATION_RETRY_MS after that. Joins a request that is running.
 */
async function organizationOf(token: string): Promise<string | undefined> {
	const key = tokenHash(token);
	const known = organizations.known.get(key);
	if (known) return known;
	const running = organizations.asking.get(key);
	if (running) return running;
	if (Date.now() - (organizations.failedAt.get(key) ?? 0) < ORGANIZATION_RETRY_MS) return undefined;
	const asking = (async () => {
		try {
			const response = await fetch(MODELS_URL, {
				headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
				signal: AbortSignal.timeout(ORGANIZATION_TIMEOUT_MS),
			});
			const organization = response.ok ? response.headers.get(ORGANIZATION_HEADER) : null;
			await response.body?.cancel().catch(() => {});
			if (organization) {
				organizations.known.set(key, organization);
				organizations.failedAt.delete(key);
				for (const old of organizations.known.keys()) {
					if (organizations.known.size <= ORGANIZATION_CACHE_SIZE) break;
					organizations.known.delete(old);
				}
				return organization;
			}
		} catch {
			// no network, or no answer in time
		}
		organizations.failedAt.set(key, Date.now());
		return undefined;
	})().finally(() => organizations.asking.delete(key));
	organizations.asking.set(key, asking);
	return asking;
}

/**
 * Whether a login's token belongs to the account of CLAUDE_CODE_OAUTH_TOKEN: true without that variable, and while
 * either organization cannot be told.
 */
async function sameAccount(token: string): Promise<boolean> {
	const reference = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
	if (!reference || reference === token) return true;
	const [wanted, found] = await Promise.all([organizationOf(reference), organizationOf(token)]);
	return !wanted || !found || wanted === found;
}

/** ClaudeLoginSource.token: Pi's login, then Claude Code's, each renewed first when it ran out and renew is set. */
async function loginToken(ctx: ExtensionContext | null, renew: boolean): Promise<ClaudeLoginToken | ClaudeLoginRefusal> {
	let otherAccount = false;

	let access = (await piLogin()).access;
	let renewed = false;
	if (!access && renew && (await renewPiLogin(ctx).catch(() => false))) {
		access = (await piLogin()).access;
		renewed = access !== undefined;
	}
	if (access) {
		if (await sameAccount(access)) return { value: access, source: "pi", renewed };
		otherAccount = true;
	}

	access = await claudeCodeAccess();
	renewed = false;
	if (!access && renew && (await renewClaudeLogin())) {
		access = await claudeCodeAccess();
		renewed = access !== undefined;
	}
	if (access) {
		if (await sameAccount(access)) return { value: access, source: "claude-code", renewed };
		otherAccount = true;
	}

	return { reason: otherAccount ? "other-account" : "none" };
}

export default function (pi: ExtensionAPI) {
	/** The session's context, for Pi's model registry; without a session only Claude Code's login is renewed. */
	let ctx: ExtensionContext | null = null;
	pi.on("session_start", (_event, context) => {
		ctx = context;
	});
	pi.on("session_shutdown", () => {
		ctx = null;
	});

	const source: ClaudeLoginSource = {
		renew: async () => (await renewPiLogin(ctx).catch(() => false)) || renewClaudeLogin(),
		token: (options) => loginToken(ctx, options?.renew ?? true).catch((): ClaudeLoginRefusal => ({ reason: "none" })),
	};
	pi.events.on("claude-login:source-request", () => pi.events.emit("claude-login:source", source));
	pi.events.emit("claude-login:source", source);
}
