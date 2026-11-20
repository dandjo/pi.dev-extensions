/**
 * Claude login: hands out the claude.ai token, and renews a login once it has run out, for the extensions that need a
 * valid token while no prompt runs. claude-usage.ts asks for it to fetch the plan limits, claude-remote-control.ts for
 * its connection. On its own this file does nothing: no request and no process until an extension asks.
 *
 * The token is Claude Code's login (~/.claude/.credentials.json, on macOS the login keychain), the one the claude-sdk
 * provider's prompts run on unless CLAUDE_CODE_OAUTH_TOKEN is set. Pi's own Anthropic login (/login in Pi,
 * ~/.pi/agent/auth.json) is not used: one login for the prompts and for these extensions, renewed in one place.
 *
 * Claude Code renews its OAuth token only when it makes a request, and the claude-sdk provider ends its processes
 * when they idle, so after about eight hours without a prompt the token has run out. Pi never refreshes that token
 * itself: that would rotate Claude Code's refresh token behind its back. A short Claude Code process (Agent SDK, no
 * prompt, no settings, nothing persisted) is asked for its usage instead (get_usage): a request without a model call,
 * which Claude Code sends only after renewing the token under its own lock.
 *
 * A login that reached its time limit cannot be renewed: Claude Code then keeps it without a refresh token (and marks
 * it loginEnded). token() answers reason "ended" for it at once, without starting a process; it needs a new login.
 *
 * /claude-login signs Claude Code in, with another account if need be: Pi's own /login signs in only Pi's anthropic
 * provider and never reaches the claude-sdk provider. The command runs `claude auth login` (its --sso and --email
 * options pass on) with the Claude Code program the Agent SDK brings, else `claude` on the PATH, in Pi's login dialog.
 * Claude Code opens its sign-in page in the browser and takes the answer on this machine's localhost, so nothing needs
 * typing in Pi. Where the browser cannot reach that (over SSH), the dialog shows Claude Code's other link, whose page
 * shows a code to paste into the dialog. Esc cancels; a cancelled or failed sign-in leaves the login as it was.
 * Afterwards the command names the account and plan, and "claude-login:changed" on the event bus has claude-usage.ts
 * fetch the limits of the new account at once. A Claude Code process notices the changed login file and uses the new
 * login with its next request, so the claude-sdk sessions run on it from their next prompt.
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
 * One renewal runs at a time in a Pi process, whichever extension asks, and the next one waits RETRY_MS
 * after it started. After one that leaves no valid token the wait doubles, up to MAX_RETRY_MS, so a login that needs
 * /login does not start a Claude Code process, or ask the token endpoint, every few minutes while Pi stays open.
 *
 * A prompt or a compaction that fails because Claude Code's login cannot be used (Claude Code's own text, passed on by
 * the claude-sdk provider: "Failed to authenticate", "reached its time limit", "claude auth login") gets a notice below
 * the error that names /claude-login. One that fails because the account used up its plan limit ("You've hit your
 * weekly limit · resets …", "out of usage credits") gets a notice that /claude-login signs in another account; while
 * CLAUDE_CODE_OAUTH_TOKEN is set, it says that the prompts run on that token instead, which outranks any login. While
 * auto-continue.ts is loaded (it answers "auto-continue:state-request"), the run waits for the reset instead of ending,
 * so that notice says a waiting run continues at once on the account /claude-login signs in, and asks for no new
 * prompt. The error itself stays as it is, also in the saved session. A branch summary of /tree fails another way and
 * gets no notice.
 *
 * Other extensions reach it through the event bus, whatever the load order: "claude-login:source" carries a
 * ClaudeLoginSource, at load and on every "claude-login:source-request". An extension that finds none reads Claude
 * Code's login itself, without the renewal and the account check.
 */

import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	keyHint,
	LoginDialogComponent,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, hyperlink } from "@earendil-works/pi-tui";
import { execFile, spawn } from "node:child_process";
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
/** Claude Code's answer to a login it cannot use, as the claude-sdk provider passes it on. */
const LOGIN_FAILURE = /Failed to authenticate|reached its time limit|claude auth login|OAuth token has expired/i;
const LOGIN_NOTICE = "Claude Code's login cannot be used: run /claude-login";
/** Claude Code's answer once the account used up its plan limit or its usage credits. */
const LIMIT_REACHED = /You['\u2019]ve hit your [^\n]*limit|out of (?:extra usage|usage credits)/i;
const LIMIT_NOTICE =
	"This Claude account has used up its limit: /claude-login signs Claude Code in with another one (Pi's /login does not reach the claude-sdk provider)";
const LIMIT_TOKEN_NOTICE =
	"This Claude account has used up its limit. The prompts run on CLAUDE_CODE_OAUTH_TOKEN, which outranks any login: start Pi with a token of another account, or without the variable after /claude-login";
/** LIMIT_NOTICE while auto-continue.ts holds the run until the reset. */
const LIMIT_WAIT_NOTICE =
	"This Claude account has used up its limit: /claude-login signs Claude Code in with another one, and a run waiting for the reset continues on it at once (Pi's /login does not reach the claude-sdk provider)";
const LOGIN_COMMAND = "claude-login";
const STATUS_TIMEOUT_MS = 15_000;

/** What "claude-login:source" carries. */
export interface ClaudeLoginSource {
	/**
	 * Has Claude Code renew its run-out claude.ai login. True when its token is valid afterwards. Joins a renewal that is
	 * running, and answers false at once while the wait after the last one lasts or the login has ended. Never rejects.
	 * To be called once the caller found no valid token, not before. token() does this itself.
	 */
	renew(): Promise<boolean>;
	/**
	 * The claude.ai access token of Claude Code's login, valid for at least another minute. With renew (the default) a
	 * run-out login is renewed by Claude Code first, as renew() does. While CLAUDE_CODE_OAUTH_TOKEN is set, a login of
	 * another organization is passed over. Without a token, reason says whether there was none, the login ended (it
	 * needs /login in Claude Code), or it is one of another account. Never rejects.
	 */
	token(options?: { renew?: boolean }): Promise<ClaudeLoginToken | ClaudeLoginRefusal>;
}

/** What token() answers with a token, and whether it was renewed for this call. */
export interface ClaudeLoginToken {
	value: string;
	renewed: boolean;
}

/**
 * What token() answers without one: no valid login, a login that reached its time limit and needs /login in Claude
 * Code, or a login of another account than CLAUDE_CODE_OAUTH_TOKEN.
 */
export interface ClaudeLoginRefusal {
	value?: undefined;
	reason: "none" | "ended" | "other-account";
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

/**
 * The Claude Agent SDK that pi-claude-subscription brings, wherever Pi installed that package: in the user scope
 * (~/.pi/agent/npm) or the project scope (.pi/npm); hoisted, or below the package itself. Undefined when it is in
 * neither.
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
	return find([path.join(getAgentDir(), "npm", "node_modules"), path.join(process.cwd(), ".pi", "npm", "node_modules")]);
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

/**
 * Claude Code's login: its access token while it is valid for at least another minute, and whether the login has
 * ended, so that no renewal can help: Claude Code keeps a login that reached its time limit without a refresh token.
 */
async function claudeCodeLogin(): Promise<{ access?: string; ended: boolean }> {
	try {
		const o = (await claudeCodeCredentials())?.claudeAiOauth;
		if (!o) return { ended: false };
		const valid = typeof o.accessToken === "string" && o.accessToken !== "" && (!o.expiresAt || o.expiresAt > Date.now() + MARGIN_MS);
		const ended = Boolean(o.loginEnded) || typeof o.refreshToken !== "string" || o.refreshToken === "";
		return { ...(valid ? { access: o.accessToken } : {}), ended };
	} catch {
		return { ended: false };
	}
}

/** Whether Claude Code's access token is valid for at least another minute. */
async function claudeCodeLoginValid(): Promise<boolean> {
	return (await claudeCodeLogin()).access !== undefined;
}

/**
 * The environment of a Claude Code process that works on its stored login: the subscription login, as the claude-sdk
 * provider runs Claude Code, without CLAUDE_CODE_OAUTH_TOKEN, which outranks the stored login (it would then be neither
 * used nor renewed); and usage counts as nonessential traffic.
 */
function storedLoginEnv(): Record<string, string | undefined> {
	return {
		...process.env,
		ANTHROPIC_API_KEY: undefined,
		ANTHROPIC_AUTH_TOKEN: undefined,
		CLAUDE_CODE_OAUTH_TOKEN: undefined,
		CLAUDE_CODE_USE_BEDROCK: undefined,
		CLAUDE_CODE_USE_VERTEX: undefined,
		CLAUDE_CODE_USE_FOUNDRY: undefined,
		CLAUDECODE: undefined,
		CLAUDE_CODE_ENTRYPOINT: undefined,
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: undefined,
	};
}

async function askClaudeCodeForUsage(): Promise<void> {
	const sdkDir = claudeSdkDir();
	if (!sdkDir) throw new Error("The Claude Agent SDK is not installed: `pi install npm:pi-claude-subscription` brings it (see the README).");
	const sdk = (await import(pathToFileURL(path.join(sdkDir, "sdk.mjs")).href)) as ClaudeSdk;
	const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => {}) }) };
	const env = storedLoginEnv();
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
 * running, and answers false at once while the wait after the last one lasts or the login has ended.
 */
async function renewClaudeLogin(): Promise<boolean> {
	if (gate.running) return gate.running;
	const login = await claudeCodeLogin();
	if (login.access) return true;
	if (login.ended) return false;
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

/** ClaudeLoginSource.token: Claude Code's login, renewed first when it ran out and renew is set. */
async function loginToken(renew: boolean): Promise<ClaudeLoginToken | ClaudeLoginRefusal> {
	const login = await claudeCodeLogin();
	let access = login.access;
	let renewed = false;
	if (!access && login.ended) return { reason: "ended" };
	if (!access && renew && (await renewClaudeLogin())) {
		access = (await claudeCodeLogin()).access;
		renewed = access !== undefined;
	}
	if (!access) return { reason: (await claudeCodeLogin()).ended ? "ended" : "none" };
	if (await sameAccount(access)) return { value: access, renewed };
	return { reason: "other-account" };
}

/**
 * The Claude Code program for `claude auth`: the one the Claude Agent SDK brings, which the claude-sdk provider runs,
 * looked up as the SDK does (on Linux the glibc build first, the musl one first without glibc), else `claude` on the
 * PATH. Undefined without either.
 */
function claudeProgram(): string | undefined {
	const exe = process.platform === "win32" ? ".exe" : "";
	const sdkDir = claudeSdkDir();
	if (sdkDir) {
		const base = `claude-agent-sdk-${process.platform}-${process.arch}`;
		let names = [base];
		if (process.platform === "linux") {
			const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
			names = header?.glibcVersionRuntime ? [base, `${base}-musl`] : [`${base}-musl`, base];
		}
		for (const name of names) {
			for (const root of [path.join(sdkDir, "node_modules", "@anthropic-ai"), path.dirname(sdkDir)]) {
				const file = path.join(root, name, `claude${exe}`);
				if (existsSync(file)) return file;
			}
		}
	}
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		const file = dir ? path.join(dir, `claude${exe}`) : "";
		if (file && existsSync(file)) return file;
	}
	return undefined;
}

/** The options of `claude auth login` that /claude-login passes on, or undefined for anything else. */
function loginArguments(args: string): string[] | undefined {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const out: string[] = [];
	for (let i = 0; i < words.length; i++) {
		if (words[i] === "--sso") out.push("--sso");
		else if (words[i] === "--email" && words[i + 1] && !words[i + 1].startsWith("-")) out.push("--email", words[++i]);
		else return undefined;
	}
	return out;
}

const LOGIN_OPTIONS: AutocompleteItem[] = [
	{ value: "--sso", label: "--sso", description: "Sign in through your organization's single sign-on" },
	{ value: "--email ", label: "--email", description: "Fill in the email address on the sign-in page" },
];

/** Who Claude Code is signed in as, from `claude auth status --json`; undefined when that cannot be told. */
interface ClaudeAccount {
	loggedIn: boolean;
	email?: string;
	organization?: string;
	plan?: string;
}

async function claudeAccount(program: string): Promise<ClaudeAccount | undefined> {
	let stdout: string;
	try {
		({ stdout } = await execFileAsync(program, ["auth", "status", "--json"], { env: storedLoginEnv(), timeout: STATUS_TIMEOUT_MS }));
	} catch (e) {
		// It exits with 1 while signed out, the answer on stdout all the same.
		stdout = String((e as { stdout?: unknown }).stdout ?? "");
	}
	try {
		const status = JSON.parse(stdout);
		const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
		return {
			loggedIn: status.loggedIn === true,
			email: text(status.email),
			organization: text(status.orgName),
			plan: text(status.subscriptionType),
		};
	} catch {
		return undefined;
	}
}

/** "name@example.com (Example, max)", as far as it is known. */
function describeAccount(account: ClaudeAccount): string {
	const details = [account.organization, account.plan].filter(Boolean).join(", ");
	return `${account.email ?? "an account"}${details ? ` (${details})` : ""}`;
}

type SignInResult = { ok: true } | { ok: false; cancelled: boolean; error?: string };

/** Text Claude Code printed, without its terminal sequences: hyperlinks, colours, carriage returns. */
function plainOutput(text: string): string {
	return text
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\r/g, "");
}

/**
 * Runs `claude auth login` in Pi's login dialog until it ends, or Esc ends it. Undefined where Pi cannot show the
 * dialog.
 */
async function signIn(ctx: ExtensionCommandContext, program: string, args: string[]): Promise<SignInResult | undefined> {
	return ctx.ui.custom<SignInResult>((tui, _theme, keybindings, done) => {
		const child = spawn(program, ["auth", "login", ...args], { env: storedLoginEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let finished = false;
		const stop = () => {
			finished = true;
			if (child.exitCode === null && child.signalCode === null) child.kill();
		};
		const finish = (result: SignInResult) => {
			if (finished) return;
			stop();
			done(result);
		};
		const dialog = new LoginDialogComponent(
			tui,
			"claude-sdk",
			(success) => {
				if (!success) finish({ ok: false, cancelled: true });
			},
			"Claude Code",
			"Sign in to Claude Code",
		);
		dialog.showDetails(["Claude Code opens its sign-in page in your browser: sign in there with the account to run on."]);

		let output = "";
		let errors = "";
		let link: string | undefined;
		let copied = false;
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
			if (link || finished) return;
			// The link of the page that shows a code, for a browser that cannot reach this machine's localhost.
			const found = output.match(/https:\/\/[^\s\u0007\u001b]+/)?.[0];
			if (!found) return;
			link = found;
			dialog.showInfo("Browser didn't open, or it runs on another machine? Open this page, and paste the code it shows:", [
				{ url: link },
			]);
			const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
			dialog.showProgress(`${hyperlink(clickHint, link)} • ${keyHint("app.message.copy", "to copy")}`);
			dialog
				.showManualInput("Code:")
				.then((code) => {
					if (finished || !code.trim()) return;
					dialog.showProgress("Checking the code…");
					child.stdin.write(`${code.trim()}\n`);
				})
				.catch(() => {
					// cancelled: the dialog's onComplete ends the sign-in
				});
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			errors += chunk;
		});
		child.stdin.on("error", () => {
			// the process ended before the code arrived; its exit tells
		});
		child.on("error", (error) => finish({ ok: false, cancelled: false, error: error.message }));
		child.on("close", (code) => {
			if (code === 0) return finish({ ok: true });
			const said = plainOutput(errors || output)
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("Paste code here"));
			finish({ ok: false, cancelled: false, error: said.at(-1) ?? `claude auth login ended with exit code ${code}` });
		});

		const handleInput = dialog.handleInput.bind(dialog);
		return Object.assign(dialog, {
			handleInput(data: string) {
				if (link && keybindings.matches(data, "app.message.copy")) {
					const url = link;
					void copyToClipboard(url).then(
						() => {
							if (!copied && !finished) dialog.showProgress("Copied the link to the clipboard.");
							copied = true;
						},
						(error: unknown) => {
							if (!finished) dialog.showProgress(error instanceof Error ? error.message : String(error));
						},
					);
					return;
				}
				handleInput(data);
			},
			// Pi closes the dialog (a /reload, the session's end): the sign-in ends with it.
			dispose: stop,
		});
	});
}

/** /claude-login: signs Claude Code in, with another account if need be, and says who it is signed in as. */
async function claudeLoginCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return;
	const options = loginArguments(args);
	if (!options) {
		ctx.ui.notify(`Usage: /${LOGIN_COMMAND} [--sso] [--email <address>]`, "warning");
		return;
	}
	const program = claudeProgram();
	if (!program) {
		ctx.ui.notify(
			"Neither the Claude Agent SDK nor Claude Code is installed: `pi install npm:pi-claude-subscription` brings the SDK (see the README).",
			"error",
		);
		return;
	}
	const result = await signIn(ctx, program, options);
	if (!result) {
		ctx.ui.notify("Signing in needs Pi's interactive mode: run `claude auth login` in a shell.", "warning");
		return;
	}
	if (!result.ok) {
		if (result.cancelled) ctx.ui.notify("Sign-in cancelled: Claude Code's login stays as it was.", "info");
		else ctx.ui.notify(`Claude Code: ${result.error ?? "the sign-in failed"} Its login stays as it was.`, "error");
		return;
	}
	// A login that waits after a failed renewal is valid now.
	gate.nextAt = 0;
	gate.retryMs = RETRY_MS;
	pi.events.emit("claude-login:changed", undefined);
	const account = await claudeAccount(program);
	const who = account?.loggedIn ? `Claude Code is signed in as ${describeAccount(account)}.` : "Claude Code is signed in.";
	ctx.ui.notify(`${who} The claude-sdk sessions run on it from their next prompt.`, "info");
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
		ctx.ui.notify(
			"CLAUDE_CODE_OAUTH_TOKEN is set and outranks this login: the claude-sdk prompts keep running on its account until Pi starts without it.",
			"warning",
		);
	}
}

export default function (pi: ExtensionAPI) {
	const source: ClaudeLoginSource = {
		renew: () => renewClaudeLogin().catch(() => false),
		token: (options) => loginToken(options?.renew ?? true).catch((): ClaudeLoginRefusal => ({ reason: "none" })),
	};
	pi.events.on("claude-login:source-request", () => pi.events.emit("claude-login:source", source));
	pi.events.emit("claude-login:source", source);

	pi.registerCommand(LOGIN_COMMAND, {
		description: "Sign Claude Code in, with another account if need be: the login the claude-sdk provider runs on",
		getArgumentCompletions: (prefix) => {
			const last = prefix.split(/\s+/).at(-1) ?? "";
			const items = LOGIN_OPTIONS.filter((item) => item.label.startsWith(last) && !prefix.includes(item.label));
			return items.length > 0 ? items : null;
		},
		handler: (args, ctx) => claudeLoginCommand(pi, args, ctx),
	});

	/** The notice for a prompt or compaction that failed with Claude Code's text, if it names a login or a limit. */
	const notice = (error: string): string | undefined => {
		if (LOGIN_FAILURE.test(error)) return LOGIN_NOTICE;
		if (LIMIT_REACHED.test(error)) return process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ? LIMIT_TOKEN_NOTICE : LIMIT_NOTICE;
		return undefined;
	};

	/** auto-continue.ts is loaded: a run that hits the limit waits for the reset. */
	let autoContinue = false;
	pi.events.on("auto-continue:state", () => {
		autoContinue = true;
	});
	pi.events.emit("auto-continue:state-request", undefined);

	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; stopReason?: string; provider?: string; errorMessage?: string };
		if (message.role !== "assistant" || message.stopReason !== "error" || message.provider !== "claude-sdk") return;
		const text = ctx.hasUI ? notice(message.errorMessage ?? "") : undefined;
		if (!text) return;
		if (autoContinue && text !== LOGIN_NOTICE) {
			ctx.ui.notify(`${text === LIMIT_NOTICE ? LIMIT_WAIT_NOTICE : text}.`, "warning");
			return;
		}
		ctx.ui.notify(`${text}, then send the prompt again.`, "warning");
	});

	pi.on("session_compact_failed", (event, ctx) => {
		if (!ctx.hasUI || ctx.model?.provider !== "claude-sdk") return;
		const text = notice(event.errorMessage ?? "");
		if (text) ctx.ui.notify(`${text}${event.reason === "manual" ? ", then /compact again" : ""}.`, "warning");
	});
}
