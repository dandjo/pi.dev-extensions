/**
 * Network resilience: Claude Code's handling of dropped connections and stalled responses, for any provider.
 *
 * Claude Code keeps a request alive through network trouble. After 20 s without stream data it shows "Waiting for API
 * response · check your network"; it aborts a stream that went silent or outlived a system suspend and retries on a
 * fresh connection; it names the cause of a connection error ("No internet route — check your connection or VPN");
 * and it retries ten times with a backoff that doubles from 0.5 s to 32 s. Pi retries three times within 14 s and
 * shows nothing while a request hangs. Through pi-claude-subscription, Claude Code's own retries stay invisible as
 * well: the provider drops their messages, so Pi shows "Working…" for as long as Claude Code retries, which with
 * connects that time out takes twenty minutes and more. This extension adds Claude Code's behaviour on top of Pi's,
 * with documented extension events only:
 *
 * - Stall notice: after 20 s without a stream event, the working message counts the wait and says whether the API
 *   host answers a TCP probe (DNS and connect, through HTTPS_PROXY when one is set).
 * - Restart on a fresh connection: a request that gets no data after the network came back, the machine woke from
 *   sleep, or the network interfaces changed (a VPN coming up, Wi-Fi to cable; IPv4 addresses and IPv6 /64 prefixes
 *   count, so rotating IPv6 privacy addresses do not) is aborted 10 s later, and the run resumes with a note to the
 *   model. Data in the first 5 s after a change does not count: it can be the last bytes of a connection the change
 *   already cut. A change also concerns the requests that start after it, until data comes through: Claude Code, for
 *   one, sends them over a connection opened before the change, which never answers. Such a request is restarted
 *   after 30 s without data, or after 60 s when the last response is more than 5 min old and the prompt cache cold.
 *   So is any request silent for 5 min while the host answers. At most three restarts follow each other without a
 *   response in between.
 * - Waiting for the network: before every request that follows a connection error, Pi's own retries included, the
 *   API host is probed. While it does not answer, Pi waits and probes every 3 s instead of spending its retries, for
 *   up to 30 min per outage. Esc interrupts the wait.
 * - More attempts: when Pi gives up on a transient error, the run continues with Claude Code's backoff (4 s, 8 s,
 *   16 s, then 32 s, plus up to 25 % jitter) until ten requests have failed in a row. Usage limits, login, request,
 *   and context errors are never retried.
 * - While the host does not answer, the footer shows "⚠ offline".
 * - When the API delivers data while the probe fails, the probe does not reflect this network (a proxy Pi does not
 *   see, for example). Probing then stops until Pi restarts; restarts after a disruption follow the grace alone.
 * - The probe goes to the model's API host. A provider without an http(s) base URL is probed only when it is
 *   claude-sdk (pi-claude-subscription), whose Claude Code talks to Anthropic; any other is not probed (set
 *   probeHost for it), and its restarts follow the grace alone.
 *
 * Optional settings in ~/.pi/agent/network-resilience.json: noticeSeconds (20), graceSeconds (10), stallSeconds
 * (300, 0 turns the silence restart off), maxRestarts (3), maxAttempts (10), offlineWaitMinutes (30, 0 turns the
 * waiting off), and probeHost ("host:port" to probe instead of the model's API host).
 */

import { existsSync, readFileSync } from "node:fs";
import * as net from "node:net";
import os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = path.join(getAgentDir(), "network-resilience.json");
const STATUS_KEY = "network";
const MESSAGE_TYPE = "network-resilience";
const TICK_MS = 1_000;
/** The wall clock ran ahead of the monotonic clock by more than this: the machine slept. Linux's stops meanwhile. */
const SLEEP_GAP_MS = 5_000;
/**
 * A tick came this much later than due: the machine slept. The monotonic clocks of macOS and Windows run on while it
 * sleeps, so only the delay shows it there, and a Pi that froze for some seconds must not count. A shorter sleep goes
 * unnoticed there; it seldom cuts a connection, and a Wi-Fi that dropped shows as an interface change.
 */
const LATE_TICK_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_INTERVAL_MS = 5_000;
const OFFLINE_PROBE_INTERVAL_MS = 3_000;
const NET_CHECK_MS = 2_000;
/** Data this soon after a change can be the last bytes of a connection the change cut: it does not show that it works. */
const SETTLE_MS = 5_000;
/**
 * How long a request that starts after a change waits for its first data. It may go out over a connection opened
 * before the change, which then never answers. A fresh connection answers within seconds, and a restart costs the
 * request: so this is longer than the grace.
 */
const REUSED_WAIT_MS = 30_000;
/**
 * The same with a cold prompt cache, when the API reads the whole context first: 199 Claude Opus requests that wrote
 * 100k to 950k tokens to the cache took up to 42 s to their first complete content block (November 2026).
 */
const REUSED_COLD_WAIT_MS = 60_000;
/** Anthropic's prompt cache lives 5 min by default: a response this recent leaves it warm. */
const CACHE_WARM_MS = 5 * 60_000;
/**
 * Interfaces of containers and virtual machines come and go without touching the route to the API: Linux names, the
 * macOS VM bridges and Apple's peer-to-peer links, and the Windows adapters of WSL, Hyper-V, VirtualBox, and VMware.
 */
const VIRTUAL_INTERFACE =
	/^(lo|docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|podman|kube|lxc|lxd|bridge|vmenet|awdl|llw|anpi|vEthernet|VirtualBox|VMware)/;

interface Config {
	noticeSeconds: number;
	graceSeconds: number;
	stallSeconds: number;
	maxRestarts: number;
	maxAttempts: number;
	offlineWaitMinutes: number;
	probeHost?: string;
}

const DEFAULTS: Config = {
	noticeSeconds: 20,
	graceSeconds: 10,
	stallSeconds: 300,
	maxRestarts: 3,
	maxAttempts: 10,
	offlineWaitMinutes: 30,
};

function loadConfig(): Config {
	const config = { ...DEFAULTS };
	try {
		if (!existsSync(CONFIG_FILE)) return config;
		const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
		for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
			const value = raw?.[key];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) (config as Record<string, unknown>)[key] = value;
		}
		if (typeof raw?.probeHost === "string" && raw.probeHost.trim()) config.probeHost = raw.probeHost.trim();
	} catch {
		// A broken settings file must not cost the protection: the defaults apply.
	}
	return config;
}

// --- Probe ----------------------------------------------------------------------------------------------------------

interface Target {
	host: string;
	port: number;
	/** What the user reads: the API host, and the proxy when the probe goes through one. */
	label: string;
}

type Probe = { ok: true; at: number; label: string } | { ok: false; at: number; label: string; code: string };

function hostPort(value: string, defaultPort: number): { host: string; port: number } | undefined {
	try {
		const url = new URL(value.includes("://") ? value : `tcp://${value}`);
		if (!url.hostname) return undefined;
		const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : defaultPort;
		return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
	} catch {
		return undefined;
	}
}

function bypassesProxy(host: string): boolean {
	const list = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
	return list
		.split(",")
		.map((s) => s.trim().toLowerCase().replace(/^\*?\./, ""))
		.some((entry) => entry === "*" || (entry !== "" && (host === entry || host.endsWith(`.${entry}`))));
}

/** The host to probe: probeHost, else the model's API host; undefined when the model's provider names none. */
function probeTarget(ctx: ExtensionContext | undefined, config: Config): Target | undefined {
	if (config.probeHost) {
		const own = hostPort(config.probeHost, 443);
		if (own) return { ...own, label: own.host };
	}
	// pi-claude-subscription's models have the pseudo URL claude-agent-sdk://local: Claude Code talks to Anthropic.
	const baseUrl = ctx?.model?.baseUrl;
	const http = baseUrl && /^https?:\/\//.test(baseUrl);
	if (!http && ctx?.model?.provider !== "claude-sdk") return undefined;
	const api = http ? baseUrl : process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
	const target = hostPort(api, 443) ?? { host: "api.anthropic.com", port: 443 };
	const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
	const via = proxy && !bypassesProxy(target.host.toLowerCase()) ? hostPort(proxy, 8080) : undefined;
	if (via) return { ...via, label: `${target.host} via ${via.host}` };
	return { ...target, label: target.host };
}

/** A TCP connect to the target: DNS, route, and the far end, without sending anything. */
function probe(target: Target): Promise<Probe> {
	return new Promise((resolve) => {
		let settled = false;
		const socket = net.connect({ host: target.host, port: target.port });
		const finish = (result: Probe) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish({ ok: false, at: performance.now(), label: target.label, code: "ETIMEDOUT" }), PROBE_TIMEOUT_MS);
		timer.unref();
		socket.once("connect", () => finish({ ok: true, at: performance.now(), label: target.label }));
		socket.once("error", (error: NodeJS.ErrnoException & { errors?: NodeJS.ErrnoException[] }) => {
			const code = error.code ?? error.errors?.find((e) => e.code)?.code ?? "ERROR";
			finish({ ok: false, at: performance.now(), label: target.label, code });
		});
	});
}

/** Claude Code's wording for a connection failure (2.1.x), for the probe target. */
function cause(code: string, label: string): string {
	switch (code) {
		case "ENOTFOUND":
		case "EAI_AGAIN":
		case "EAI_FAIL":
		case "EAI_NONAME":
			return `can't resolve ${label} (${code}) · check your internet or DNS`;
		case "ENETUNREACH":
		case "ENETDOWN":
		case "EHOSTUNREACH":
		case "EHOSTDOWN":
			return `no route to ${label} (${code}) · check your connection or VPN`;
		case "ECONNREFUSED":
			return `${label} refused the connection (${code}) · a firewall or proxy may block it`;
		case "ETIMEDOUT":
			return `${label} does not answer · check your connection or VPN`;
		default:
			return `${label} unreachable (${code})`;
	}
}

// --- Errors ---------------------------------------------------------------------------------------------------------

/** Errors a retry cannot fix: limits that reset after hours, login, the request itself, its size. */
const PERMANENT =
	/hit your [\w ]*limit|usage limit|credit|quota|billing|insufficient|login expired|\/login|unauthori[sz]ed|authenticat|api.?key|permission|forbidden|invalid.?request|prompt is too long|context.?(?:length|window)|too many tokens|content.?filter|refus|(?:operation|request) was aborted/i;
/** Network, transport, and server-side failures, in the wording of Pi, the SDKs, and Claude Code. */
const TRANSIENT =
	/network|connect|socket|ECONN|ENET|EHOST|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR|fetch failed|timed? ?out|timeout|terminated|stream|stalled|stopped arriving|no response|overloaded|capacity|server.?error|internal.?error|unavailable|bad gateway|\b(?:429|5\d\d)\b|too many requests|rate.?limit|exited unexpectedly|other side closed|reset before headers|ended without|hang up/i;

function isTransient(text: string): boolean {
	return TRANSIENT.test(text) && !PERMANENT.test(text);
}

/** One line for the working message, Claude Code's wording when the error names a known code. */
function shortError(text: string): string {
	const code = text.match(/\b(E[A-Z]{3,}|UND_ERR_[A-Z_]+)\b/)?.[1];
	switch (code) {
		case "ECONNRESET":
		case "EPIPE":
		case "ECONNABORTED":
		case "UND_ERR_SOCKET":
			return `Connection dropped (${code})`;
		case "ECONNREFUSED":
			return `Connection refused (${code})`;
		case "ENOTFOUND":
		case "EAI_AGAIN":
			return `Can't reach the API server (${code})`;
		case "ENETUNREACH":
		case "ENETDOWN":
		case "EHOSTUNREACH":
		case "EHOSTDOWN":
			return `No internet route (${code})`;
		case "ETIMEDOUT":
			return `Request timed out (${code})`;
	}
	const line = text.split("\n").find((l) => l.trim())?.trim() ?? "Request failed";
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Claude Code's backoff: 0.5 s doubling per attempt up to 32 s, plus up to 25 % jitter. */
function backoff(attempt: number): number {
	const base = Math.min(32_000, 500 * 2 ** Math.max(0, attempt - 1));
	return Math.round(base * (1 + 0.25 * Math.random()));
}

// --- Helpers --------------------------------------------------------------------------------------------------------

function clock(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = String(s % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * The /64 prefix of a global or unique local IPv6 address; undefined for link-local addresses, which every interface
 * has without reaching the API, and for Teredo addresses, which change with the NAT mapping rather than the network.
 */
function ipv6Prefix(address: string): string | undefined {
	const [left, right] = address.split("%")[0].toLowerCase().split("::");
	const head = left ? left.split(":") : [];
	const tail = right ? right.split(":") : [];
	// An IPv4 address at the end takes the room of two groups.
	const size = (groups: string[]) => groups.length + (groups.at(-1)?.includes(".") ? 1 : 0);
	const groups = right === undefined ? head : [...head, ...Array(Math.max(0, 8 - size(head) - size(tail))).fill("0"), ...tail];
	const top = groups.slice(0, 4).map((g) => Number.parseInt(g, 16));
	if (top.length < 4 || top.some((g) => Number.isNaN(g))) return undefined;
	if ((top[0] & 0xffc0) === 0xfe80 || (top[0] === 0x2001 && top[1] === 0)) return undefined;
	return `${top.map((g) => g.toString(16)).join(":")}::/64`;
}

/**
 * IPv4 addresses and IPv6 /64 prefixes per physical or VPN interface. Prefixes rather than addresses: IPv6 privacy
 * addresses rotate within theirs every day, and the old ones keep serving the connections opened with them.
 */
function interfaces(): Map<string, string> {
	const result = new Map<string, string>();
	for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
		if (VIRTUAL_INTERFACE.test(name)) continue;
		const keys = new Set<string>();
		for (const a of addresses ?? []) {
			if (a.internal) continue;
			const key = a.family === "IPv4" ? a.address : a.family === "IPv6" ? ipv6Prefix(a.address) : undefined;
			if (key) keys.add(key);
		}
		if (keys.size > 0) result.set(name, [...keys].sort().join(" "));
	}
	return result;
}

function interfaceChange(before: Map<string, string>, after: Map<string, string>): string | undefined {
	const changes: string[] = [];
	for (const [name, address] of after) {
		if (!before.has(name)) changes.push(`${name} up`);
		else if (before.get(name) !== address) changes.push(`${name} has a new address`);
	}
	for (const name of before.keys()) if (!after.has(name)) changes.push(`${name} down`);
	return changes.length > 0 ? changes.join(", ") : undefined;
}

// --- Extension ------------------------------------------------------------------------------------------------------

/** Something that may have killed open connections. */
interface Disruption {
	reason: string;
	at: number;
	/** Only data after this shows a working connection. */
	countsFrom: number;
	/** Without such data this long after countsFrom and the host's first answer, the request restarts. */
	waitMs: number;
}

interface Request {
	started: number;
	lastData: number;
	disruption?: Disruption;
	/** First answered probe after the disruption. */
	onlineSince?: number;
	/** First unanswered probe of the current outage. */
	offlineSince?: number;
	probe?: Probe;
	probing: boolean;
	lastProbeAt: number;
	shown: boolean;
	gaveUp: boolean;
}

interface Retry {
	attempt: number;
	delayMs: number;
	error: string;
}

export default function (pi: ExtensionAPI): void {
	const config = loadConfig();
	let ctxRef: ExtensionContext | undefined;
	let request: Request | undefined;
	let ticker: NodeJS.Timeout | undefined;
	let lastWall = Date.now();
	let lastMono = performance.now();
	/** Failed requests in a row, Pi's own retries included. */
	let failures = 0;
	let lastError: { text: string; transient: boolean } | undefined;
	/** Restarts in a row without a response in between. */
	let restarts = 0;
	/** Set while this extension aborts a run, so the settled run resumes. */
	let restartReason: string | undefined;
	/** The continuation after Pi gave up waits this long before its request. */
	let retry: Retry | undefined;
	/** Start of an outage the waiting saw, monotonic; its budget is offlineWaitMinutes. */
	let outageSince: number | undefined;
	/** Data arrived while a probe failed: the probe target does not reflect this network, so probing stops. */
	let probeUntrusted = false;
	let status: string | undefined;
	/** Watched all the time, not per request: a change between requests kills the connections the next one reuses. */
	let knownInterfaces = interfaces();
	let interfacesCheckedAt = performance.now();
	/** The last change no data has come through since. */
	let pendingChange: { reason: string; at: number } | undefined;
	/** When the provider last delivered data, for any request. */
	let lastDataAt = Number.NEGATIVE_INFINITY;

	function ui() {
		return ctxRef?.hasUI ? ctxRef.ui : undefined;
	}

	function setStatus(text: string | undefined): void {
		if (text === status) return;
		status = text;
		ui()?.setStatus(STATUS_KEY, text);
	}

	function startRequest(): void {
		const now = performance.now();
		request = { started: now, lastData: now, probing: false, lastProbeAt: 0, shown: false, gaveUp: false };
		if (pendingChange) {
			const waitMs = now - lastDataAt < CACHE_WARM_MS ? REUSED_WAIT_MS : REUSED_COLD_WAIT_MS;
			request.disruption = { reason: pendingChange.reason, at: pendingChange.at, countsFrom: now, waitMs };
		}
	}

	/** The request goes out: its silence counts from here, and so does a change before it, which data has to clear. */
	function sent(): void {
		const r = request;
		if (!r) return;
		const now = performance.now();
		r.lastData = now;
		if (r.disruption && r.disruption.countsFrom < now) r.disruption.countsFrom = now;
		if (r.shown) render();
	}

	function endRequest(): void {
		if (!request) return;
		if (request.shown) ui()?.setWorkingMessage();
		if (request.probe?.ok === false) setStatus(undefined);
		request = undefined;
	}

	function data(): void {
		const now = performance.now();
		lastDataAt = now;
		if (pendingChange && now > pendingChange.at + SETTLE_MS) pendingChange = undefined;
		const r = request;
		if (!r) return;
		r.lastData = now;
		// Data after a failed probe: probe again, so the footer does not keep saying offline.
		if (r.probe?.ok === false && !r.probing && !probeUntrusted) void probeNow(r);
		if (r.shown) render();
	}

	function networkChanged(reason: string, at: number): void {
		pendingChange = { reason, at };
		if (!request) return;
		request.disruption = { reason, at, countsFrom: at + SETTLE_MS, waitMs: config.graceSeconds * 1000 };
		request.onlineSince = undefined;
		request.lastProbeAt = 0;
	}

	function disrupted(r: Request): boolean {
		return r.disruption !== undefined && r.lastData <= r.disruption.countsFrom;
	}

	async function probeNow(r: Request): Promise<void> {
		r.probing = true;
		const started = performance.now();
		r.lastProbeAt = started;
		const target = probeTarget(ctxRef, config);
		const result = target ? await probe(target) : undefined;
		r.probing = false;
		if (!result) return;
		if (request !== r) return;
		if (!result.ok && r.lastData > started) {
			// The API delivered while the probe target did not answer.
			probeUntrusted = true;
			r.probe = undefined;
			r.offlineSince = undefined;
			setStatus(undefined);
			render();
			return;
		}
		r.probe = result;
		if (!result.ok) {
			r.offlineSince ??= result.at;
			r.onlineSince = undefined;
			if (!disrupted(r)) r.disruption = { reason: `${result.label} was unreachable`, at: result.at, countsFrom: result.at, waitMs: config.graceSeconds * 1000 };
		} else {
			r.offlineSince = undefined;
			if (disrupted(r)) r.onlineSince ??= result.at;
		}
		render();
	}

	function restart(reason: string): void {
		const ctx = ctxRef;
		if (!request || !ctx || restartReason !== undefined) return;
		if (restarts >= config.maxRestarts) {
			if (!request.gaveUp) {
				request.gaveUp = true;
				ui()?.notify(`network-resilience: ${restarts} restarts in a row, so this request is left to the provider`, "warning");
			}
			return;
		}
		restarts++;
		restartReason = reason;
		// The restart goes out on fresh connections; waiting for data again would restart it for the same change.
		pendingChange = undefined;
		ui()?.setWorkingMessage(`${capitalize(reason)} · restarting the request`);
		request = undefined;
		ctx.abort();
	}

	function render(): void {
		const r = request;
		const u = ui();
		if (!r || !u) return;
		const now = performance.now();
		const silence = now - r.lastData;
		const p = r.probe;
		const offline = p !== undefined && !p.ok;
		const back = restartFrom(r);
		let text: string | undefined;
		if (p && !p.ok && (disrupted(r) || silence >= config.noticeSeconds * 1000)) {
			text = `Offline ${clock(now - (r.offlineSince ?? now))} · ${cause(p.code, p.label)}`;
			setStatus(`⚠ offline · ${p.label}`);
		} else if (r.disruption && disrupted(r)) {
			const wait = back === undefined ? " · checking the network" : ` · restart in ${Math.max(0, Math.ceil((back + r.disruption.waitMs - now) / 1000))}s`;
			text = `${capitalize(r.disruption.reason)} · no data for ${clock(silence)}${wait}`;
		} else if (silence >= config.noticeSeconds * 1000) {
			const reach = probeUntrusted ? "" : p?.ok ? ` · ${p.label} reachable` : " · checking the network";
			const limit = config.stallSeconds > 0 && !r.gaveUp ? ` · restart at ${clock(config.stallSeconds * 1000)}` : "";
			text = `Waiting for API response ${clock(silence)}${reach}${limit}`;
		}
		if (!offline) setStatus(undefined);
		if (text) {
			u.setWorkingMessage(text);
			r.shown = true;
		} else if (r.shown) {
			u.setWorkingMessage();
			r.shown = false;
		}
	}

	function tick(): void {
		const wall = Date.now();
		const now = performance.now();
		const missed = wall - lastWall - (now - lastMono);
		const late = now - lastMono - TICK_MS;
		lastWall = wall;
		lastMono = now;
		if (missed > SLEEP_GAP_MS) networkChanged(`woke from sleep after ${clock(missed)}`, now);
		else if (late > LATE_TICK_MS) networkChanged(`woke from sleep after ${clock(late)}`, now);
		if (now - interfacesCheckedAt >= NET_CHECK_MS) {
			const current = interfaces();
			const change = interfaceChange(knownInterfaces, current);
			knownInterfaces = current;
			interfacesCheckedAt = now;
			if (change) networkChanged(`the network changed (${change})`, now);
		}
		const r = request;
		if (!r) return;
		const silence = now - r.lastData;
		const broken = disrupted(r);
		const wanted = !probeUntrusted && (broken || silence >= config.noticeSeconds * 1000);
		const interval = r.probe?.ok === false ? OFFLINE_PROBE_INTERVAL_MS : PROBE_INTERVAL_MS;
		if (wanted && !r.probing && now - r.lastProbeAt >= interval) void probeNow(r);
		const back = restartFrom(r);
		if (r.disruption && broken) {
			if (back !== undefined && now - back >= r.disruption.waitMs) return restart(r.disruption.reason);
		} else if (config.stallSeconds > 0 && silence >= config.stallSeconds * 1000 && (probeUntrusted || r.probe?.ok)) {
			return restart(`no data for ${clock(silence)}`);
		}
		render();
	}

	/** When the grace for a disrupted request starts: once the host answers again, or at once without probing. */
	function restartFrom(r: Request): number | undefined {
		if (!r.disruption || !disrupted(r)) return undefined;
		if (probeUntrusted) return r.disruption.countsFrom;
		return r.onlineSince === undefined ? undefined : Math.max(r.onlineSince, r.disruption.countsFrom);
	}

	/**
	 * Runs before a request that follows a failure: waits while the API host does not answer, then waits out the
	 * backoff of a continuation. Esc aborts the run's signal and with it the wait.
	 */
	async function gate(ctx: ExtensionContext, pending: Retry | undefined): Promise<void> {
		const signal = ctx.signal;
		const u = ctx.hasUI ? ctx.ui : undefined;
		const target = probeTarget(ctx, config);
		let result = target && config.offlineWaitMinutes > 0 && !probeUntrusted ? await probe(target) : undefined;
		try {
			if (target && result && !result.ok) {
				outageSince ??= performance.now();
				const deadline = outageSince + config.offlineWaitMinutes * 60_000;
				while (result && !result.ok && !signal?.aborted && performance.now() < deadline) {
					const next = performance.now() + OFFLINE_PROBE_INTERVAL_MS;
					while (!signal?.aborted && performance.now() < next) {
						u?.setWorkingMessage(`Offline ${clock(performance.now() - outageSince)} · ${cause(result.code, target.label)} · waiting for the network · esc to interrupt`);
						setStatus(`⚠ offline · ${target.label}`);
						await sleep(Math.min(1000, next - performance.now()), signal);
					}
					if (signal?.aborted) return;
					result = await probe(target);
				}
				// Back online: the request goes out at once. Past the budget, it goes out and fails as it will.
				if (result?.ok) outageSince = undefined;
				return;
			}
			if (result?.ok) outageSince = undefined;
			if (pending) {
				const until = performance.now() + pending.delayMs;
				while (!signal?.aborted && performance.now() < until) {
					u?.setWorkingMessage(`${pending.error} · retrying in ${Math.ceil((until - performance.now()) / 1000)}s · attempt ${pending.attempt}/${config.maxAttempts}`);
					await sleep(Math.min(1000, until - performance.now()), signal);
				}
			}
		} finally {
			u?.setWorkingMessage();
			setStatus(undefined);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		lastWall = Date.now();
		lastMono = performance.now();
		if (ticker) clearInterval(ticker);
		ticker = setInterval(tick, TICK_MS);
		ticker.unref();
	});

	pi.on("session_shutdown", () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		endRequest();
		ctxRef = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		ctxRef = ctx;
		// A new prompt from the user starts the counting afresh; the resume note of a restart does not.
		if (event.messageType === "user") {
			failures = 0;
			restarts = 0;
			outageSince = undefined;
		}
	});

	pi.on("context", async (_event, ctx) => {
		ctxRef = ctx;
		const pending = retry;
		retry = undefined;
		if (pending || lastError?.transient) await gate(ctx, pending);
		startRequest();
		return undefined;
	});

	pi.on("before_provider_request", (_event, ctx) => {
		ctxRef = ctx;
		sent();
		return undefined;
	});
	pi.on("after_provider_response", () => data());
	pi.on("provider_stream_event", () => data());
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") data();
	});
	pi.on("message_update", () => data());

	pi.on("message_end", (event, ctx) => {
		ctxRef = ctx;
		const message = event.message;
		if (message.role !== "assistant") return undefined;
		endRequest();
		if (message.stopReason === "error") {
			failures++;
			const text = message.errorMessage ?? "";
			lastError = { text, transient: isTransient(text) };
		} else if (message.stopReason !== "aborted") {
			failures = 0;
			restarts = 0;
			lastError = undefined;
			outageSince = undefined;
		}
		return undefined;
	});

	pi.on("agent_before_settle", (event, ctx) => {
		ctxRef = ctx;
		if (event.outcome !== "error" || !lastError?.transient) return undefined;
		if (outageSince !== undefined && performance.now() - outageSince >= config.offlineWaitMinutes * 60_000) return undefined;
		const messages = event.context.contextMessages;
		const last = messages[messages.length - 1];
		if (!last || last.role !== "assistant" || last.stopReason !== "error") return undefined;
		if (failures >= config.maxAttempts) {
			if (ctx.hasUI) ctx.ui.notify(`network-resilience: ${failures} failed requests in a row, giving up`, "warning");
			return undefined;
		}
		// Omit the failed attempt from the model's context, as Pi's own retry does, so the run can continue.
		const same = (m: (typeof messages)[number]) => m === last || (m.role === "assistant" && m.timestamp === last.timestamp && m.stopReason === "error");
		const entry = [...event.context.contextEntries].reverse().find((e) => e.messages.some(same));
		if (!entry) return undefined;
		retry = { attempt: failures + 1, delayMs: backoff(failures), error: shortError(lastError.text) };
		return {
			entries: [...event.entries, { type: "context_edit", targetId: entry.sourceEntry.id, replacement: null }],
			continue: true,
		};
	});

	pi.on("agent_settled", (event, ctx) => {
		ctxRef = ctx;
		endRequest();
		ui()?.setWorkingMessage();
		retry = undefined;
		const reason = restartReason;
		restartReason = undefined;
		if (reason === undefined || !event.aborted) return;
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: `The connection broke while you were responding (${reason}), so that response was lost and the request was restarted. Continue where you left off.`,
				display: true,
			},
			{ triggerTurn: true },
		);
	});
}
