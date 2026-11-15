/**
 * Claude usage: the Claude subscription limits as rows of the status line (statusline.ts), as Claude Code's /usage
 * dialog shows them.
 *
 * Rows: the 5h session, the 7d week, and model-scoped weekly windows such as Fable, each with its local reset time,
 * and the usage credits while they are enabled or anything was spent. Without a usable answer, a single "Limits" row
 * says why (loading, rate limited, no token, …). Without any Claude login (Pi's own or Claude Code's) there are no
 * rows and no requests at all, so a user of another provider sees nothing of this. While the session's model is not a
 * Claude model (or it has none), the rows are hidden as well; the limits are still fetched, so they stand there as soon
 * as a Claude model is chosen again. With PI_OFFLINE set, the rows show what another session fetched last, and this
 * one fetches nothing.
 *
 * Times, dates, and amounts follow the locale of LC_TIME and LC_MONETARY (or LC_ALL, else LANG), as other programs
 * on the machine do; Node's own Intl default reads LANG alone.
 *
 * Limits come from https://api.anthropic.com/api/oauth/usage (the endpoint Claude Code's /usage dialog uses),
 * fetched in the background so a render never waits on the network, and only while the status line shows the rows.
 * The endpoint is rate-limited per account, so all pi sessions share one answer through CACHE_FILE: whichever
 * session takes the lock asks, at most every USAGE_TTL_MS, and the others read the file. The OAuth access token is
 * read from pi's auth.json (falling back to Claude Code's credentials), never written to the cache, and never
 * refreshed here: rotating it would invalidate the refresh token behind the owning app's back. When neither is valid,
 * claude-login.ts is asked to have Claude Code renew its own ("claude-login:source" on the event bus), as it runs out
 * after hours without a prompt; without that extension the rows wait for the next prompt to renew it.
 *
 * Without either login, a CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) stands in. The usage endpoint turns it
 * away (it lacks the user:profile scope), so the limits come from the anthropic-ratelimit-unified-* headers of a real
 * model call instead: the newest Haiku the token may use, one output token, at most every PROBE_TTL_MS. Those headers
 * carry the 5h and 7d windows only when the API sends them (no model-scoped windows, no credits), and the rows say
 * "via CLAUDE_CODE_OAUTH_TOKEN". As soon as a login token is valid again, the endpoint takes over.
 *
 * The rows reach statusline.ts through the event bus ("statusline:section"); without it this file does nothing.
 * Other extensions read the answer through the event bus as well: "claude-usage:source" carries a ClaudeUsageSource,
 * at load and on every "claude-usage:source-request", and "claude-usage:changed" follows every new state.
 * claude-remote-control.ts hands the limits to the Claude app that way.
 */

import { type ExtensionAPI, getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const SECTION_ID = "claude-usage";
const POLL_MS = 10_000;
const USAGE_TTL_MS = 120_000;
const USAGE_STALE_MS = 600_000;
const USAGE_MAX_AGE_MS = 3_600_000;
const LOCK_STALE_MS = 30_000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** The environment variable of a long-lived token from `claude setup-token`: model calls only, no usage endpoint. */
const ENV_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";
const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";
const PROBE_URL = "https://api.anthropic.com/v1/messages";
/** A probe is a model call billed to the plan, so it runs far less often than the endpoint is asked. */
const PROBE_TTL_MS = 600_000;
const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "pi-statusline");
const CACHE_FILE = path.join(CACHE_DIR, "usage.json");
const LOCK_FILE = path.join(CACHE_DIR, "usage.lock");

interface LimitRow {
	label: string;
	percent: number;
	resetsAt: string | null;
}

interface Credits {
	enabled: boolean;
	used: number;
	limit: number;
	places: number;
	currency: string;
}

export interface UsageSnapshot {
	fetchedAt: number;
	limits: LimitRow[];
	credits: Credits | null;
	/** The endpoint's windows, limit rows and extra usage as it sent them (ANSWER_KEYS); absent in older cache files. */
	answer?: Record<string, unknown>;
	/** "token": read from the rate-limit headers of a model call with CLAUDE_CODE_OAUTH_TOKEN, not from the endpoint. */
	via?: "token";
}

/** What "claude-usage:source" carries. */
export interface ClaudeUsageSource {
	/** The latest answer younger than USAGE_MAX_AGE_MS, or null. */
	snapshot(): UsageSnapshot | null;
	/** Asks the endpoint unless the shared answer is younger than USAGE_TTL_MS (PROBE_TTL_MS for one via the token); settles once that is done. */
	refresh(): Promise<void>;
}

/** The fields of the endpoint's answer that Claude Code's get_usage reply is built from. */
const ANSWER_KEYS = ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet", "limits", "extra_usage"];

/** What every pi session reads from CACHE_FILE. */
interface UsageState {
	attemptAt: number;
	updatedAt: number;
	snapshot: UsageSnapshot | null;
	/** Why the attempt at attemptAt failed; null while it runs and once it succeeded. */
	error: string | null;
}

type LockResult = "acquired" | "busy" | "unshared";

/**
 * The locale of a POSIX category as LC_ALL, the category's own variable, or LANG name it (de_AT.UTF-8 is de-AT), the
 * first one set winning; undefined for C and POSIX or an unknown one, which leaves Intl its default. Node's Intl reads
 * LANG alone, so LC_TIME=de_AT under LANG=en_US would otherwise show US dates. scheduled-tasks.ts carries a copy of
 * this function: change them alike.
 */
function posixLocale(category: "LC_TIME" | "LC_MONETARY"): string | undefined {
	for (const value of [process.env.LC_ALL, process.env[category], process.env.LANG]) {
		if (!value) continue;
		const tag = value.split(/[.@]/)[0].replace(/_/g, "-");
		if (tag === "C" || tag === "POSIX") return undefined;
		try {
			return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0 ? tag : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

const TIME_LOCALE = posixLocale("LC_TIME");
const MONEY_LOCALE = posixLocale("LC_MONETARY");

/** The time of day in the locale, e.g. "21:29" or "09:29 PM". */
const hhmm = (d: Date) => d.toLocaleTimeString(TIME_LOCALE, { hour: "2-digit", minute: "2-digit" });

/** "21:29" today, "Sa., 24.10., 19:59" later (in the locale); plus "3h 2m" left. */
function fmtReset(iso: string): { at: string; left: string } | null {
	const target = new Date(iso);
	if (Number.isNaN(target.getTime())) return null;
	const now = new Date();
	const diff = target.getTime() - now.getTime();
	if (diff <= 0) return { at: "now", left: "" };

	const at =
		target.toDateString() === now.toDateString()
			? hhmm(target)
			: target.toLocaleString(TIME_LOCALE, { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

	const d = Math.floor(diff / 86_400_000);
	const h = Math.floor((diff % 86_400_000) / 3_600_000);
	const m = Math.floor((diff % 3_600_000) / 60_000);
	const left = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
	return { at, left };
}

function fmtMoney(minor: number, places: number, currency: string): string {
	const amount = minor / 10 ** places;
	try {
		return new Intl.NumberFormat(MONEY_LOCALE, {
			style: "currency",
			currency,
			minimumFractionDigits: places,
			maximumFractionDigits: places,
		}).format(amount);
	} catch {
		return `${currency} ${amount.toFixed(places)}`;
	}
}

const execFileAsync = promisify(execFile);

function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/**
 * Claude Code's stored login, the JSON with claudeAiOauth, or undefined. On macOS Claude Code keeps it in the login
 * keychain as the generic password "Claude Code-credentials" (with CLAUDE_CONFIG_DIR set, followed by "-" and the first
 * eight hex digits of that directory's SHA-256), and .credentials.json is only its fallback; elsewhere the file is the
 * store. macOS 26 prints a password with non-ASCII content as hex, which is decoded here.
 * claude-login.ts, claude-remote-control.ts carry a copy of this function: change them alike.
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

/** Valid (non-expired) OAuth access token: pi's own login first, then Claude Code's. */
async function readAccessToken(): Promise<string | null> {
	const now = Date.now();
	try {
		const pi = JSON.parse(await readFile(path.join(getAgentDir(), "auth.json"), "utf8"));
		const a = pi?.anthropic;
		if (a?.type === "oauth" && a.access && (!a.expires || a.expires > now)) return a.access;
		if (a?.access && (!a.expires || a.expires > now)) return a.access;
	} catch {}
	try {
		const o = (await claudeCodeCredentials())?.claudeAiOauth;
		if (o?.accessToken && (!o.expiresAt || o.expiresAt > now)) return o.accessToken;
	} catch {}
	return null;
}

/**
 * Whether a model is Claude: one of the providers that only carry Claude models, or "claude" in the id elsewhere.
 * claude-remote-control.ts carries a copy of this function: change them alike.
 */
function isClaudeModel(model: { provider: string; id: string } | undefined): boolean {
	if (!model) return false;
	return model.provider === "claude-sdk" || model.provider === "anthropic" || /claude/i.test(model.id);
}

/** The last answer of hasClaudeLogin, kept LOGIN_CHECK_MS so a macOS keychain is not asked at every poll. */
let loginCheck: { at: number; present: boolean } | undefined;
const LOGIN_CHECK_MS = 60_000;

/** Whether there is a Claude login at all, valid or not: Pi's own OAuth login, Claude Code's, or CLAUDE_CODE_OAUTH_TOKEN. */
async function hasClaudeLogin(): Promise<boolean> {
	if (process.env[ENV_TOKEN]) return true;
	if (loginCheck && Date.now() - loginCheck.at < LOGIN_CHECK_MS) return loginCheck.present;
	let present = false;
	try {
		const pi = JSON.parse(await readFile(path.join(getAgentDir(), "auth.json"), "utf8"));
		present = pi?.anthropic?.type === "oauth";
	} catch {}
	if (!present) present = Boolean((await claudeCodeCredentials())?.claudeAiOauth);
	loginCheck = { at: Date.now(), present };
	return present;
}

function parseUsage(json: any): UsageSnapshot {
	const limits: LimitRow[] = [];
	if (Array.isArray(json?.limits)) {
		for (const l of json.limits) {
			if (typeof l?.percent !== "number") continue;
			let label: string | null = null;
			if (l.kind === "session") label = "5h";
			else if (l.kind === "weekly_all") label = "7d";
			else if (l.kind === "weekly_scoped") label = l.scope?.model?.display_name ?? null;
			if (label) limits.push({ label, percent: l.percent, resetsAt: l.resets_at ?? null });
		}
	} else {
		// Older response shape
		for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
			const w = json?.[key];
			if (typeof w?.utilization === "number") limits.push({ label, percent: w.utilization, resetsAt: w.resets_at ?? null });
		}
	}

	let credits: Credits | null = null;
	const x = json?.extra_usage;
	if (x && typeof x === "object") {
		credits = {
			enabled: x.is_enabled === true,
			used: Math.floor(x.used_credits ?? 0),
			limit: Math.floor(x.monthly_limit ?? 0),
			places: x.decimal_places ?? 2,
			currency: x.currency ?? "USD",
		};
	}
	const answer = Object.fromEntries(ANSWER_KEYS.filter((key) => json?.[key] !== undefined).map((key) => [key, json[key]]));
	return { fetchedAt: Date.now(), limits, credits, answer };
}

/** The headers of a model call with CLAUDE_CODE_OAUTH_TOKEN; the OAuth beta lets the API take the token as Bearer. */
function probeHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"anthropic-beta": "oauth-2025-04-20",
		"anthropic-version": "2023-06-01",
		"content-type": "application/json",
	};
}

/** The newest Haiku the token may use (the model list comes newest first), looked up once per process. */
let probeModel: string | undefined;

async function haikuModel(token: string): Promise<string | { error: string }> {
	if (probeModel) return probeModel;
	let res: Response;
	try {
		res = await fetch(MODELS_URL, { headers: probeHeaders(token), signal: AbortSignal.timeout(10_000) });
	} catch {
		return { error: "endpoint unreachable" };
	}
	if (!res.ok) return { error: `model list: HTTP ${res.status}` };
	try {
		const data = (await res.json())?.data;
		const ids = Array.isArray(data) ? data.map((m: any) => m?.id).filter((id: unknown) => typeof id === "string") : [];
		probeModel = ids.find((id: string) => /haiku/i.test(id));
	} catch {
		return { error: "unreadable model list" };
	}
	return probeModel ?? { error: "no Haiku model for the token" };
}

/**
 * The limits from the anthropic-ratelimit-unified-<window>-utilization (a fraction) and -reset (epoch seconds) headers
 * of a model call with one output token. A full plan answers 429 with the same headers, so they are read whatever the
 * status; only without them does the status become the error.
 */
async function probeUsage(token: string): Promise<{ snapshot: UsageSnapshot } | { error: string }> {
	const model = await haikuModel(token);
	if (typeof model !== "string") return model;
	let res: Response;
	try {
		res = await fetch(PROBE_URL, {
			method: "POST",
			headers: probeHeaders(token),
			body: JSON.stringify({
				model,
				max_tokens: 1,
				system: "You are Claude Code, Anthropic's official CLI for Claude.",
				messages: [{ role: "user", content: "." }],
			}),
			signal: AbortSignal.timeout(20_000),
		});
		await res.text();
	} catch {
		return { error: "endpoint unreachable" };
	}
	if (res.status === 404) probeModel = undefined; // retired since the lookup: look again next time
	const limits: LimitRow[] = [];
	for (const [name, value] of res.headers) {
		const window = /^anthropic-ratelimit-unified-(.+)-utilization$/.exec(name)?.[1];
		const fraction = Number(value);
		if (!window || value === "" || !Number.isFinite(fraction)) continue;
		const reset = Number(res.headers.get(`anthropic-ratelimit-unified-${window}-reset`));
		limits.push({
			label: window,
			percent: Math.round(fraction * 10_000) / 100,
			resetsAt: reset > 0 ? new Date(reset * 1000).toISOString() : null,
		});
	}
	if (limits.length === 0) {
		if (res.status === 429) return { error: "rate limited (HTTP 429)" };
		return { error: res.ok ? "no rate-limit headers" : `HTTP ${res.status}` };
	}
	// 5h before 7d before the rest, as the endpoint orders its rows
	const rank = (label: string) => (label === "5h" ? 0 : label === "7d" ? 1 : 2);
	limits.sort((a, b) => rank(a.label) - rank(b.label));
	return { snapshot: { fetchedAt: Date.now(), limits, credits: null, via: "token" } };
}

/**
 * renew has Claude Code renew a run-out login (claude-login.ts) and answers whether its token is valid afterwards.
 * Without a valid login token, CLAUDE_CODE_OAUTH_TOKEN is probed instead.
 */
async function fetchUsage(renew: () => Promise<boolean>): Promise<{ snapshot: UsageSnapshot } | { error: string }> {
	let token = await readAccessToken();
	if (!token && (await renew())) token = await readAccessToken();
	if (!token) {
		const envToken = process.env[ENV_TOKEN];
		return envToken ? probeUsage(envToken) : { error: "no valid OAuth token" };
	}
	let res: Response;
	try {
		res = await fetch(USAGE_URL, {
			headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		return { error: "endpoint unreachable" };
	}
	if (res.status === 429) return { error: "rate limited (HTTP 429)" };
	if (!res.ok) return { error: `HTTP ${res.status}` };
	try {
		return { snapshot: parseUsage(await res.json()) };
	} catch {
		return { error: "unreadable response" };
	}
}

async function readState(): Promise<UsageState | null> {
	try {
		const s = JSON.parse(await readFile(CACHE_FILE, "utf8"));
		if (typeof s?.attemptAt !== "number" || typeof s?.updatedAt !== "number") return null;
		const snap = s.snapshot;
		const valid = typeof snap?.fetchedAt === "number" && Array.isArray(snap?.limits);
		return {
			attemptAt: s.attemptAt,
			updatedAt: s.updatedAt,
			snapshot: valid ? (snap as UsageSnapshot) : null,
			error: typeof s.error === "string" ? s.error : null,
		};
	} catch {
		return null;
	}
}

async function writeState(s: UsageState): Promise<void> {
	const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
	await rename(tmp, CACHE_FILE); // atomic, so no reader sees half a file
}

/** "busy" while another pi session fetches; "unshared" when the cache directory is unusable. */
async function acquireLock(): Promise<LockResult> {
	try {
		await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
	} catch {
		return "unshared";
	}
	for (let i = 0; i < 2; i++) {
		try {
			await (await open(LOCK_FILE, "wx", 0o600)).close();
			return "acquired";
		} catch (e: any) {
			if (e?.code !== "EEXIST") return "unshared";
		}
		// A lock older than any fetch can take was left behind by a session that died mid-fetch
		try {
			if (Date.now() - (await stat(LOCK_FILE)).mtimeMs < LOCK_STALE_MS) return "busy";
			await unlink(LOCK_FILE);
		} catch (e: any) {
			if (e?.code !== "ENOENT") return "busy";
		}
	}
	return "busy";
}

// A copy of ClaudeLoginSource from claude-login.ts, the event-bus contract between the two: change both alike.
/** What "claude-login:source" carries. */
interface ClaudeLoginSource {
	/**
	 * Has Claude Code renew its run-out claude.ai login; true when its token is valid afterwards. Joins a renewal that is
	 * running, and answers false at once while the wait after the last one lasts. Never rejects. To be called once the
	 * caller found no valid token, not before.
	 */
	renew(): Promise<boolean>;
}

/**
 * The bars of the status line: a label, a bar coloured by how full it is, and the percentage. statusline.ts draws its
 * context row with it, claude-usage.ts its limit rows.
 *
 * statusline.ts carries a copy of this block, or of a part of it: change them alike.
 */
const BAR_WIDTH = 20;
const LABEL_WIDTH = 7;

/** "Context ████████░░░░░░░░░░░░  42%"; a null percentage draws an empty bar with "?%". */
function meter(theme: Theme, label: string, pct: number | null): string {
	const head = label.padEnd(LABEL_WIDTH) + " ";
	if (pct === null) return head + theme.fg("dim", "░".repeat(BAR_WIDTH)) + theme.fg("dim", "   ?%");
	const p = Math.max(0, Math.round(pct));
	const color = p >= 90 ? "error" : p >= 70 ? "warning" : "success";
	const filled = Math.min(BAR_WIDTH, Math.floor((p * BAR_WIDTH) / 100));
	return head + theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(BAR_WIDTH - filled)) + ` ${String(p).padStart(3)}%`;
}

function separator(theme: Theme): string {
	return theme.fg("dim", " | ");
}

// A copy of StatuslineSection from statusline.ts, the event-bus contract between the two: change both alike.
/** Rows another extension adds below line 2 ("statusline:section" on the event bus). */
interface StatuslineSection {
	/** Sections appear in the order of their ids; one emitted again under the same id replaces the earlier one. */
	id: string;
	/** The rows, without indent: the status line indents them and cuts them to the terminal width. */
	render(theme: Theme): string[];
}

export default function (pi: ExtensionAPI) {
	let state: UsageState | null = null;
	let inFlight = false;
	let polledAt = 0;
	/** Undefined until the first check; false hides the rows and stops the requests. */
	let loggedIn: boolean | undefined;
	/** Whether the session's model is a Claude model; false hides the rows, the requests go on. */
	let claudeModel = false;
	/** claude-login.ts, once it answered; without it a run-out login is not renewed here. */
	let loginSource: ClaudeLoginSource | null = null;

	const changed = () => {
		pi.events.emit("statusline:changed", undefined);
		pi.events.emit("claude-usage:changed", undefined);
	};

	/** How long an attempt holds: longer after a probe, as each one is a model call. */
	const holdMs = (s: UsageState | null) => (s?.snapshot?.via === "token" ? PROBE_TTL_MS : USAGE_TTL_MS);

	/** Whether the next attempt is due; a probe's longer wait ends early once a login token is valid again. */
	async function due(): Promise<boolean> {
		const age = Date.now() - (state?.attemptAt ?? 0);
		if (age < USAGE_TTL_MS) return false;
		if (age >= holdMs(state)) return true;
		return (await readAccessToken()) !== null;
	}

	/** Takes over a newer state another session wrote; true when it did. */
	function adopt(shared: UsageState | null): boolean {
		if (!shared || (state && shared.updatedAt <= state.updatedAt)) return false;
		state = shared;
		return true;
	}

	async function refreshUsage() {
		if (inFlight) return;
		inFlight = true;
		let lock: LockResult = "unshared";
		try {
			const login = await hasClaudeLogin();
			if (login !== loggedIn) {
				loggedIn = login;
				changed();
			}
			if (!login) return;
			if (adopt(await readState())) changed();
			if (process.env.PI_OFFLINE) return;
			if (!(await due())) return;

			lock = await acquireLock();
			if (lock === "busy") return; // the other session's answer arrives through the cache
			if (lock === "acquired") {
				// Another session may have finished between the read above and the lock
				if (adopt(await readState())) changed();
				if (!(await due())) return;
			}

			const save = async (next: Omit<UsageState, "updatedAt">) => {
				state = { ...next, updatedAt: Date.now() };
				if (lock === "acquired") await writeState(state).catch(() => {});
				changed();
			};
			// Stamped before the fetch, so a failing endpoint is asked no more often
			const attemptAt = Date.now();
			const previous = state?.snapshot ?? null;
			await save({ attemptAt, snapshot: previous, error: null });
			const result = await fetchUsage(() => loginSource?.renew() ?? Promise.resolve(false));
			await save(
				"snapshot" in result
					? { attemptAt, snapshot: result.snapshot, error: null }
					: { attemptAt, snapshot: previous, error: result.error },
			);
		} finally {
			if (lock === "acquired") await unlink(LOCK_FILE).catch(() => {});
			inFlight = false;
		}
	}

	function render(theme: Theme): string[] {
		// The status line renders at least every 10 s while it is shown, so it paces the refresh
		if (Date.now() - polledAt >= POLL_MS) {
			polledAt = Date.now();
			void refreshUsage();
		}

		if (!loggedIn || !claudeModel) return [];
		const sep = separator(theme);
		const lines: string[] = [];
		const snap = state?.snapshot;
		const usage = snap && Date.now() - snap.fetchedAt < USAGE_MAX_AGE_MS ? snap : null;
		if (!usage) {
			// Say why the rows are missing instead of leaving them out
			const head = "Limits".padEnd(LABEL_WIDTH) + " ";
			if (process.env.PI_OFFLINE) {
				lines.push(head + theme.fg("dim", "not fetched while PI_OFFLINE is set"));
			} else if (state?.error) {
				const next = hhmm(new Date(Math.max(Date.now(), state.attemptAt + holdMs(state))));
				lines.push(head + theme.fg("warning", `⚠ ${state.error}`) + theme.fg("dim", ` · next try ${next}`));
			} else {
				lines.push(head + theme.fg("dim", "loading…"));
			}
			return lines;
		}

		const staleMs = usage.via === "token" ? PROBE_TTL_MS + USAGE_STALE_MS : USAGE_STALE_MS;
		const stale =
			Date.now() - usage.fetchedAt > staleMs ? theme.fg("dim", ` · as of ${hhmm(new Date(usage.fetchedAt))}`) : "";
		let via = usage.via === "token" ? theme.fg("dim", ` · via ${ENV_TOKEN}`) : "";

		for (const row of usage.limits) {
			let line = meter(theme, row.label, row.percent);
			const r = row.resetsAt ? fmtReset(row.resetsAt) : null;
			if (r) {
				line += sep + `⏰ Resets ${theme.fg("accent", r.at)}`;
				if (r.left) line += ` (in ${theme.fg("warning", r.left)})`;
			}
			lines.push(line + stale + via);
			via = "";
		}

		const c = usage.credits;
		if (c && (c.enabled || c.used > 0)) {
			const off = c.enabled ? "" : ` · ${theme.fg("error", "off")}`;
			const used = theme.fg("warning", fmtMoney(c.used, c.places, c.currency));
			if (c.limit > 0) {
				lines.push(
					meter(theme, "Credits", (c.used * 100) / c.limit) +
						sep +
						`💳 ${used} of ${fmtMoney(c.limit, c.places, c.currency)}${off}${stale}`,
				);
			} else {
				const l = Math.floor((BAR_WIDTH - 8) / 2);
				const noLimit = theme.inverse(" ".repeat(l) + "no limit" + " ".repeat(BAR_WIDTH - 8 - l));
				lines.push(
					"Credits".padEnd(LABEL_WIDTH) + " " + theme.fg("dim", noLimit) + "     " + sep + `💳 ${used} this month${off}${stale}`,
				);
			}
		}
		return lines;
	}

	const modelChanged = (model: { provider: string; id: string } | undefined) => {
		const claude = isClaudeModel(model);
		if (claude === claudeModel) return;
		claudeModel = claude;
		pi.events.emit("statusline:changed", undefined);
	};
	// A restored session fires no model_select, so session_start reads the model as well
	pi.on("session_start", (_event, ctx) => modelChanged(ctx.model));
	pi.on("model_select", (event) => modelChanged(event.model));

	const section: StatuslineSection = { id: SECTION_ID, render };
	pi.events.on("statusline:section-request", () => pi.events.emit("statusline:section", section));
	pi.events.emit("statusline:section", section);

	const source: ClaudeUsageSource = {
		snapshot: () => {
			const snap = state?.snapshot;
			return snap && Date.now() - snap.fetchedAt < USAGE_MAX_AGE_MS ? snap : null;
		},
		refresh: () => refreshUsage(),
	};
	pi.events.on("claude-usage:source-request", () => pi.events.emit("claude-usage:source", source));
	pi.events.emit("claude-usage:source", source);

	pi.events.on("claude-login:source", (data) => {
		const offered = data as ClaudeLoginSource | undefined;
		if (typeof offered?.renew === "function") loginSource = offered;
	});
	pi.events.emit("claude-login:source-request", undefined);
}
