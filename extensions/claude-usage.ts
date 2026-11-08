/**
 * Claude usage: the Claude subscription limits as rows of the status line (statusline.ts), as Claude Code's /usage
 * dialog shows them.
 *
 * Rows: the 5h session, the 7d week, and model-scoped weekly windows such as Fable, each with its local reset time,
 * and the usage credits while they are enabled or anything was spent. Without a usable answer, a single "Limits" row
 * says why (loading, rate limited, no token, …).
 *
 * Limits come from https://api.anthropic.com/api/oauth/usage (the endpoint Claude Code's /usage dialog uses),
 * fetched in the background so a render never waits on the network, and only while the status line shows the rows.
 * The endpoint is rate-limited per account, so all pi sessions share one answer through CACHE_FILE: whichever
 * session takes the lock asks, at most every USAGE_TTL_MS, and the others read the file. The OAuth access token is
 * read from pi's auth.json (falling back to Claude Code's credentials), never written to the cache, and never
 * refreshed here: rotating it would invalidate the refresh token behind the owning app's back. When neither is valid,
 * Claude Code is asked to renew its own (renewClaudeLogin below), as it runs out after hours without a prompt.
 *
 * The rows reach statusline.ts through the event bus ("statusline:section"); without it this file does nothing.
 * Other extensions read the answer through the event bus as well: "claude-usage:source" carries a ClaudeUsageSource,
 * at load and on every "claude-usage:source-request", and "claude-usage:changed" follows every new state.
 * claude-remote-control.ts hands the limits to the Claude app that way.
 */

import { type ExtensionAPI, getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const SECTION_ID = "claude-usage";
const POLL_MS = 10_000;
const USAGE_TTL_MS = 120_000;
const USAGE_STALE_MS = 600_000;
const USAGE_MAX_AGE_MS = 3_600_000;
const LOCK_STALE_MS = 30_000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
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
}

/** What "claude-usage:source" carries. */
export interface ClaudeUsageSource {
	/** The latest answer younger than USAGE_MAX_AGE_MS, or null. */
	snapshot(): UsageSnapshot | null;
	/** Asks the endpoint unless the shared answer is younger than USAGE_TTL_MS; settles once that is done. */
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

const pad2 = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** "21:29" today, "Fr 24.10. 19:59" later; plus "3h 2m" left. */
function fmtReset(iso: string): { at: string; left: string } | null {
	const target = new Date(iso);
	if (Number.isNaN(target.getTime())) return null;
	const now = new Date();
	const diff = target.getTime() - now.getTime();
	if (diff <= 0) return { at: "now", left: "" };

	const at =
		target.toDateString() === now.toDateString()
			? hhmm(target)
			: `${target.toLocaleDateString(undefined, { weekday: "short" })} ${pad2(target.getDate())}.${pad2(target.getMonth() + 1)}. ${hhmm(target)}`;

	const d = Math.floor(diff / 86_400_000);
	const h = Math.floor((diff % 86_400_000) / 3_600_000);
	const m = Math.floor((diff % 3_600_000) / 60_000);
	const left = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
	return { at, left };
}

function fmtMoney(minor: number, places: number, currency: string): string {
	const sym = ({ EUR: "€", USD: "$", GBP: "£" } as Record<string, string>)[currency] ?? `${currency} `;
	return `${sym}${(minor / 10 ** places).toFixed(places)}`;
}

/** Valid (non-expired) OAuth access token: pi's own login first, then Claude Code's. */
async function readAccessToken(): Promise<string | null> {
	const now = Date.now();
	try {
		const pi = JSON.parse(await readFile(path.join(os.homedir(), ".pi/agent/auth.json"), "utf8"));
		const a = pi?.anthropic;
		if (a?.type === "oauth" && a.access && (!a.expires || a.expires > now)) return a.access;
		if (a?.access && (!a.expires || a.expires > now)) return a.access;
	} catch {}
	try {
		const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
		const cc = JSON.parse(await readFile(path.join(dir, ".credentials.json"), "utf8"));
		const o = cc?.claudeAiOauth;
		if (o?.accessToken && (!o.expiresAt || o.expiresAt > now)) return o.accessToken;
	} catch {}
	return null;
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

async function fetchUsage(): Promise<{ snapshot: UsageSnapshot } | { error: string }> {
	let token = await readAccessToken();
	if (!token && (await renewClaudeLogin())) token = await readAccessToken();
	if (!token) return { error: "no valid OAuth token" };
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
 *
 * claude-remote-control.ts carries a copy of this block, or of a part of it: change them alike.
 */
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

function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/** Whether Claude Code's access token is valid for at least another minute. */
async function claudeCodeLoginValid(): Promise<boolean> {
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

	const changed = () => {
		pi.events.emit("statusline:changed", undefined);
		pi.events.emit("claude-usage:changed", undefined);
	};

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
			if (adopt(await readState())) changed();
			if (Date.now() - (state?.attemptAt ?? 0) < USAGE_TTL_MS) return;

			lock = await acquireLock();
			if (lock === "busy") return; // the other session's answer arrives through the cache
			if (lock === "acquired") {
				// Another session may have finished between the read above and the lock
				if (adopt(await readState())) changed();
				if (Date.now() - (state?.attemptAt ?? 0) < USAGE_TTL_MS) return;
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
			const result = await fetchUsage();
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

		const sep = separator(theme);
		const lines: string[] = [];
		const snap = state?.snapshot;
		const usage = snap && Date.now() - snap.fetchedAt < USAGE_MAX_AGE_MS ? snap : null;
		if (!usage) {
			// Say why the rows are missing instead of leaving them out
			const head = "Limits".padEnd(LABEL_WIDTH) + " ";
			if (state?.error) {
				const next = hhmm(new Date(Math.max(Date.now(), state.attemptAt + USAGE_TTL_MS)));
				lines.push(head + theme.fg("warning", `⚠ ${state.error}`) + theme.fg("dim", ` · next try ${next}`));
			} else {
				lines.push(head + theme.fg("dim", "loading…"));
			}
			return lines;
		}

		const stale =
			Date.now() - usage.fetchedAt > USAGE_STALE_MS ? theme.fg("dim", ` · as of ${hhmm(new Date(usage.fetchedAt))}`) : "";

		for (const row of usage.limits) {
			let line = meter(theme, row.label, row.percent);
			const r = row.resetsAt ? fmtReset(row.resetsAt) : null;
			if (r) {
				line += sep + `⏰ Resets ${theme.fg("accent", r.at)}`;
				if (r.left) line += ` (in ${theme.fg("warning", r.left)})`;
			}
			lines.push(line + stale);
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
}
