/**
 * Auto-continue: Claude Code's automatic continue at a usage limit, for any provider. A request that fails because a
 * usage limit, a quota, or a rate limit of the provider is used up does not end the run: the run waits until the limit
 * resets and then continues where it stopped, as Claude Code does with autoContinueAtUsageLimit.
 *
 * - The failed request is taken out of the model's context, as Pi's own retry does, and a note joins the conversation:
 *   when the limit was reached and when it resets, and for the model to continue the task without repeating finished
 *   work. The run goes on at once, and its next request waits until the reset before it goes out. Meanwhile the
 *   working line reads "Usage limit reached · continuing automatically at 19:01 (in 3h 29m) · esc to cancel". Esc ends
 *   the run as ever. While it waits, Pi's spinner is hidden, and the line is drawn again only when its text changes,
 *   once a minute: the spinner would redraw the screen twelve times a second for hours.
 * - The reset comes from what the provider says, the first found of:
 *   - the error text, in its common forms only: a clock time in the time zone it names, else the local one (Claude
 *     Code's "resets 12:50am (Europe/Vienna)" and "resets Nov 21, 7pm (Europe/Vienna)", Codex's "try again at
 *     4:12 PM"); a duration after "try again in", "retry in", "retry after", "reset(s) in/after", "available in"
 *     ("7m54.24s", "~123 min", "86400 seconds", "19h14m47s"); Gemini's "retryDelay"; and Pi's "Server requested 3600s
 *     retry delay", in which Pi passes on a retry-after header that extensions do not see;
 *   - the headers of the refused response, where the provider's transport hands them to extensions (OpenAI Codex; the
 *     Anthropic and OpenAI SDKs throw before): anthropic-ratelimit-unified-reset, retry-after-ms, retry-after, then the
 *     x-ratelimit-reset*, ratelimit-reset, and x-codex-*-reset-at headers, those of a spent window first (remaining 0,
 *     used 100 %);
 *   - the plan's limits, where an extension offers them for the model ("plan-usage:source", claude-usage.ts): the
 *     latest reset among the windows used up to 100 %.
 *   Rarer forms are not read (a day with a UTC time, Z.ai's time without a zone, ISO or epoch times in the body of
 *   the error, Gemini's daily quota): such a limit is tried again at intervals.
 *   A reset named as a clock time is waited for plus a minute (the provider counts in minutes) and up to half a minute
 *   more, so the sessions of one account do not all start at the same second; an exact one plus two seconds and up to
 *   a tenth of the wait, half a minute at most.
 * - While the run waits, the plan's limits are asked again every five minutes: a window shown used up that is free again
 *   lets the run continue early. It continues at once after "claude-login:changed" (/claude-login signed Claude Code
 *   in, with another account if need be).
 * - Without a reset time, a usage limit or quota ("usage limit", "quota", "per day", "exhausted your capacity", …) is
 *   tried again after 2, 5, 10, 15, and 30 minutes, then every hour. A plain rate limit ("rate limit", "too many
 *   requests", 429) is Pi's own retry's first (retry.maxRetries); once Pi gives up on it, it is tried again the same
 *   way, or waited for when it names a reset. Credit and billing errors without a reset time ("insufficient credits",
 *   "payment required", OpenAI's insufficient_quota, "You exceeded your current quota") never reset by themselves and
 *   stand as they are.
 * - A reset more than eight days away, or tries over more than eight days, end the waiting with a notice. A request
 *   that hits the limit again right after a reset waits again, at least two minutes; after three such hits in a row
 *   the named reset is no longer trusted (Gemini names one of seconds for a used-up daily quota), and the run tries
 *   again at intervals as without one.
 * - Whatever starts a run while the limit holds waits the same way after its first failed request: a subagent's
 *   report, a background wait's result, a message from another session, and a scheduled prompt. A
 *   subagent's own Pi process loads this extension as well, so the subagent waits and continues by itself. While a
 *   run waits, messages that arrive are queued as they are during any run, and go to the model when it continues.
 * - In RPC mode, where Pi draws no working line, the wait is a status entry ("auto-continue:wait", without the
 *   countdown, cleared when the run goes on): subagents.ts reads it from a subagent's process and shows the subagent
 *   waiting.
 * - A compaction that fails on a limit (/compact, or Pi's own when the context fills up or overflows) is tried again
 *   once the limit resets, worked out the same way: Pi itself tries a failed one again only before the next request of
 *   a run. The retry waits until Pi is idle, as a compaction ends a running run, and goes as /compact with the
 *   instructions the failed one had; after one that a context overflow started, the run that overflowed continues
 *   with a note. Meanwhile the status line reads "⧗ compaction at 11:41 (in 7m) · esc cancels"; Esc in an empty
 *   editor, a prompt, or another compaction that succeeds ends the wait, and "claude-login:changed" starts the retry
 *   at once. The wait outlasts /reload, not a restart of Pi: a context over the threshold compacts with the next run.
 * - Pi ended during the wait (a signal at reboot, /quit, or a crash): when the session starts or is resumed before the
 *   reset, the wait resumes with a note of its own; once the reset has passed, a notice says to send a prompt. Pi ends
 *   a run before it quits, as Esc does, so a wait ended that way is marked in the session (a custom entry, outside the
 *   model's context) for the next start to tell it from Esc.
 * - While a run waits, "auto-continue:state" carries { waiting: true } on the event bus, and { waiting: false } once it
 *   no longer does; "auto-continue:state-request" asks for it. tmux-tab-activity.ts rests the tab meanwhile, and
 *   claude-login.ts words its notice for a used-up limit for it.
 *
 * The wait happens in the context event of the request that follows the failed one. Handlers of that event run in
 * load order, which is the order of the file names: this file's name sorts before network-resilience.ts, whose
 * request timers start in its own handler, so they do not count the wait.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Key, matchesKey, Text } from "@earendil-works/pi-tui";

const MESSAGE_TYPE = "auto-continue";
const STATE = "auto-continue:state";
const STATE_REQUEST = "auto-continue:state-request";
/** The status line entry of a compaction that waits for a limit to reset. */
const STATUS_KEY = "auto-continue";
/** The status entry of a run that waits, in RPC mode only (subagents.ts reads it). */
const WAIT_STATUS_KEY = "auto-continue:wait";
/** Carries a compaction's wait over /reload to the extension instance that follows. */
const HANDOVER = Symbol.for("auto-continue:compaction");

/** Errors of a used-up limit: plan and usage limits, quotas, and rate limits. */
const LIMIT =
	/hit your [^\n]*?limit|reached your [^\n]*?limit|usage[ _-]?limit|limit (?:reached|exceeded|exhausted)|quota|resource[ _-]?exhausted|exhausted your capacity|rate[ _-]?limit|too many (?:requests|tokens)|(?<![\w.])429(?![\w.])|retry delay|UsageLimitError/i;
/** Credit and billing errors: without a reset time they never reset by themselves. */
const BILLING =
	/insufficient[ _-]?(?:credit|balance|funds|quota)|credit[ _-]?balance|out of (?:usage )?credits|payment required|(?<![\w.])402(?![\w.])|spend(?:ing)?[ _-]?limit|top[ -]?up|recharge|exceeded your current quota|plan and billing details/i;

/** A wall-clock reset: Claude Code's "resets 12:50am (Europe/Vienna)", "resets Nov 21, 7pm (Europe/Vienna)". */
const CLOCK_TEXT =
	/\b(?:resets?|try again|available again)\s+(?:at\s+|on\s+)?(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)\s]+)\))?/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** One part of a duration: "7m", "54.24s", "123 min", "2 days". */
const DURATION_PART = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)(?![a-z])/gi;
const DURATION = String.raw`(?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)(?![a-z])[\s,]*(?:and\s+)?)+`;
/** A duration after the words that announce one: "try again in 7m54.24s", "retry after 86400 seconds". */
const DURATION_TEXT = new RegExp(
	String.raw`\b(?:try(?:ing)? again|retry(?:ing)?|resets?|available(?:\s+again)?|wait)\s+(?:in|after|for)\s+(?:about\s+|approximately\s+|~\s*)?(${DURATION})`,
	"i",
);
/** Pi's own words when a server asks for a longer retry delay than it waits, and Gemini's RetryInfo. */
const DELAY_TEXT = /requested\s+(\d+(?:\.\d+)?)s\s+retry delay|"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i;

/** A reset further out, or tries for longer, end the waiting. */
const MAX_WAIT_MS = 8 * 86_400_000;
/**
 * After a reset: a clock time is waited for plus MINUTE_MARGIN_MS and up to SPREAD_MS; an exact one plus
 * EXACT_MARGIN_MS.
 */
const MINUTE_MARGIN_MS = 60_000;
const EXACT_MARGIN_MS = 2_000;
const SPREAD_MS = 30_000;
/** A request that hits the limit again right after a reset waits at least this long. */
const REPEAT_MS = 2 * 60_000;
/** Limit errors in a row after a reset, the first included, after which the named reset is no longer trusted. */
const MAX_HITS = 3;
/** The tries without a reset time, in minutes after each failed one; the last repeats. */
const PROBE_MINUTES = [2, 5, 10, 15, 30, 60];
/** How often the plan's limits are asked while a run waits; the source keeps its own pace on top. */
const USAGE_ASK_MS = 5 * 60_000;
const TICK_MS = 1000;

/** How the notices of a wait that ends name what waited, and what to do instead. */
interface Words {
	subject: string;
	action: string;
}
const RUN_WORDS: Words = { subject: "the run", action: "send a prompt" };
const COMPACTION_WORDS: Words = { subject: "the compaction", action: "run /compact" };

const NOTE = "Continue the task you were working on when the limit was reached; do not repeat work that is already complete.";

/**
 * The locale of LC_TIME as LC_ALL, LC_TIME, or LANG name it (de_AT.UTF-8 is de-AT), or undefined for C, POSIX, an
 * unknown one, or none. claude-usage.ts carries a copy of this function: change them alike.
 */
function posixLocale(category: "LC_TIME"): string | undefined {
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

/** "19:00" today, "Fr., 21.11., 19:00" on another day, in the locale. */
function when(at: number): string {
	const target = new Date(at);
	return target.toDateString() === new Date().toDateString()
		? target.toLocaleTimeString(TIME_LOCALE, { hour: "2-digit", minute: "2-digit" })
		: target.toLocaleString(TIME_LOCALE, { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** "3h 29m", "2d 4h 10m", "42s". */
function left(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000));
	if (s < 60) return `${s}s`;
	const d = Math.floor(s / 86_400);
	const h = Math.floor((s % 86_400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function validZone(zone: string | undefined): string | undefined {
	if (!zone) return undefined;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return zone;
	} catch {
		return undefined;
	}
}

/** The calendar fields of an instant in a time zone. */
function fields(at: number, zone: string | undefined): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(new Date(at));
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
	return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** The instant a wall-clock time in a time zone stands for; Date.UTC carries a day or month past its end over. */
function zoned(year: number, month: number, day: number, hour: number, minute: number, zone: string | undefined): number {
	const wall = Date.UTC(year, month, day, hour, minute);
	const offset = (at: number) => {
		const f = fields(at, zone);
		return Date.UTC(f.year, f.month, f.day, f.hour, f.minute, f.second) - Math.floor(at / 1000) * 1000;
	};
	const guess = wall - offset(wall);
	return wall - offset(guess);
}

/** When a limit resets, and whether the provider named it to the minute (a clock time) or exactly. */
interface Reset {
	at: number;
	minute: boolean;
}

/** A wall-clock reset in the error, in the time zone it names (else the local one), as an instant after `at`. */
function clockReset(text: string, at: number): number | undefined {
	const m = CLOCK_TEXT.exec(text);
	if (!m) return undefined;
	const zone = validZone(m[6]);
	const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === "pm" ? 12 : 0);
	const minute = m[4] ? Number(m[4]) : 0;
	if (hour > 23 || minute > 59) return undefined;
	const now = fields(at, zone);
	if (m[1]) {
		const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
		const day = Number(m[2]);
		let reset = zoned(now.year, month, day, hour, minute, zone);
		// A reset in January named in December.
		if (reset < at - 86_400_000) reset = zoned(now.year + 1, month, day, hour, minute, zone);
		return reset;
	}
	const today = zoned(now.year, now.month, now.day, hour, minute, zone);
	return today > at - 60_000 ? today : zoned(now.year, now.month, now.day + 1, hour, minute, zone);
}

/** A duration in milliseconds: "7m54.24s", "~123 min", "2 days 3 hours", "20ms", "86400 seconds". */
function duration(text: string): number | undefined {
	let total = 0;
	let found = false;
	for (const m of text.matchAll(DURATION_PART)) {
		const unit = m[2].toLowerCase();
		const factor =
			unit === "ms" || unit.startsWith("milli")
				? 1
				: unit.startsWith("s")
					? 1000
					: unit.startsWith("m")
						? 60_000
						: unit.startsWith("h")
							? 3_600_000
							: 86_400_000;
		total += Number(m[1]) * factor;
		found = true;
	}
	return found && Number.isFinite(total) ? total : undefined;
}

/** An epoch time in milliseconds or seconds, or a delay in seconds, as an instant. */
function epochOrDelay(value: number, at: number): number {
	if (value > 1e12) return value;
	if (value > 1e9) return value * 1000;
	return at + value * 1000;
}

/** The reset the error text names, as an instant. */
function textReset(text: string, at: number): Reset | undefined {
	const clock = clockReset(text, at);
	if (clock !== undefined) return { at: clock, minute: true };
	const delay = DELAY_TEXT.exec(text);
	const seconds = delay ? Number(delay[1] ?? delay[2]) : Number.NaN;
	if (Number.isFinite(seconds)) return { at: at + seconds * 1000, minute: false };
	const spoken = DURATION_TEXT.exec(text);
	const ms = spoken ? duration(spoken[1]) : undefined;
	if (ms !== undefined) return { at: at + ms, minute: /min|h|d/i.test(spoken![1]) && !/\d\s*s(?![a-z])|sec/i.test(spoken![1]) };
	return undefined;
}

/** A header value as an instant: a duration ("6m0s"), a number (seconds, or an epoch time), or a date. */
function headerTime(value: string, at: number, bareIsDelay: boolean): number | undefined {
	const v = value.trim();
	if (/^\d+(?:\.\d+)?$/.test(v)) {
		const n = Number(v);
		return bareIsDelay ? at + n * 1000 : epochOrDelay(n, at);
	}
	const ms = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/i.test(v) ? duration(v) : undefined;
	if (ms !== undefined) return at + ms;
	const date = Date.parse(v);
	return Number.isFinite(date) ? date : undefined;
}

/** The reset the headers of a refused response name. */
function headerReset(raw: Record<string, string> | undefined, at: number): Reset | undefined {
	if (!raw) return undefined;
	const h = new Map(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), String(v)]));
	// Anthropic's subscription limits: the reset of the window that refused, in epoch seconds.
	const unified = h.get("anthropic-ratelimit-unified-reset");
	const unifiedAt = unified ? headerTime(unified, at, false) : undefined;
	if (unifiedAt !== undefined) return { at: unifiedAt, minute: false };
	const ms = Number(h.get("retry-after-ms"));
	if (Number.isFinite(ms) && h.has("retry-after-ms")) return { at: at + ms, minute: false };
	const after = h.get("retry-after");
	if (after) {
		const seconds = Number(after);
		const instant = Number.isFinite(seconds) ? at + seconds * 1000 : Date.parse(after);
		if (Number.isFinite(instant)) return { at: instant, minute: false };
	}
	// Reset headers per counted resource: x-ratelimit-reset-tokens, anthropic-ratelimit-requests-reset,
	// ratelimit-reset.
	const resets: { at: number; spent: boolean }[] = [];
	for (const [key, value] of h) {
		const m = /^(x-ratelimit-reset|ratelimit-reset|anthropic-ratelimit-(.+)-reset)(-.+)?$/.exec(key);
		if (!m) continue;
		const bareIsDelay = key !== "x-ratelimit-reset";
		const instant = headerTime(value, at, bareIsDelay);
		if (instant === undefined) continue;
		const remaining = m[2] ? h.get(`anthropic-ratelimit-${m[2]}-remaining`) : h.get(key.replace("reset", "remaining"));
		resets.push({ at: instant, spent: remaining !== undefined && Number(remaining) <= 0 });
	}
	// Codex's windows: x-codex-primary-reset-at (epoch seconds), spent at x-codex-primary-used-percent 100.
	for (const [key, value] of h) {
		const m = /^x-codex-([a-z]+)-reset-(at|after-seconds)$/.exec(key);
		if (!m) continue;
		const instant = headerTime(value, at, m[2] === "after-seconds");
		if (instant === undefined) continue;
		const used = Number(h.get(`x-codex-${m[1]}-used-percent`));
		resets.push({ at: instant, spent: Number.isFinite(used) && used >= 100 });
	}
	const spent = resets.filter((r) => r.spent);
	const pick = spent.length > 0 ? spent : resets;
	return pick.length > 0 ? { at: Math.max(...pick.map((r) => r.at)), minute: false } : undefined;
}

// A copy of the "plan-usage:source" contract of claude-usage.ts, the part read here: change both alike.
interface LimitRow {
	label: string;
	percent: number;
	resetsAt: string | null;
}
interface UsageSnapshot {
	fetchedAt: number;
	limits: LimitRow[];
}
interface PlanUsageSource {
	id: string;
	appliesTo(model: { provider: string; id: string } | undefined): boolean;
	snapshot(): UsageSnapshot | null;
	refresh(): Promise<void>;
}

/** What the note of a wait carries. */
interface NoteDetails {
	/** When the limit was reached, and the error. */
	hitAt: number;
	error: string;
	/** The reset the run waits for; without it, the run tries again at intervals. */
	resetAt?: number;
	/** When the first request of this limit failed, for the eight days of tries. */
	firstAt?: number;
	/** Set on the note of a wait resumed after Pi started again. */
	restarted?: boolean;
	/** Set on the note of a run that continues once a compaction its overflow started went through after the reset. */
	compacted?: boolean;
}

/** The custom entry that marks a wait as ended by Pi quitting, not by Esc. */
interface QuitMark {
	quit: true;
}

/** A wait the next request of the run is to make. */
interface Wait {
	hitAt: number;
	/** The reset, or undefined while the run tries again at intervals. */
	resetAt?: number;
	minute: boolean;
	/** The request goes out no earlier than this. */
	notBefore: number;
	spread: number;
	/** The limit was hit again right after a wait. */
	again: boolean;
	/** A fresh answer of the plan's limits showed a window used up. */
	sawUsedUp: boolean;
}

/** A failed request or compaction: the error, when it came, and the headers of the refused response if any. */
interface Hit {
	text: string;
	at: number;
	headers?: Record<string, string>;
}

/** The limit hits of one kind (runs, compactions) so far. */
interface Tries {
	/** Hits in a row after a reset: the first, and each right after a wait. */
	hits: number;
	/** Tries without a reset time, and when the first of them failed. */
	probes: number;
	firstAt: number;
}

/** A compaction that failed on a limit, to try again once it resets. */
interface CompactionWait extends Wait {
	reason: "manual" | "threshold" | "overflow";
	/** The instructions of a /compact. */
	instructions?: string;
	error: string;
}

/** What a compaction's wait hands over through /reload. */
interface Handover {
	file: string;
	wait: CompactionWait;
	tries: Tries;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

function noteText(d: NoteDetails): string {
	const during = d.compacted ? " while the context was compacted" : "";
	const reached = `The usage limit was reached at ${new Date(d.hitAt).toISOString()}${during} (${d.error.trim()})`;
	const reset = d.resetAt === undefined ? "; the provider named no reset time, so the run tried again at intervals." : `; it resets at ${new Date(d.resetAt).toISOString()}.`;
	const waited = d.resetAt === undefined ? "The limit no longer refused the request" : "The run waited for the reset";
	if (d.compacted) return `${reached}${reset} The context was compacted after the reset, and the run continues now. ${NOTE}`;
	return d.restarted
		? `${reached}${reset} Pi was restarted while this run waited. ${waited}, and the run continues now. ${NOTE}`
		: `${reached}${reset} ${waited}, and the run continues now. ${NOTE}`;
}

export default function (pi: ExtensionAPI) {
	const sources = new Map<string, PlanUsageSource>();
	/** The headers of the run's last refused response, where the transport hands them over. */
	let refused: { status: number; headers: Record<string, string> } | undefined;
	/** The limit error of the run's last request, until agent_before_settle takes it. */
	let lastLimit: { text: string; at: number; headers?: Record<string, string> } | undefined;
	/** A request a wait let go failed on the limit again. */
	let hitAgain = false;
	/** The limit hits of the session's runs. */
	const runTries: Tries = { hits: 0, probes: 0, firstAt: 0 };
	/** Set when a wait let its request go, until that request ends. */
	let released = false;
	/** The wait the run's next request makes. */
	let armed: Wait | undefined;
	let waiting = false;
	/** When a wait last ended because its run was aborted. */
	let abortedAt = 0;
	/** When Claude Code was last signed in anew. */
	let loginChangedAt = 0;
	let ctxRef: ExtensionContext | undefined;
	/** The compaction that waits for its limit to reset, and the limit hits of compactions. */
	let compaction: CompactionWait | undefined;
	const compactionTries: Tries = { hits: 0, probes: 0, firstAt: 0 };
	/** The compaction this extension started, until it ends. */
	let retrying: CompactionWait | undefined;
	/** The instructions of the latest /compact. */
	let instructions: string | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	/** When the plan's limits were last asked for the compaction's wait, and the status line shown for it. */
	let compactionAsked = 0;
	let compactionShown: string | undefined;
	let unsubscribeInput: (() => void) | undefined;

	const emitState = () => pi.events.emit(STATE, { waiting });
	const setWaiting = (value: boolean) => {
		if (waiting === value) return;
		waiting = value;
		emitState();
	};

	function source(model: ExtensionContext["model"]): PlanUsageSource | undefined {
		for (const s of sources.values()) {
			try {
				if (s.appliesTo(model)) return s;
			} catch {
				// A source that throws is passed over.
			}
		}
		return undefined;
	}

	/** The plan's limits as answered after `since`: whether a window is used up, and the latest reset among those. */
	function usage(model: ExtensionContext["model"], since: number): { usedUp: boolean; resetAt?: number } | undefined {
		const snap = source(model)?.snapshot();
		if (!snap || snap.fetchedAt <= since || !Array.isArray(snap.limits)) return undefined;
		const used = snap.limits.filter((row) => typeof row?.percent === "number" && row.percent >= 100);
		const resets = used.map((row) => (row.resetsAt ? Date.parse(row.resetsAt) : Number.NaN)).filter(Number.isFinite);
		return { usedUp: used.length > 0, ...(resets.length > 0 ? { resetAt: Math.max(...resets) } : {}) };
	}

	/** When the request may go: the reset with its margin, or the next try. */
	const dueOf = (wait: Wait) =>
		wait.resetAt === undefined
			? wait.notBefore
			: Math.max(wait.resetAt + (wait.minute ? MINUTE_MARGIN_MS : EXACT_MARGIN_MS) + wait.spread, wait.notBefore);

	/**
	 * The wait for a limit `hit`, counted in `tries` (`again`: right after a wait); undefined when the error stands, a
	 * billing error without a reset time, or a reset or tries more than eight days away, which a notice names.
	 */
	function waitFor(ctx: ExtensionContext, hit: Hit, tries: Tries, again: boolean, words: Words): Wait | undefined {
		let found = textReset(hit.text, hit.at) ?? headerReset(hit.headers, hit.at);
		if (!found) {
			const plan = usage(ctx.model, 0);
			if (plan?.usedUp && plan.resetAt !== undefined) found = { at: plan.resetAt, minute: true };
		}
		if (found && found.at - hit.at > MAX_WAIT_MS) {
			notify(ctx, `The limit resets at ${when(found.at)}, more than eight days away, so ${words.subject} does not wait: ${words.action} then.`, "warning");
			return undefined;
		}
		if (!found && BILLING.test(hit.text)) return undefined;
		if (found) tries.hits = again ? tries.hits + 1 : 1;
		if (found && tries.hits < MAX_HITS) {
			tries.probes = 0;
			const span = Math.max(0, found.at - hit.at);
			return {
				hitAt: hit.at,
				resetAt: found.at,
				minute: found.minute,
				notBefore: tries.hits > 1 ? hit.at + REPEAT_MS : 0,
				spread: Math.random() * (found.minute ? SPREAD_MS : Math.min(SPREAD_MS, span / 10)),
				again: tries.hits > 1,
				sawUsedUp: false,
			};
		}
		// No reset time, or the named one did not hold three times in a row: try again at intervals.
		if (tries.probes === 0) tries.firstAt = hit.at;
		if (hit.at - tries.firstAt > MAX_WAIT_MS) {
			notify(ctx, `The limit still refuses requests after eight days of tries: ${words.action} to continue.`, "warning");
			return undefined;
		}
		const minutes = PROBE_MINUTES[Math.min(tries.probes, PROBE_MINUTES.length - 1)];
		tries.probes++;
		return { hitAt: hit.at, minute: false, notBefore: hit.at + minutes * 60_000, spread: 0, again: tries.probes > 1, sawUsedUp: false };
	}

	/** Holds the request until the limit has reset; false when the run was aborted meanwhile. */
	async function hold(ctx: ExtensionContext, wait: Wait): Promise<boolean> {
		const signal = ctx.signal;
		const ui = ctx.hasUI ? ctx.ui : undefined;
		const lead = wait.again ? "Usage limit reached again" : "Usage limit reached";
		let asked = 0;
		let shown: string | undefined;
		// RPC mode has no working line (Pi ignores setWorkingMessage there): a status entry tells the client.
		const relay = ctx.mode === "rpc" ? ui : undefined;
		let relayed: string | undefined;
		setWaiting(true);
		// No frames: the working line shows the message alone, and nothing redraws it.
		ui?.setWorkingIndicator({ frames: [] });
		try {
			while (!signal?.aborted) {
				const now = Date.now();
				if (loginChangedAt > wait.hitAt) return true;
				const plan = source(ctx.model);
				if (plan && now - asked >= USAGE_ASK_MS) {
					asked = now;
					plan.refresh().catch(() => {});
				}
				const answer = usage(ctx.model, wait.hitAt);
				if (answer?.usedUp) {
					wait.sawUsedUp = true;
					if (answer.resetAt !== undefined) {
						wait.resetAt = answer.resetAt;
						wait.minute = true;
					}
				} else if (answer && wait.sawUsedUp && now >= wait.notBefore) {
					// The window the limit was reached in is free again before its reset.
					return true;
				}
				const due = dueOf(wait);
				if (now >= due) return true;
				const next = wait.resetAt === undefined ? `no reset time named · trying again at ${when(due)}` : `continuing automatically at ${when(due)}`;
				const text = `${lead} · ${next} (in ${left(due - now)}) · esc to cancel`;
				if (text !== shown) ui?.setWorkingMessage((shown = text));
				if (relay && `${lead} · ${next}` !== relayed) relay.setStatus(WAIT_STATUS_KEY, (relayed = `${lead} · ${next}`));
				await sleep(Math.min(TICK_MS, due - now), signal);
			}
			abortedAt = Date.now();
			return false;
		} finally {
			ui?.setWorkingMessage();
			ui?.setWorkingIndicator();
			if (relayed) relay?.setStatus(WAIT_STATUS_KEY, undefined);
			setWaiting(false);
		}
	}

	/**
	 * The note of the session's last wait, while that wait was still on when Pi ended: no answer of the model followed
	 * it, no Esc ended it (an aborted run counts as Esc unless the mark of a quit follows), and no failed request ended
	 * the run after it (the error stood, and the run ended with it).
	 */
	function pendingNote(ctx: ExtensionContext): NoteDetails | undefined {
		let note: NoteDetails | undefined;
		let ended = false;
		for (const entry of ctx.sessionManager.getBranch() as any[]) {
			if (entry?.type === "custom_message" && entry.customType === MESSAGE_TYPE) {
				const d = entry.details as NoteDetails | undefined;
				note = d && typeof d.hitAt === "number" && !d.compacted ? d : undefined;
				ended = false;
			} else if (note && entry?.type === "custom" && entry.customType === MESSAGE_TYPE && (entry.data as QuitMark | undefined)?.quit) {
				ended = false;
			} else if (note && entry?.type === "message" && entry.message?.role === "assistant") {
				if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error") ended = true;
				else note = undefined;
			}
		}
		return note && !ended ? note : undefined;
	}

	function notify(ctx: ExtensionContext, text: string, type: "info" | "warning") {
		if (ctx.hasUI) ctx.ui.notify(text, type);
	}

	/** Ends the compaction's wait and clears its status line entry. */
	function stopCompactionWait(ctx = ctxRef) {
		compaction = undefined;
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		compactionShown = undefined;
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function showCompaction(ctx: ExtensionContext, text: string) {
		if (text !== compactionShown && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, (compactionShown = text));
	}

	function armCompaction(ctx: ExtensionContext, wait: CompactionWait) {
		compaction = wait;
		compactionAsked = 0;
		if (!ticker) {
			ticker = setInterval(tickCompaction, TICK_MS);
			ticker.unref?.();
		}
		tickCompaction();
	}

	/** Once a second while a compaction waits: its status line, and the retry once the limit reset and Pi is idle. */
	function tickCompaction() {
		const wait = compaction;
		const ctx = ctxRef;
		if (!wait || !ctx) return;
		const now = Date.now();
		let free = loginChangedAt > wait.hitAt;
		const plan = source(ctx.model);
		if (plan && now - compactionAsked >= USAGE_ASK_MS) {
			compactionAsked = now;
			plan.refresh().catch(() => {});
		}
		const answer = usage(ctx.model, wait.hitAt);
		if (answer?.usedUp) {
			wait.sawUsedUp = true;
			if (answer.resetAt !== undefined) {
				wait.resetAt = answer.resetAt;
				wait.minute = true;
			}
		} else if (answer && wait.sawUsedUp && now >= wait.notBefore) {
			// The window the limit was reached in is free again before its reset.
			free = true;
		}
		const due = dueOf(wait);
		if (!free && now < due) {
			showCompaction(ctx, `⧗ compaction at ${when(due)} (in ${left(due - now)}) · esc cancels`);
			return;
		}
		// A compaction ends a running run, so the retry waits for Pi to be idle.
		if (!ctx.isIdle()) {
			showCompaction(ctx, "⧗ compaction once Pi is idle · esc cancels");
			return;
		}
		stopCompactionWait(ctx);
		retrying = wait;
		ctx.compact({
			customInstructions: wait.instructions,
			onComplete: () => {
				retrying = undefined;
				if (wait.reason === "overflow") continueAfterCompaction(wait);
			},
			// session_compact_failed takes the failure.
			onError: () => {},
		});
	}

	/** The run that overflowed continues once the compaction went through. */
	function continueAfterCompaction(wait: CompactionWait) {
		const details: NoteDetails = { hitAt: wait.hitAt, error: wait.error, resetAt: wait.resetAt, compacted: true };
		try {
			pi.sendMessage({ customType: MESSAGE_TYPE, content: noteText(details), display: true, details }, { triggerTurn: true });
		} catch {
			// The session was replaced meanwhile.
		}
	}

	pi.registerMessageRenderer<NoteDetails>(MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const d = message.details;
		const head = d ? (d.restarted ? "Pi restarted during the wait for the usage limit" : `Usage limit reached at ${when(d.hitAt)}`) : "Usage limit reached";
		const line = d?.compacted
			? `Usage limit reached at ${when(d.hitAt)} during a compaction · compacted after the reset · the run continues`
			: d?.resetAt !== undefined
				? `${head} · resets ${when(d.resetAt)} · the run continues after the reset`
				: `${head} · no reset time named · the run tries again at intervals`;
		const box = new Box(outputPad, 0, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg("dim", `› ${line}`), 0, 0));
		return box;
	});

	pi.events.on("plan-usage:source", (data) => {
		const offered = data as PlanUsageSource | undefined;
		if (typeof offered?.id === "string" && typeof offered.snapshot === "function" && typeof offered.appliesTo === "function") {
			sources.set(offered.id, offered);
		}
	});
	pi.events.on("claude-login:changed", () => {
		loginChangedAt = Date.now();
	});
	pi.events.on(STATE_REQUEST, emitState);

	const reset = () => {
		armed = undefined;
		lastLimit = undefined;
		refused = undefined;
		hitAgain = false;
		runTries.hits = 0;
		runTries.probes = 0;
		released = false;
	};

	pi.on("session_start", (event, ctx) => {
		ctxRef = ctx;
		reset();
		setWaiting(false);
		emitState();
		pi.events.emit("plan-usage:source-request", undefined);
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		if (ctx.mode === "tui") {
			unsubscribeInput = ctx.ui.onTerminalInput((data) => {
				if (!compaction || !matchesKey(data, Key.escape)) return undefined;
				if (!ctx.isIdle() || ctx.ui.getEditorText().trim()) return undefined;
				stopCompactionWait(ctx);
				notify(ctx, "The compaction no longer waits for the usage limit to reset: /compact tries it again.", "info");
				return { consume: true };
			});
		}
		const store = globalThis as { [HANDOVER]?: Handover };
		const handed = store[HANDOVER];
		delete store[HANDOVER];
		if (event.reason === "reload" && handed && handed.file === ctx.sessionManager.getSessionFile()) {
			Object.assign(compactionTries, handed.tries);
			armCompaction(ctx, handed.wait);
		}
		if (event.reason !== "startup" && event.reason !== "resume" && event.reason !== "reload") return;
		const note = pendingNote(ctx);
		if (!note) return;
		if (note.resetAt !== undefined && note.resetAt <= Date.now()) {
			notify(ctx, `The usage limit reset at ${when(note.resetAt)} while Pi was not running: send a prompt to continue the task.`, "info");
			return;
		}
		if (note.resetAt === undefined && Date.now() - (note.firstAt ?? note.hitAt) > MAX_WAIT_MS) return;
		// The run starts once the session has started; its first request waits for the reset, or tries again soon.
		setTimeout(() => {
			if (ctxRef !== ctx || armed || !ctx.isIdle()) return;
			const now = Date.now();
			runTries.firstAt = note.firstAt ?? note.hitAt;
			armed = {
				hitAt: now,
				resetAt: note.resetAt,
				minute: true,
				notBefore: note.resetAt === undefined ? now + PROBE_MINUTES[0] * 60_000 : 0,
				spread: Math.random() * SPREAD_MS,
				again: false,
				sawUsedUp: false,
			};
			const details: NoteDetails = { hitAt: note.hitAt, error: note.error, resetAt: note.resetAt, firstAt: runTries.firstAt, restarted: true };
			try {
				pi.sendMessage({ customType: MESSAGE_TYPE, content: noteText(details), display: true, details }, { triggerTurn: true });
			} catch {
				// The session was replaced meanwhile.
				armed = undefined;
			}
		}, 0);
	});

	pi.on("session_shutdown", (event) => {
		// Pi aborts the run before it quits: a wait that ended just now ended that way, not by Esc.
		if (event.reason === "quit" && Date.now() - abortedAt < 2_000) {
			try {
				pi.appendEntry<QuitMark>(MESSAGE_TYPE, { quit: true });
			} catch {
				// Nothing to mark without a session.
			}
		}
		abortedAt = 0;
		// /reload hands the compaction's wait to the extension instance that follows.
		const file = ctxRef?.sessionManager.getSessionFile();
		if (event.reason === "reload" && compaction && file) {
			(globalThis as { [HANDOVER]?: Handover })[HANDOVER] = { file, wait: compaction, tries: { ...compactionTries } };
		}
		stopCompactionWait();
		retrying = undefined;
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		ctxRef = undefined;
		reset();
		setWaiting(false);
	});

	pi.on("session_before_compact", (event) => {
		if (event.reason === "manual") instructions = event.customInstructions;
	});

	pi.on("session_compact", () => {
		// A compaction went through: none needs to wait any more.
		stopCompactionWait();
		compactionTries.hits = 0;
		compactionTries.probes = 0;
	});

	pi.on("session_compact_failed", (event, ctx) => {
		ctxRef = ctx;
		const mine = retrying;
		retrying = undefined;
		const text = event.errorMessage ?? "";
		if (event.aborted || !LIMIT.test(text)) return;
		const wait = waitFor(ctx, { text, at: Date.now() }, compactionTries, mine !== undefined, COMPACTION_WORDS);
		if (!wait) return;
		const reason = mine?.reason ?? event.reason;
		const pending: CompactionWait = {
			...wait,
			reason,
			instructions: mine ? mine.instructions : event.reason === "manual" ? instructions : undefined,
			error: text,
		};
		armCompaction(ctx, pending);
		const due = dueOf(pending);
		const at = wait.resetAt === undefined ? `at ${when(due)}, as no reset time was named` : `once the limit resets, at ${when(due)}`;
		notify(ctx, `The compaction is tried again ${at}${reason === "overflow" ? ", and the run continues then" : ""} (Esc cancels).`, "info");
	});

	pi.on("input", (event) => {
		// A prompt goes first; Pi compacts before it when the context needs it.
		if (event.source !== "extension" && compaction) stopCompactionWait();
		return { action: "continue" };
	});

	pi.on("before_provider_request", () => {
		refused = undefined;
	});

	pi.on("after_provider_response", (event) => {
		refused = event.status >= 400 ? { status: event.status, headers: event.headers } : undefined;
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
		if (message.role !== "assistant") return;
		const again = released;
		released = false;
		// The headers belong to this request alone.
		const response = refused;
		refused = undefined;
		const text = message.errorMessage ?? "";
		if (message.stopReason === "error" && LIMIT.test(text)) {
			hitAgain ||= again;
			lastLimit = { text, at: Date.now(), headers: response?.status === 429 ? response.headers : undefined };
			return;
		}
		lastLimit = undefined;
		hitAgain = false;
		if (message.stopReason !== "aborted") {
			runTries.hits = 0;
			runTries.probes = 0;
		}
	});

	pi.on("agent_before_settle", (event, ctx) => {
		ctxRef = ctx;
		const hit = lastLimit;
		const again = hitAgain;
		lastLimit = undefined;
		hitAgain = false;
		if (event.outcome !== "error" || !hit) return undefined;
		const messages = event.context.contextMessages;
		const last = messages[messages.length - 1];
		if (!last || last.role !== "assistant" || last.stopReason !== "error") return undefined;

		// Omit the failed attempt from the model's context, as Pi's own retry does, so the run can continue.
		const same = (m: (typeof messages)[number]) => m === last || (m.role === "assistant" && m.timestamp === last.timestamp && m.stopReason === "error");
		const entry = [...event.context.contextEntries].reverse().find((e) => e.messages.some(same));
		if (!entry) return undefined;

		const wait = waitFor(ctx, hit, runTries, again, RUN_WORDS);
		if (!wait) return undefined;
		armed = wait;
		const details: NoteDetails = { hitAt: hit.at, error: hit.text, resetAt: wait.resetAt, firstAt: wait.resetAt === undefined ? runTries.firstAt : undefined };
		return {
			entries: [
				...event.entries,
				{ type: "context_edit", targetId: entry.sourceEntry.id, replacement: null },
				{ type: "custom_message", customType: MESSAGE_TYPE, content: noteText(details), display: true, details },
			],
			continue: true,
		};
	});

	pi.on("context", async (_event, ctx) => {
		ctxRef = ctx;
		const wait = armed;
		if (!wait) return undefined;
		armed = undefined;
		if (await hold(ctx, wait)) released = true;
		return undefined;
	});

	pi.on("agent_settled", () => {
		armed = undefined;
		setWaiting(false);
	});

	pi.events.emit("plan-usage:source-request", undefined);
}
