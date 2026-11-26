/**
 * Claude usage: the Claude subscription limits as rows of the status line (statusline.ts), as Claude Code's /usage
 * dialog shows them.
 *
 * Rows: the 5h session, the 7d week, and model-scoped weekly windows such as Fable, each with its local reset time,
 * and the usage credits while they are enabled or anything was spent. Without a usable answer, a single "Limits" row
 * says why (loading, rate limited, no token, …). Without Pi's Anthropic login on a Claude subscription there are no
 * rows and no requests at all, so a user of another provider, or of an Anthropic API key (which has no plan limits),
 * sees nothing of this. While the session's model is not a Claude model (or it has none), the rows are hidden as well;
 * the limits are still fetched, so they stand there as soon as a Claude model is chosen again. With PI_OFFLINE set,
 * the rows show what another session fetched last, and this one fetches nothing.
 *
 * Times, dates, and amounts follow the locale of LC_TIME and LC_MONETARY (or LC_ALL, else LANG), as other programs
 * on the machine do; Node's own Intl default reads LANG alone.
 *
 * Limits come from https://api.anthropic.com/api/oauth/usage (the endpoint Claude Code's /usage dialog uses),
 * fetched in the background so a render never waits on the network, and only while the status line shows the rows.
 * The endpoint is rate-limited per account, so all pi sessions share one answer through CACHE_FILE: whichever
 * session takes the lock asks, at most every USAGE_TTL_MS, and the others read the file. The OAuth access token is
 * Pi's own Anthropic login (/login, Anthropic, Claude subscription), the one the claude-bridge provider
 * (pi-claude-agent-sdk) runs on, as ctx.modelRegistry.getProviderAuth("anthropic") hands it out: Pi renews a token
 * that ran out before it does. Without a usable login the Limits row names /login. The token is never written to the
 * cache and never refreshed here.
 *
 * Between the fetches, every response of the claude-bridge and anthropic providers updates the 5h and 7d windows from
 * its anthropic-ratelimit-unified-* headers (after_provider_response; pi-claude-agent-sdk rebuilds them from Claude
 * Code's rate-limit events), and the shared answer with them, so the rows follow each response. The fetches stay for
 * the start, for idle times, and for what the headers lack: the model-scoped windows and the usage credits.
 *
 * The rows reach statusline.ts through the event bus ("statusline:section"); without it this file does nothing.
 * Other extensions read the answer through the event bus as well, in a protocol that does not depend on the provider:
 * "plan-usage:source" carries a PlanUsageSource (id "claude", for the Claude models) at load and on every
 * "plan-usage:source-request", and "plan-usage:changed" with { id: "claude" } follows every new state.
 * claude-remote-control.ts hands the limits to the Claude app that way.
 */

import { type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SECTION_ID = "claude-usage";
const POLL_MS = 10_000;
const USAGE_TTL_MS = 300_000;
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
	/**
	 * The plan's own answer, for consumers that speak its format: here the endpoint's windows, limit rows and extra usage
	 * as it sent them (ANSWER_KEYS).
	 */
	answer: Record<string, unknown>;
}

/**
 * What "plan-usage:source" carries: the limits of one subscription plan, in a form that does not depend on its
 * provider. A source for another plan (a ChatGPT plan, for one) joins the same way.
 */
export interface PlanUsageSource {
	/** The plan's id, "claude" here; "plan-usage:changed" names it. */
	id: string;
	/** Whether the plan's limits apply to a model, so a consumer picks the source of the model in use. */
	appliesTo(model: { provider: string; id: string } | undefined): boolean;
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

/** What the login lookup needs of ctx.modelRegistry. */
type AuthRegistry = Pick<ExtensionContext["modelRegistry"], "getProviderAuth">;

/**
 * Pi's Anthropic login: the OAuth access token, or why there is none: "none" without a login, "api-key" for an
 * Anthropic API key (no claude.ai login, no plan limits), "failed" when Pi could not hand the token out (its renewal
 * failed, for one).
 */
type AnthropicLogin = { token: string } | { reason: "none" | "api-key" | "failed" };

/**
 * Pi's own Anthropic login (/login, Anthropic, Claude subscription), the one the claude-bridge provider runs on, as
 * getProviderAuth("anthropic") resolves it: Pi renews a stored OAuth token that runs out before it hands it over, so
 * the token is valid, and it is never refreshed here. The token is never printed and never written anywhere.
 * claude-remote-control.ts carries a copy of this function: change them alike.
 */
async function anthropicLogin(registry: AuthRegistry | null | undefined): Promise<AnthropicLogin> {
	if (!registry) return { reason: "none" };
	let resolved: Awaited<ReturnType<AuthRegistry["getProviderAuth"]>>;
	try {
		resolved = await registry.getProviderAuth("anthropic");
	} catch {
		return { reason: "failed" };
	}
	if (!resolved) return { reason: "none" };
	if (!resolved.source?.toLowerCase().includes("oauth")) return { reason: "api-key" };
	const authorization = Object.entries(resolved.auth.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
	const token = resolved.auth.apiKey || (typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i)?.[1] : undefined);
	return token ? { token } : { reason: "failed" };
}

/**
 * Whether a model is Claude: one of the providers that only carry Claude models, or "claude" in the id elsewhere.
 * claude-remote-control.ts carries a copy of this function: change them alike.
 */
function isClaudeModel(model: { provider: string; id: string } | undefined): boolean {
	if (!model) return false;
	return model.provider === "claude-bridge" || model.provider === "anthropic" || /claude/i.test(model.id);
}

/** How long the answer whether there is a login at all is kept, so the credentials are not read at every poll. */
const LOGIN_CHECK_MS = 60_000;

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

/** A plan window from the anthropic-ratelimit-unified-* headers: its row and its key in the endpoint's answer. */
interface HeaderWindow {
	label: "5h" | "7d";
	key: "five_hour" | "seven_day";
	kind: "session" | "weekly_all";
	percent: number;
	/** ISO 8601, or null when the headers name no reset. */
	resetsAt: string | null;
}

const HEADER_WINDOWS = [
	{ abbreviation: "5h", label: "5h", key: "five_hour", kind: "session" },
	{ abbreviation: "7d", label: "7d", key: "seven_day", kind: "weekly_all" },
] as const;

/**
 * The 5h and 7d windows the anthropic-ratelimit-unified-* headers of a response name, as the Anthropic API sends them
 * and pi-claude-agent-sdk rebuilds them: utilization as a fraction, the reset in epoch seconds.
 */
function headerWindows(raw: Record<string, string> | undefined): HeaderWindow[] {
	if (!raw) return [];
	const h = new Map(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), String(v)]));
	const windows: HeaderWindow[] = [];
	for (const w of HEADER_WINDOWS) {
		const utilization = h.get(`anthropic-ratelimit-unified-${w.abbreviation}-utilization`);
		const fraction = utilization === undefined || utilization.trim() === "" ? Number.NaN : Number(utilization);
		if (!Number.isFinite(fraction)) continue;
		const reset = Number(h.get(`anthropic-ratelimit-unified-${w.abbreviation}-reset`));
		windows.push({
			label: w.label,
			key: w.key,
			kind: w.kind,
			percent: Math.round(fraction * 10_000) / 100,
			resetsAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
		});
	}
	return windows;
}

/** Whether two resets name the same instant, to the second; null is no reset. */
function sameReset(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return !a && !b;
	return Math.abs(Date.parse(a) - Date.parse(b)) < 1_000;
}

/**
 * The snapshot with the windows of a response's headers in it: the status line's rows and the endpoint's answer (its
 * window and its limit row, the use 0-100 and the reset as ISO 8601, as the endpoint sends them); the rest stays as
 * the last fetch left it. Null when the headers change nothing.
 */
function withHeaderWindows(base: UsageSnapshot | null | undefined, windows: HeaderWindow[]): UsageSnapshot | null {
	const limits = (base?.limits ?? []).map((row) => ({ ...row }));
	const answer: Record<string, unknown> = structuredClone(base?.answer ?? {});
	let differs = false;
	for (const w of windows) {
		const row = limits.find((r) => r.label === w.label);
		const resetsAt = w.resetsAt ?? row?.resetsAt ?? null;
		if (!row) {
			// 5h first, 7d after it, the model-scoped rows last, as the endpoint orders them
			limits.splice(w.label === "5h" ? 0 : limits.findIndex((r) => r.label === "5h") + 1, 0, { label: w.label, percent: w.percent, resetsAt });
			differs = true;
		} else if (row.percent !== w.percent || !sameReset(row.resetsAt, resetsAt)) {
			row.percent = w.percent;
			row.resetsAt = resetsAt;
			differs = true;
		}
		const window = answer[w.key];
		answer[w.key] = { ...(window && typeof window === "object" ? window : {}), utilization: w.percent, resets_at: resetsAt };
		if (Array.isArray(answer.limits)) {
			const rows = answer.limits as Record<string, unknown>[];
			const i = rows.findIndex((r) => r?.kind === w.kind);
			if (i >= 0) rows[i] = { ...rows[i], percent: w.percent, resets_at: resetsAt };
			else rows.push({ kind: w.kind, percent: w.percent, resets_at: resetsAt });
		}
	}
	if (!differs) return null;
	return { fetchedAt: Date.now(), limits, credits: base?.credits ?? null, answer };
}

async function fetchUsage(registry: AuthRegistry | null): Promise<{ snapshot: UsageSnapshot } | { error: string }> {
	const login = await anthropicLogin(registry);
	if (!("token" in login)) return { error: login.reason === "failed" ? "no valid login: /login" : "no Claude subscription login: /login" };
	const token = login.token;
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
		const valid = typeof snap?.fetchedAt === "number" && Array.isArray(snap?.limits) && typeof snap?.answer === "object" && snap.answer !== null;
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
	/** Pi's model registry, from the latest event; it resolves Pi's Anthropic login. */
	let registry: AuthRegistry | null = null;
	/** Whether there is a login with plan limits (a usable one or not), kept LOGIN_CHECK_MS. */
	let loginCheck: { at: number; present: boolean } | undefined;

	const useRegistry = (ctx: ExtensionContext) => {
		const current = ctx.modelRegistry;
		if (current === registry) return;
		registry = current;
		loginCheck = undefined;
	};

	/** Whether there is a Claude subscription login in Pi at all, usable or not: an API key and no login are not. */
	async function hasPlanLogin(): Promise<boolean> {
		if (loginCheck && Date.now() - loginCheck.at < LOGIN_CHECK_MS) return loginCheck.present;
		const login = await anthropicLogin(registry);
		const present = "token" in login || login.reason === "failed";
		loginCheck = { at: Date.now(), present };
		return present;
	}

	const changed = () => {
		pi.events.emit("statusline:changed", undefined);
		pi.events.emit("plan-usage:changed", { id: "claude" });
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
			const login = await hasPlanLogin();
			if (login !== loggedIn) {
				loggedIn = login;
				changed();
			}
			if (!login) return;
			if (adopt(await readState())) changed();
			if (process.env.PI_OFFLINE) return;
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
			const result = await fetchUsage(registry);
			await save(
				"snapshot" in result
					? { attemptAt, snapshot: result.snapshot, error: null }
					: // a response's headers may have updated the snapshot meanwhile
						{ attemptAt, snapshot: state?.snapshot ?? previous, error: result.error },
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

	const modelChanged = (model: { provider: string; id: string } | undefined) => {
		const claude = isClaudeModel(model);
		if (claude === claudeModel) return;
		claudeModel = claude;
		pi.events.emit("statusline:changed", undefined);
	};
	// A restored session fires no model_select, so session_start reads the model as well
	pi.on("session_start", (_event, ctx) => {
		useRegistry(ctx);
		modelChanged(ctx.model);
	});
	pi.on("model_select", (event, ctx) => {
		useRegistry(ctx);
		modelChanged(event.model);
	});

	/** The windows of a response's headers into the state and the shared answer. */
	async function applyHeaders(windows: HeaderWindow[]): Promise<void> {
		if (adopt(await readState())) changed();
		const snapshot = withHeaderWindows(state?.snapshot, windows);
		if (!snapshot) return;
		state = { attemptAt: state?.attemptAt ?? 0, updatedAt: Date.now(), snapshot, error: state?.error ?? null };
		try {
			await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
			await writeState(state);
		} catch {
			// this session shows it all the same
		}
		changed();
	}

	// pi-claude-agent-sdk passes Claude Code's rate-limit events on as these headers; the anthropic provider has them
	// from the API itself.
	pi.on("after_provider_response", (event, ctx) => {
		useRegistry(ctx);
		const provider = ctx.model?.provider;
		if (provider !== "claude-bridge" && provider !== "anthropic") return;
		const windows = headerWindows(event.headers);
		if (windows.length > 0) void applyHeaders(windows).catch(() => {});
	});

	const section: StatuslineSection = { id: SECTION_ID, render };
	pi.events.on("statusline:section-request", () => pi.events.emit("statusline:section", section));
	pi.events.emit("statusline:section", section);

	const source: PlanUsageSource = {
		id: "claude",
		appliesTo: isClaudeModel,
		snapshot: () => {
			const snap = state?.snapshot;
			return snap && Date.now() - snap.fetchedAt < USAGE_MAX_AGE_MS ? snap : null;
		},
		refresh: () => refreshUsage(),
	};
	pi.events.on("plan-usage:source-request", () => pi.events.emit("plan-usage:source", source));
	pi.events.emit("plan-usage:source", source);
}
