/**
 * Remote Control: Claude Code's /remote-control for Pi. Connects the running session to claude.ai, so the Claude app
 * (iOS, Android) and claude.ai/code show its conversation live and can drive it: send prompts, images and files,
 * interrupt, switch the model, set the effort, rename the session, show the context and the plan usage
 * (https://code.claude.com/docs/en/remote-control).
 *
 * - /remote-control [name], also /rc: connects, shows the session link and a QR code, and reads "/rc active" in the
 *   footer. Run again while connected for the status panel, where the connection can be closed; the local session
 *   keeps running. `pi --remote-control` connects at start, as does remoteControlAtStartup: true in
 *   ~/.claude/settings.json once Remote Control was enabled here.
 * - A session that was connected when Pi closed connects again when it is opened (startup, /resume, and /reload while
 *   not connected), once Remote Control was enabled here: the session records whether it is connected (a
 *   remote-control-state entry, not shown). Quitting Pi keeps the record; disconnecting, or a connection that ends
 *   while Pi runs, clears it, and so does a reconnect the server refuses (a plan or policy without Remote Control) or
 *   that ends on a login rejected twice in a row, so the session does not fail the same way at every /reload.
 * - A connect Pi makes by itself tries again after RETRY_DELAYS_MS when it fails for a reason that may pass (no
 *   answer, a failed lookup or connection, HTTP 408, 429, 5xx), and once after a rejected login (HTTP 401): right
 *   after a renewal the server can refuse the new token for a few seconds, as it did for several sessions that renewed
 *   together after a reboot. A second rejection in a row ends it; /rc typed by hand tries once. A failure names the
 *   step and the reason, read from Node's HTTP diagnostics channels (watchApiRequests), since the bridge returns none.
 *   A remote session that was created but not usable is archived, and once more later when the server refuses that.
 * - Transport: the Claude Agent SDK's bridge module (@anthropic-ai/claude-agent-sdk/bridge, alpha), installed with
 *   pi-claude-subscription under ~/.pi/agent/npm. It creates the session (POST /v1/code/sessions), mints the worker
 *   credential (POST /v1/code/sessions/{id}/bridge) and runs the event stream, heartbeats and reconnects. This file
 *   translates Pi's conversation into Claude Code's SDK messages and the app's control requests into Pi calls.
 * - Model and effort: the app's model names (aliases, dated ids, a [1m] suffix) resolve among the current provider's
 *   Claude models; its effort levels set Pi's thinking level of the same name, auto Pi's startup level. An effort the
 *   app set survives a model switch from the app, as in Claude Code; otherwise Pi's level for the new model applies
 *   (modelThinkingLevels). The current model and effort go to the app as worker metadata, as Claude Code reports them.
 *   The desktop app sends a model switch at once; the mobile app sends only the effort at once and the model with the
 *   next prompt from the app, so a model picked on the phone does not reach Pi while the prompts come from the
 *   terminal, and the phone shows Pi's model again once it reconnects.
 * - Commands: Pi takes its built-in commands only from its editor, so the extension runs those that need no terminal
 *   UI when they come from the app: /new (also Claude Code's /clear), /reload, /compact, /name, /model, /thinking,
 *   /quit; /new and /reload borrow a command context through an internal /remote-control call. The answer goes to the
 *   app as an assistant message of its own turn; /compact answers with the compaction itself (see Compaction). The other built-ins (/tree, /resume, /settings, …) get a notice
 *   instead of reaching the model; extension commands, skills and prompt templates run as before, except /cron, which
 *   scheduled-tasks.ts carries out and answers as text in the app (scheduled-tasks:command). The desktop app
 *   turns /name and /model into its own requests (rename_session, set_model); the init lists the built-ins for its
 *   / menu.
 * - Context usage: the app's context indicator reads context_usage from the worker metadata, which goes out after
 *   every response as Claude Code reports it (Pi's estimate of the tokens in use, and the window). The context card
 *   asks for it (get_context_usage); the answer is Pi's estimate of the context in use, the compaction reserve and the
 *   free rest, without Claude Code's breakdown by category.
 * - Compaction: the app sees one as Claude Code reports it: status compacting, the boundary ("Conversation compacted",
 *   with the tokens before and the estimate after), the summary as a synthetic user message, the status with the
 *   outcome, and the new context usage; a compaction outside a run is a turn of its own. Pi knows no context usage from
 *   a compaction until the next response, so the estimate of the compacted context stands in, as Pi computes it for
 *   the compaction's result. The history shows earlier compactions the same way.
 * - Plan usage: claude-usage.ts hands over the claude.ai plan limits through the event bus (plan-usage:source, the
 *   source whose plan applies to the current model). They
 *   go to the app as Claude Code forwards its rate limits: a rate_limit_event and rate_limit_info in the worker
 *   metadata, at connect and whenever they change. The usage card asks for get_usage; the answer carries Pi's totals of
 *   the session (tokens and cost per model, time, lines changed by edit) and the plan's windows.
 * - The bridge bundle needs two repairs (patchBridge): its User-Agent names the SDK package version, which the server
 *   takes for an old Claude Code and refuses newer models for, and attachBridgeSession does not pass the effort
 *   handler, the context usage handler, the shared control answers (get_usage) or the initialize state on.
 *   loadBridge() imports a repaired copy
 *   (~/.cache/pi-remote-control, written whole through a rename, since several Pi may connect at once); a repair the bundle has no shape for is left out, and /rc warns about it. The bundle
 *   is also checked without loading it (bridgeCheck): at Pi's start while a Claude model is active, and when
 *   claude-sdk-update.ts reports a new SDK ("claude-sdk-update:installed"); a bundle a repair no longer fits gets a
 *   warning once per process.
 * - Login: a claude.ai OAuth token with the user:sessions:claude_code scope, from claude-login.ts
 *   ("claude-login:source" on the event bus): Claude Code's login (~/.claude/.credentials.json, on macOS the keychain),
 *   the one the claude-sdk provider runs on (Pi's own /login is not used), and while CLAUDE_CODE_OAUTH_TOKEN is set
 *   only a login of that token's account, the one the claude-sdk provider's prompts run on (the setup token itself
 *   cannot open Remote Control sessions). It is read fresh for every request and never refreshed here. Remote Control
 *   is offered only while a Claude model is active: switching to another model ends the connection. The login is
 *   renewed only by a request of Claude Code, so after hours without a prompt the token has run out and the four-hourly
 *   renewal of the worker credential fails; claude-login.ts then has Claude Code renew it under its own lock. A login
 *   that reached its time limit cannot be renewed and needs `!!claude auth login` in Pi (or `claude auth login` in a
 *   shell). Without that extension the token is read here, without renewal and account check, and a login that ran out
 *   stays run out until a prompt renews it. A renewal that keeps failing for five minutes goes into the session log
 *   with its reason, and so does the reconnect after it.
 * - What the app sees: the conversation so far, then every user prompt, assistant message (text, thinking, tool calls
 *   under Claude Code's tool names) and tool result, and a result after each run. Permission prompts do not exist in
 *   Pi, so the app never has to approve anything.
 * - Side questions: the app's /btw arrives as side_question with the app's own earlier side questions; btw.ts answers
 *   it (btw:ask) the way /btw does, and the answer goes back as Claude Code's ({ response, synthetic: false }).
 * - Background tasks: Pi's subagents go to the app as Claude Code's task events (task_started, task_progress at most
 *   every few seconds, task_notification) and the live background ones as background_tasks_changed; the app's stop
 *   button (stop_task) stops one (subagents:stop). Moving a running foreground agent to the background from the app
 *   (background_tasks, Claude Code's Ctrl+B) is not supported yet; in the terminal, Ctrl+B in background-agents.ts does it.
 * - AskUserQuestion: the app answers a question only through a pending permission request, as Claude Code sends it
 *   (can_use_tool with requires_user_interaction); without one it reports "your answer could not be sent". So while
 *   ask-user-question.ts has its dialog open (ask-user-question:open), the questions go to the app as such a request
 *   and the session reports requires_action. The first answer wins: one from the app (allow with updatedInput.answers,
 *   or deny with a message) closes the terminal dialog; one from the terminal goes to the app as the response and
 *   withdraws the request there (control_cancel_request), as does a dismissed or interrupted dialog.
 * - /new, /resume, /fork and /reload keep the connection: Pi replaces the extension runtime and loads this file afresh,
 *   so session_shutdown parks the connection on globalThis and the next runtime's session_start takes it over. The
 *   bridge's callbacks go through Connection.router, which always names the runtime that owns the connection; what
 *   arrives in between waits. As in Claude Code, the next session continues in the same remote session, which keeps
 *   its title and gets neither the title nor the history of a resumed or forked session.
 * - The set of callbacks and the bridge repairs are fixed when the bridge attaches. A runtime whose code differs from
 *   the code that attached (CODE_VERSION; /reload after an update) attaches the bridge anew (reattach): same remote
 *   session and link, a fresh worker credential, the read stream resumed after the last event the old one read.
 *   Without that, the bridge takes what the older code registered no callback for (an answer to a question, a usage
 *   request) and drops it.
 * - Minting a worker credential (a renewal in recover, attaching anew in reattach) supersedes the transport it is to
 *   replace: the server ends that transport with close 4090 at its next request, a heartbeat or the uploads of
 *   activate(). Such a close is this extension's own doing, so it is held while the mint runs (beginEpochMove) and
 *   dropped once the transport is replaced (endEpochMove); a 4090 at any other time ends the connection.
 * - While connected the transcript is stored on Anthropic's servers under the claude.ai data policy. Disconnecting or
 *   quitting archives the session there.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Model, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	type CompactionEntry,
	estimateTokens,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const API_BASE_URL = "https://api.anthropic.com";
const APP_URL = "https://claude.ai";
const HTTP_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 1_500;
/** Refresh the worker credential this long before it expires (Claude Code's token_refresh_buffer_ms). */
const TOKEN_REFRESH_BUFFER_MS = 300_000;
const RECOVERY_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
/** A connect Pi makes by itself tries again after a failure that may pass, after these waits; then it gives up. */
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
/** A credential renewal that keeps failing this long is noted in the session log, with its reason. */
const OFFLINE_NOTE_MS = 5 * 60_000;
/** A running subagent's progress goes to the app at most this often. */
const TASK_PROGRESS_MS = 3_000;
/** A parked connection no runtime takes over within this time (the extension is gone after /reload) is closed. */
const HANDOVER_TIMEOUT_MS = 300_000;
/** Process-wide state that outlives the extension runtime; bump the version when Connection changes shape. */
const SHARED_KEY = Symbol.for("pi.claude-remote-control.shared.v1");
/** This file's code; a connection attached by other code is attached anew when this runtime takes it over. */
const CODE_VERSION = (() => {
	try {
		return createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 16);
	} catch {
		return "unknown";
	}
})();
const MAX_HISTORY_MESSAGES = 400;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TITLE_CHARS = 60;
const STATE_FILE = path.join(getAgentDir(), "remote-control.json");
const BRIDGE_CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "pi-remote-control");
/** Claude Code's effort levels; each is a Pi thinking level of the same name. */
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Pi's built-in commands the app can run: those that need no terminal UI. Claude Code's /clear is Pi's /new. */
const APP_COMMANDS = new Set(["new", "clear", "reload", "compact", "name", "model", "thinking", "quit"]);
/** Pi's other built-ins need the terminal (selectors, clipboard, browser login); from the app they get a notice. */
const TERMINAL_COMMANDS = new Set([
	"settings", "scoped-models", "export", "import", "share", "bug", "copy", "session", "changelog", "hotkeys", "fork", "clone",
	"tree", "trust", "login", "logout", "resume", "debug",
]);
/** Marks the internal /remote-control call that lends an app command a command context (newSession, reload). */
const APP_COMMAND_MARK = "\u0000app:";
const STATUS_KEY = "remote-control";
const ENTRY_TYPE = "remote-control";
/** Whether the session is connected, so opening it again reconnects; not rendered. */
const STATE_ENTRY = "remote-control-state";

const ADJECTIVES = ["graceful", "quiet", "brisk", "sunny", "clever", "gentle", "bold", "calm", "swift", "bright", "merry", "steady"];
const NOUNS = ["unicorn", "otter", "falcon", "maple", "harbor", "comet", "willow", "lantern", "meadow", "pebble", "heron", "ember"];

// --- Types of the SDK bridge (its bridge.d.ts, reduced to what is used) --------------------------------------------

type Json = Record<string, unknown>;

interface BridgeHandle {
	sessionId: string;
	/** The sequence number of the last event the read stream got. */
	getSequenceNum(): number;
	isConnected(): boolean;
	write(message: Json): void;
	sendControlRequest(request: Json): void;
	sendControlResponse(response: Json): void;
	sendControlCancelRequest(requestId: string): void;
	reportState(state: "idle" | "running" | "requires_action"): void;
	reportMetadata(metadata: Json): void;
	reconnectTransport(opts: { ingressToken: string; apiBaseUrl: string; epoch?: number }): Promise<void>;
	flush(): Promise<void>;
	close(): void;
}

interface RemoteCredentials {
	worker_jwt: string;
	api_base_url: string;
	expires_in: number;
	worker_epoch: number;
}

type Verdict = { ok: true; notices?: string[] } | { ok: false; error: string };

/** apply_flag_settings from the app, as the bridge validated it: only these two keys get through. */
interface FlagSettings {
	effortLevel?: string | null;
	ultracode?: boolean;
}

interface BridgeModule {
	createCodeSession(
		baseUrl: string,
		accessToken: string,
		title: string,
		timeoutMs: number,
		tags?: string[],
		gitContext?: unknown,
		cwd?: string,
		model?: string,
	): Promise<string | Json | null>;
	fetchRemoteCredentials(sessionId: string, baseUrl: string, accessToken: string, timeoutMs: number): Promise<RemoteCredentials | Json | null>;
	attachBridgeSession(opts: {
		sessionId: string;
		ingressToken: string;
		apiBaseUrl: string;
		epoch?: number;
		/** Resume the read stream after this event, as a reconnect does; absent, the server sends the session's events from the start. */
		initialSequenceNum?: number;
		claudeCodeVersion?: string;
		onInboundMessage?: (message: Json) => void | Promise<void>;
		/** The app's control_response to a can_use_tool request; false keeps the request pending (rejected answer). */
		onPermissionResponse?: (response: Json) => boolean | void;
		onInterrupt?: () => void;
		onSetModel?: (model: string | undefined) => Verdict | void | Promise<Verdict>;
		onSetMaxThinkingTokens?: (tokens: number | null | undefined) => Verdict | void;
		/** Not in bridge.d.ts: reaches the shared control handler only through the patch in loadBridge(). */
		onApplyFlagSettings?: (settings: FlagSettings, requestId: string) => Verdict;
		/** Not in bridge.d.ts either: its fields join the reply to the app's initialize. */
		getInitializeState?: () => Json;
		/** Nor this: the answer to get_context_usage (SDKControlGetContextUsageResponse). */
		onGetContextUsage?: (opts: { detail?: string }) => Promise<Json>;
		/** Nor this: answers a control request before the bridge does (Claude Code answers get_usage here); undefined leaves it to the bridge. */
		answerSharedControlRequest?: (request: Json) => Promise<{ subtype: "success"; response?: Json }> | undefined;
		onSetPermissionMode?: (mode: string) => Verdict;
		onRenameSession?: (title: string) => Verdict;
		/** The app's /btw; response null means none, synthetic must be false for an answer the bridge passes on. */
		onSideQuestion?: (
			request: { question: string; history?: { question: string; response: string }[] },
			opts: { signal: AbortSignal; onProgress: (progress: Json) => void },
		) => Promise<{ response: string | null; synthetic: boolean }>;
		/** The app's stop button on a task (task_id from task_started). */
		onStopTask?: (taskId: string) => Promise<Json>;
		onClose?: (code?: number) => void;
	}): Promise<BridgeHandle>;
	isCreateSessionFailure(result: unknown): boolean;
	isCredentialsFailure(result: unknown): boolean;
	isCredentialsRejection(result: unknown): boolean;
}

// --- Login ----------------------------------------------------------------------------------------------------------

interface Token {
	value: string;
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
 * claude-login.ts, claude-usage.ts carry a copy of this function: change them alike.
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
 * claude-login.ts carries a copy of this function: change them alike.
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

/**
 * The claude.ai access token of Claude Code's login while claude-login.ts is not loaded, as claude-login.ts hands it
 * out, but without its account check. Never printed, never written anywhere.
 */
async function readAccessToken(): Promise<Token | null> {
	const now = Date.now() + 60_000;
	try {
		const o = (await claudeCodeCredentials())?.claudeAiOauth;
		if (typeof o?.accessToken === "string" && o.accessToken && (!o.expiresAt || o.expiresAt > now)) {
			return { value: o.accessToken };
		}
	} catch {
		// no Claude Code login
	}
	return null;
}

const LOGIN_HINT = "Remote Control needs Claude Code's claude.ai login: run !!claude auth login, then /remote-control again.";
const ENDED_HINT =
	"Claude Code's claude.ai login reached its time limit and cannot be renewed: run !!claude auth login, then /remote-control again.";
const OTHER_ACCOUNT_HINT =
	"Remote Control needs a claude.ai login of the account CLAUDE_CODE_OAUTH_TOKEN belongs to: run !!claude auth login with that account, then /remote-control again.";
/** Added to LOGIN_HINT while claude-login.ts is not loaded: the login may only have run out. */
const NO_RENEWAL_HINT = " A login that ran out while Pi idled is renewed by claude-login.ts, which is not loaded.";

function clock(ms: number, seconds = false): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds && { second: "2-digit" }) });
}

// --- SDK module -------------------------------------------------------------------------------------------------------

/** Which repairs of the bridge took effect (see patchBridge). */
interface BridgePatches {
	/** onApplyFlagSettings, onGetContextUsage, answerSharedControlRequest and getInitializeState reach the control handler. */
	effort: boolean;
	/** The User-Agent names the Claude Code version instead of the SDK package's own. */
	userAgent: boolean;
}

interface LoadedBridge {
	module: BridgeModule;
	version: string;
	patches: BridgePatches;
}

let bridgePromise: Promise<LoadedBridge> | null = null;

/**
 * Two repairs of the bridge bundle, each applied only when the bundle has the shape it expects:
 * - User-Agent: the bundle sends "claude-code/<SDK package version>" (0.3.308), which the server reads as that Claude
 *   Code version, so the app refuses every model that needs a newer one ("Claude Code 0.3.308 does not support this
 *   model"). It becomes the Claude Code version the SDK carries in its manifest (2.1.308), as the CLI sends it.
 * - attachBridgeSession hands the shared control handler neither onApplyFlagSettings, onGetContextUsage,
 *   answerSharedControlRequest nor getInitializeState, so every effort change, context usage and usage request from
 *   the app fails ("not supported in this context") and the reply to its initialize lacks current_model. Claude Code's
 *   own Remote Control passes them. The options object is kept at the start of attachBridgeSession, and the four
 *   fields join the one call of the handler.
 */
function patchBridge(source: string, claudeCodeVersion: string): { source: string; patches: BridgePatches } {
	const patches: BridgePatches = { effort: false, userAgent: false };
	const agents = [...source.matchAll(/return"claude-code\/[^"]*"/g)];
	if (agents.length === 1 && /^\d+\.\d+\.\d+[\w.+-]*$/.test(claudeCodeVersion)) {
		const at = agents[0].index!;
		source = `${source.slice(0, at)}return"claude-code/${claudeCodeVersion}"${source.slice(at + agents[0][0].length)}`;
		patches.userAgent = true;
	}
	const exported = source.match(/export\{[^}]*?\b([\w$]+) as attachBridgeSession\b/);
	if (!exported) return { source, patches };
	const name = exported[1].replace(/\$/g, "\\$");
	const heads = [...source.matchAll(new RegExp(`async function ${name}\\(([\\w$]+)\\)\\{`, "g"))];
	const calls = [...source.matchAll(/onSideQuestion:[\w$]+,writeFrame:/g)];
	if (heads.length !== 1 || calls.length !== 1 || calls[0].index! < heads[0].index!) return { source, patches };
	const start = heads[0].index! + heads[0][0].length;
	const call = calls[0].index! + calls[0][0].length - "writeFrame:".length;
	const kept = "__piBridgeOptions";
	const field = (key: string) => `${key}:typeof ${kept}==="object"?${kept}.${key}:void 0,`;
	patches.effort = true;
	return {
		source: `${source.slice(0, start)}const ${kept}=${heads[0][1]};${source.slice(start, call)}${field("onApplyFlagSettings")}${field("onGetContextUsage")}${field("answerSharedControlRequest")}${field("getInitializeState")}${source.slice(call)}`,
		patches,
	};
}

/** Writes the patched bundle where only this user can write, fresh at every load; older copies go. */
function writePatchedBridge(source: string): string {
	mkdirSync(BRIDGE_CACHE_DIR, { recursive: true, mode: 0o700 });
	const name = `bridge-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.mjs`;
	for (const old of readdirSync(BRIDGE_CACHE_DIR)) {
		if (old !== name && /^bridge-[0-9a-f]{16}\.mjs$/.test(old)) rmSync(path.join(BRIDGE_CACHE_DIR, old), { force: true });
	}
	const file = path.join(BRIDGE_CACHE_DIR, name);
	try {
		// The name is the content's hash: a file of the full size is this copy.
		if (statSync(file).size === Buffer.byteLength(source)) return file;
	} catch {
		// not written yet
	}
	// Another Pi may import the file meanwhile: it must never see it empty or half written.
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, source, { mode: 0o600 });
	renameSync(temp, file);
	return file;
}

/** The repairs that did not take effect, as what the app may then fail at. */
function missingRepairs(patches: BridgePatches): string[] {
	return [
		...(patches.userAgent ? [] : ["models that need a newer Claude Code"]),
		...(patches.effort ? [] : ["changing the effort, the context card and the usage card"]),
	];
}

function bridgeWarning(missing: string[], version: string): string {
	return `Remote Control: ${missing.join(" and ")} may fail from the app with this Claude Agent SDK (Claude Code ${version}); its bridge no longer has the shape this extension repairs.`;
}

/**
 * Checks the bridge of the Claude Agent SDK in a folder against the repairs without loading or writing anything: the
 * warning for a bundle a repair no longer fits, once per bundle in this process, else undefined. A text check only:
 * a shape can still be there while the bundle behaves differently, so connect() warns as well.
 */
function bridgeCheck(sdkDir: string | undefined): string | undefined {
	if (!sdkDir) return undefined;
	let source: string;
	try {
		source = readFileSync(path.join(sdkDir, "bridge.mjs"), "utf8");
	} catch {
		return undefined;
	}
	let version = "unknown";
	try {
		version = String(JSON.parse(readFileSync(path.join(sdkDir, "manifest.json"), "utf8")).version ?? version);
	} catch {
		// the manifest is optional
	}
	const missing = missingRepairs(patchBridge(source, version).patches);
	if (missing.length === 0) return undefined;
	const warned = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi.claude-remote-control.bridge-warned.v1")] ??= new Set<string>()) as Set<string>;
	const key = createHash("sha256").update(source).digest("hex");
	if (warned.has(key)) return undefined;
	warned.add(key);
	return bridgeWarning(missing, version);
}

function loadBridge(): Promise<LoadedBridge> {
	bridgePromise ??= (async () => {
		const sdkDir = claudeSdkDir();
		const file = sdkDir ? path.join(sdkDir, "bridge.mjs") : "";
		if (!sdkDir || !existsSync(file)) throw new Error("The Claude Agent SDK is not installed: `pi install npm:pi-claude-subscription` brings it (see the README).");
		let version = "unknown";
		try {
			version = String(JSON.parse(readFileSync(path.join(sdkDir, "manifest.json"), "utf8")).version ?? version);
		} catch {
			// the manifest is optional
		}
		let target = file;
		let patches: BridgePatches = { effort: false, userAgent: false };
		try {
			const patched = patchBridge(readFileSync(file, "utf8"), version);
			if (patched.patches.effort || patched.patches.userAgent) {
				target = writePatchedBridge(patched.source);
				patches = patched.patches;
			}
		} catch {
			// unpatched, then
		}
		const module = (await import(pathToFileURL(target).href)) as BridgeModule;
		if (typeof module.createCodeSession !== "function" || typeof module.attachBridgeSession !== "function") {
			throw new Error(`the bridge module ${target} is incomplete; restart Pi, then /remote-control again.`);
		}
		return { module, version, patches };
	})().catch((error) => {
		bridgePromise = null;
		throw error;
	});
	return bridgePromise;
}

function requestHeaders(token: string, version: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
		"anthropic-client-platform": "claude_code_cli",
		"User-Agent": `claude-code/${version}`,
	};
}

// --- Helpers ----------------------------------------------------------------------------------------------------------

/**
 * Whether a model is Claude: one of the providers that only carry Claude models, or "claude" in the id elsewhere.
 * claude-usage.ts carries a copy of this function: change them alike.
 */
function isClaudeModel(model: Model<any> | undefined): boolean {
	if (!model) return false;
	return model.provider === "claude-sdk" || model.provider === "anthropic" || /claude/i.test(model.id);
}

function sessionUrl(sessionId: string): string {
	return `${APP_URL}/code/${sessionId.startsWith("cse_") ? `session_${sessionId.slice(4)}` : sessionId}`;
}

/** A UUID derived from a session entry, so a reconnect sends the same history under the same ids. */
function uuidFor(seed: string): string {
	const h = createHash("sha256").update(seed).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function generatedName(): string {
	const prefix = slug(process.env.CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX || os.hostname()) || "remote-control";
	const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];
	return `${prefix}-${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

function textOf(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

function shorten(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Why the bridge's last request to the Remote Control API on one path failed. The bridge returns null alike for a
 * failed name lookup or connection, a timeout, and HTTP 408, 429, or 5xx, and keeps the reason in its own debug log;
 * Node's HTTP diagnostics channels carry it (Node 22: http.client.request.error, http.client.response.finish).
 * reason() is undefined when nothing failed or the channels said nothing.
 */
function watchApiRequests(onPath: (path: string) => boolean): { reason(): string | undefined; stop(): void } {
	const host = new URL(API_BASE_URL).hostname;
	let last: string | undefined;
	const ours = (request: { host?: unknown; path?: unknown } | undefined) => request?.host === host && onPath(String(request.path ?? ""));
	const onError = (message: unknown) => {
		const { request, error } = message as { request?: { host?: unknown; path?: unknown }; error?: NodeJS.ErrnoException };
		if (!ours(request)) return;
		const code = error?.code ?? "";
		if (code === "ENOTFOUND" || code === "EAI_AGAIN") last = `the name lookup of ${host} failed (${code})`;
		else if (code === "ECONNABORTED" || code === "ETIMEDOUT") last = `no answer within ${HTTP_TIMEOUT_MS / 1000} s`;
		else last = `the connection failed (${code || error?.message || "no reason given"})`;
	};
	const onResponse = (message: unknown) => {
		const { request, response } = message as { request?: { host?: unknown; path?: unknown }; response?: { statusCode?: number } };
		if (!ours(request)) return;
		const status = response?.statusCode ?? 0;
		if (status === 429) last = "the server is busy (HTTP 429)";
		else if (status === 408 || status >= 500) last = `the server failed for the moment (HTTP ${status})`;
		else last = undefined;
	};
	subscribe("http.client.request.error", onError);
	subscribe("http.client.response.finish", onResponse);
	return {
		reason: () => last,
		stop: () => {
			unsubscribe("http.client.request.error", onError);
			unsubscribe("http.client.response.finish", onResponse);
		},
	};
}

/** A connect that failed for a reason that may pass: no answer, a failed lookup or connection, the server busy. */
class PassingFailure extends Error {}

/** A connect the server refused the login for (HTTP 401): a new token it does not know yet, or a login to renew. */
class RejectedLogin extends Error {}

/** A connect the server refused for good (a 4xx other than 401, 408, 429): a plan or policy without Remote Control. */
class RefusedConnect extends Error {}

/** How a connect that came after a rejected login names that failure in the session log. */
const REJECTED_REASON = "the server rejected the claude.ai login (HTTP 401)";

function readState(): { enabled?: boolean } {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}

function writeState(state: { enabled?: boolean }): void {
	try {
		mkdirSync(path.dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify(state)}\n`, { mode: 0o600 });
	} catch {
		// the question comes again next time
	}
}

function startupSetting(): boolean {
	try {
		return JSON.parse(readFileSync(path.join(claudeDir(), "settings.json"), "utf8"))?.remoteControlAtStartup === true;
	} catch {
		return false;
	}
}

// --- Pi messages -> Claude Code SDK messages ---------------------------------------------------------------------------

function imageBlock(image: ImageContent): Json {
	return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

function userBlocks(content: string | (TextContent | ImageContent)[]): string | Json[] {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? { type: "text", text: part.text } : imageBlock(part)));
}

function stopReason(message: AssistantMessage): string | null {
	switch (message.stopReason) {
		case "toolUse":
			return "tool_use";
		case "length":
			return "max_tokens";
		case "stop":
			return "end_turn";
		default:
			return null;
	}
}

function usageOf(message: AssistantMessage): Json {
	return {
		input_tokens: message.usage.input,
		output_tokens: message.usage.output,
		cache_read_input_tokens: message.usage.cacheRead,
		cache_creation_input_tokens: message.usage.cacheWrite,
	};
}

interface ToolCallInfo {
	piName: string;
	args: Json;
}

class Translator {
	readonly toolCalls = new Map<string, ToolCallInfo>();
	/** Whether the file of a write call existed when it ran, by tool call id; only live calls have one (tool_call). */
	readonly existedBefore = new Map<string, boolean>();

	constructor(
		readonly sessionId: string,
		/** The session's working directory, which /resume can change. */
		public cwd: string,
	) {}

	user(message: UserMessage, uuid: string): Json {
		return {
			type: "user",
			message: { role: "user", content: userBlocks(message.content) },
			parent_tool_use_id: null,
			uuid,
			session_id: this.sessionId,
			timestamp: new Date(message.timestamp).toISOString(),
		};
	}

	assistant(message: AssistantMessage, uuid: string): Json {
		const content: Json[] = [];
		for (const part of message.content) {
			if (part.type === "text") {
				if (part.text) content.push({ type: "text", text: part.text });
			} else if (part.type === "thinking") {
				if (part.redacted) content.push({ type: "redacted_thinking", data: part.thinkingSignature ?? "" });
				else if (part.thinking) content.push({ type: "thinking", thinking: part.thinking, signature: part.thinkingSignature ?? "" });
			} else if (part.type === "toolCall") {
				this.toolCalls.set(part.id, { piName: part.name, args: part.arguments as Json });
				content.push({ type: "tool_use", id: part.id, name: claudeToolName(part.name), input: toClaudeInput(part.name, part.arguments as Json, this.cwd) });
			}
		}
		if (content.length === 0 && message.errorMessage) content.push({ type: "text", text: message.errorMessage });
		return {
			type: "assistant",
			message: {
				id: message.responseId ?? `msg_${uuid.replace(/-/g, "").slice(0, 24)}`,
				type: "message",
				role: "assistant",
				model: message.model,
				content,
				stop_reason: stopReason(message),
				stop_sequence: null,
				usage: usageOf(message),
			},
			parent_tool_use_id: null,
			uuid,
			session_id: this.sessionId,
			timestamp: new Date(message.timestamp).toISOString(),
			...(message.stopReason === "aborted" && { aborted: true }),
		};
	}

	toolResult(message: ToolResultMessage, uuid: string): Json {
		const blocks: Json[] = message.content.map((part) => (part.type === "text" ? { type: "text", text: part.text } : imageBlock(part)));
		const call = this.toolCalls.get(message.toolCallId);
		const existed = this.existedBefore.get(message.toolCallId);
		this.toolCalls.delete(message.toolCallId);
		this.existedBefore.delete(message.toolCallId);
		let toolUseResult: unknown;
		if (call && !message.isError) {
			const claudeInput = toClaudeInput(call.piName, call.args, this.cwd);
			toolUseResult = toClaudeResponse(call.piName, claudeInput, textOf(message.content), message.details, existed);
		}
		return {
			type: "user",
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: blocks, is_error: message.isError }],
			},
			parent_tool_use_id: null,
			uuid,
			session_id: this.sessionId,
			timestamp: new Date(message.timestamp).toISOString(),
			...(toolUseResult !== undefined && { tool_use_result: toolUseResult }),
		};
	}

	/**
	 * A compaction as Claude Code reports it: the boundary, which the app shows as "Conversation compacted", and the
	 * summary the model reads in place of the conversation before it, as a synthetic user message.
	 */
	compaction(entry: CompactionEntry, meta: { trigger: "manual" | "auto"; postTokens?: number; durationMs?: number }): Json[] {
		const seed = `${this.sessionId}:${entry.id}`;
		return [
			{
				type: "system",
				subtype: "compact_boundary",
				compact_metadata: {
					trigger: meta.trigger,
					pre_tokens: entry.tokensBefore,
					...(meta.postTokens !== undefined && { post_tokens: meta.postTokens }),
					...(meta.durationMs !== undefined && { duration_ms: meta.durationMs }),
				},
				uuid: uuidFor(seed),
				session_id: this.sessionId,
			},
			{
				type: "user",
				message: { role: "user", content: [{ type: "text", text: entry.summary }] },
				parent_tool_use_id: null,
				isSynthetic: true,
				uuid: uuidFor(`${seed}:summary`),
				session_id: this.sessionId,
				timestamp: new Date(entry.timestamp).toISOString(),
			},
		];
	}

	/** One SDK message for a conversation message, or undefined for the kinds the app does not show. */
	convert(message: AgentMessage, uuid: string): Json | undefined {
		switch (message.role) {
			case "user":
				return this.user(message as UserMessage, uuid);
			case "assistant":
				return this.assistant(message as AssistantMessage, uuid);
			case "toolResult":
				return this.toolResult(message as ToolResultMessage, uuid);
			default:
				return undefined;
		}
	}
}

// --- Plan usage -------------------------------------------------------------------------------------------------------

/** A 5-hour or weekly window of the claude.ai plan, from the usage endpoint's answer. */
interface PlanWindow {
	type: "five_hour" | "seven_day";
	percent: number;
	/** Unix epoch seconds. */
	resetsAt?: number;
	severity?: string;
	/** The endpoint's headline pick, the row a single-value indicator shows. */
	active: boolean;
}

function epochSeconds(iso: unknown): number | undefined {
	if (typeof iso !== "string") return undefined;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** The session and weekly windows: from the endpoint's limit rows, else, when it sent none, from the status line's rows. */
function planWindows(snapshot: UsageSnapshot): PlanWindow[] {
	const rows = snapshot.answer.limits;
	if (Array.isArray(rows)) {
		const windows: PlanWindow[] = [];
		for (const row of rows as Json[]) {
			const type = row.kind === "session" ? "five_hour" : row.kind === "weekly_all" ? "seven_day" : undefined;
			if (!type || typeof row.percent !== "number") continue;
			const severity = typeof row.severity === "string" ? row.severity : undefined;
			windows.push({ type, percent: row.percent, resetsAt: epochSeconds(row.resets_at), severity, active: row.is_active === true });
		}
		return windows;
	}
	return snapshot.limits.flatMap((row): PlanWindow[] => {
		const type = row.label === "5h" ? "five_hour" : row.label === "7d" ? "seven_day" : undefined;
		return type ? [{ type, percent: row.percent, resetsAt: epochSeconds(row.resetsAt), active: false }] : [];
	});
}

/**
 * Claude Code's rate_limit_info (SDKRateLimitInfo): the limiting window (a full one, else the fullest the endpoint
 * warns about, else its headline pick) with its state and use, and both windows as unifiedWindows (use as a fraction,
 * resets in epoch seconds). Claude Code reads these from the anthropic-ratelimit-unified-* response headers, which Pi
 * does not see; the state follows the usage endpoint instead: rejected at 100 %, allowed_warning while it grades a
 * window warning or critical.
 */
function rateLimitInfo(snapshot: UsageSnapshot): Json | undefined {
	const windows = planWindows(snapshot);
	if (windows.length === 0) return undefined;
	const fullest = (list: PlanWindow[]) => list.reduce<PlanWindow | undefined>((a, b) => (!a || b.percent > a.percent ? b : a), undefined);
	const full = fullest(windows.filter((w) => w.percent >= 100));
	const warned = fullest(windows.filter((w) => w.severity === "warning" || w.severity === "critical"));
	const head = full ?? warned ?? windows.find((w) => w.active) ?? fullest(windows)!;
	const unified: Json = {};
	for (const w of windows) if (w.resetsAt !== undefined) unified[w.type] = { utilization: w.percent / 100, resetsAt: w.resetsAt };
	return {
		status: full ? "rejected" : warned ? "allowed_warning" : "allowed",
		...(head.resetsAt !== undefined && { resetsAt: head.resetsAt }),
		rateLimitType: head.type,
		utilization: head.percent / 100,
		isUsingOverage: false,
		...(Object.keys(unified).length > 0 && { unifiedWindows: unified }),
	};
}

/** A window of the get_usage reply: the use 0-100 and the reset as ISO 8601, as the endpoint sends them. */
function usageWindow(value: unknown): Json | null {
	if (!value || typeof value !== "object") return null;
	const w = value as Json;
	return { utilization: typeof w.utilization === "number" ? w.utilization : null, resets_at: typeof w.resets_at === "string" ? w.resets_at : null };
}

/** The rate_limits of Claude Code's get_usage reply (SDKControlGetUsageResponse), from the usage endpoint's answer. */
function planRateLimits(snapshot: UsageSnapshot): Json {
	const answer = snapshot.answer;
	const limits: Json = {};
	for (const key of ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"]) {
		if (key in answer) limits[key] = usageWindow(answer[key]);
	}
	if (Array.isArray(answer.limits)) {
		limits.model_scoped = (answer.limits as Json[])
			.filter((row) => row.kind === "weekly_scoped")
			.flatMap((row) => {
				const scope = row.scope as Record<string, Json | null | undefined> | null | undefined;
				const name = scope?.model?.display_name ?? scope?.surface?.display_name;
				if (typeof name !== "string") return [];
				return [{ display_name: name, utilization: typeof row.percent === "number" ? row.percent : null, resets_at: typeof row.resets_at === "string" ? row.resets_at : null }];
			});
	}
	const extra = answer.extra_usage as Json | null | undefined;
	if (extra && typeof extra === "object") {
		const amount = (value: unknown) => (typeof value === "number" ? value : null);
		limits.extra_usage = {
			is_enabled: extra.is_enabled === true,
			monthly_limit: amount(extra.monthly_limit),
			used_credits: amount(extra.used_credits),
			utilization: amount(extra.utilization),
			currency: typeof extra.currency === "string" ? extra.currency : null,
		};
	} else if (extra === null) {
		limits.extra_usage = null;
	}
	return limits;
}

/** The plan as Claude Code's login names it (pro, max, team, enterprise), or null. */
async function subscriptionType(): Promise<string | null> {
	try {
		const type = (await claudeCodeCredentials())?.claudeAiOauth?.subscriptionType;
		return typeof type === "string" && type ? type : null;
	} catch {
		return null;
	}
}

/** Lines an edit added and removed, from the hunks of its unified patch. */
function patchLines(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	let inHunk = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("@@")) inHunk = true;
		else if (!inHunk) continue;
		else if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

// --- Questions --------------------------------------------------------------------------------------------------------

const QUESTIONS_OPEN = "ask-user-question:open";
const QUESTIONS_CLOSE = "ask-user-question:close";

/** ask-user-question.ts's open dialog (its QuestionsOpen); answer and decline return false once it was settled. */
interface QuestionsOpen {
	toolCallId: string;
	questions: Json[];
	answer(answers: Record<string, string>, annotations?: Json): boolean;
	decline(message?: string): boolean;
}

/** ask-user-question.ts's QuestionsClose: answers by question text, absent when dismissed or withdrawn. */
interface QuestionsClose {
	toolCallId: string;
	answers?: Record<string, string>;
}

interface PendingQuestions {
	open: QuestionsOpen;
	/** The can_use_tool request that carries the questions to the app, and the transport it went out on. */
	requestId?: string;
	handle?: BridgeHandle;
	/** The app answered: nothing to withdraw there. */
	answered?: boolean;
}

// --- The connection ---------------------------------------------------------------------------------------------------

/** The bridge callbacks of the runtime that owns a connection. */
interface Router {
	inbound(message: Json): void | Promise<void>;
	permissionResponse(response: Json): boolean;
	interrupt(): void;
	setModel(model: string | undefined): Verdict | Promise<Verdict>;
	setMaxThinkingTokens(tokens: number | null | undefined): Verdict;
	applyFlagSettings(settings: FlagSettings): Verdict;
	contextUsage(): Promise<Json>;
	usage(): Promise<Json>;
	initializeState(): Json;
	rename(title: string): Verdict;
	sideQuestion(request: { question: string; history?: { question: string; response: string }[] }, signal: AbortSignal, onProgress: (progress: Json) => void): Promise<{ response: string | null; synthetic: boolean }>;
	stopTask(taskId: string): Promise<Json>;
	close(code?: number): void;
}

interface Connection {
	sessionId: string;
	url: string;
	title: string;
	/** The Claude Code version of the SDK, sent as User-Agent and in the init message. */
	version: string;
	handle: BridgeHandle;
	translator: Translator;
	credentials: RemoteCredentials;
	/** When the worker credential was minted; expires_in counts from here. */
	credentialsAt: number;
	refreshTimer: NodeJS.Timeout | null;
	/** The running recovery loop's token; a loop whose token is no longer here stops. */
	recovery: object | null;
	recoveryAttempt: number;
	closing: boolean;
	/** Init and history have gone out. */
	started: boolean;
	/** A run started and has not settled yet. */
	running: boolean;
	runStartedAt: number;
	runMessages: AgentMessage[];
	/** Null while the connection is parked between two runtimes. */
	router: Router | null;
	/** App messages that arrived while parked, delivered by the runtime that takes the connection over. */
	pending: Json[];
	/** The transport closed while parked: the next owner handles it. */
	pendingClose?: { code?: number };
	/**
	 * Set while this connection mints a new worker credential (recover, reattach): the token of the latest mint. The server
	 * then supersedes the current transport, and a request it makes before it is replaced ends it with close 4090: this
	 * connection's own doing, not another process. Such a close waits in heldClose until the latest mint settles it.
	 */
	epochMove?: object;
	heldClose?: { code?: number };
	/** Prompts that came from the app and are about to appear as Pi user messages: not sent back. */
	inbound: string[];
	/** The title the app set last, so its own rename is not sent back as a change. */
	remoteTitle?: string;
	/** Model and effort as last reported to the app (worker metadata), so only changes are sent. */
	reportedModel?: string;
	reportedEffort?: string;
	/** Context usage and rate limit info as last reported to the app (JSON), so only changes are sent. */
	reportedContext?: string;
	reportedRateLimits?: string;
	/** The effort the app set last, kept through a model switch from the app; a level set elsewhere clears it. */
	appEffort?: string;
	/** The CODE_VERSION that attached the bridge handle; absent for handles older code attached. */
	codeVersion?: string;
	/** A compaction under way: since when, and whether it is a turn of its own in the app (it began outside a run). */
	compacting?: { startedAt: number; turn: boolean };
}

interface Shared {
	/** A connection handed over at session_shutdown that no runtime has taken yet. */
	parked: { connection: Connection; timer: NodeJS.Timeout } | null;
	/** Takes over a connection whose connect finished after its runtime was replaced; set by the live runtime. */
	adopt: ((c: Connection) => void) | null;
	connecting: boolean;
}

function shared(): Shared {
	const store = globalThis as unknown as Record<symbol, Shared | undefined>;
	return (store[SHARED_KEY] ??= { parked: null, adopt: null, connecting: false });
}

const SWITCHING: Extract<Verdict, { ok: false }> = { ok: false, error: "Pi is switching sessions; try again in a moment." };

/**
 * The options that attach the bridge for c. The callbacks outlive the runtime that attaches: they reach Pi only through
 * c.router, the owner's. The bridge keeps them for the life of the handle, so one this list lacks stays missing until
 * the bridge is attached anew (reattach).
 */
function bridgeOptions(c: Connection, credentials: RemoteCredentials, initialSequenceNum?: number): Parameters<BridgeModule["attachBridgeSession"]>[0] {
	return {
		sessionId: c.sessionId,
		ingressToken: credentials.worker_jwt,
		apiBaseUrl: credentials.api_base_url,
		epoch: credentials.worker_epoch,
		...(initialSequenceNum !== undefined && { initialSequenceNum }),
		claudeCodeVersion: c.version,
		onInboundMessage: (message) => {
			if (c.closing) return;
			if (c.router) return c.router.inbound(message);
			c.pending.push(message);
		},
		onPermissionResponse: (response) => c.router?.permissionResponse(response) ?? false,
		onInterrupt: () => c.router?.interrupt(),
		onSetModel: (model) => c.router?.setModel(model) ?? SWITCHING,
		onSetMaxThinkingTokens: (tokens) => c.router?.setMaxThinkingTokens(tokens) ?? SWITCHING,
		onApplyFlagSettings: (settings) => c.router?.applyFlagSettings(settings) ?? SWITCHING,
		onGetContextUsage: () => c.router?.contextUsage() ?? Promise.reject(new Error(SWITCHING.error)),
		answerSharedControlRequest: (request) => {
			if (request.subtype !== "get_usage") return undefined;
			const answer = c.router?.usage() ?? Promise.reject(new Error(SWITCHING.error));
			return answer.then((response) => ({ subtype: "success" as const, response }));
		},
		getInitializeState: () => c.router?.initializeState() ?? { current_model: c.reportedModel ?? null, current_permission_mode: "default" },
		onSetPermissionMode: (mode) => (mode === "default" ? { ok: true } : { ok: false, error: "Pi has no permission modes; tools run as configured in the terminal." }),
		onRenameSession: (title) => c.router?.rename(title) ?? SWITCHING,
		onSideQuestion: (request, { signal, onProgress }) => c.router?.sideQuestion(request, signal, onProgress) ?? Promise.reject(new Error(SWITCHING.error)),
		onStopTask: (taskId) => c.router?.stopTask(taskId) ?? Promise.reject(new Error(SWITCHING.error)),
		onClose: (code) => {
			if (c.closing) return;
			if (c.epochMove) c.heldClose ??= { code };
			else deliverClose(c, code);
		},
	};
}

/** A close of c's transport, to the runtime that owns c, else kept for the next owner. */
function deliverClose(c: Connection, code?: number): void {
	if (c.closing) return;
	if (c.router) c.router.close(code);
	else c.pendingClose = { code };
}

/** Starts a credential mint of c: until it ends, a close of c's transport is held (see Connection.epochMove). */
function beginEpochMove(c: Connection): object {
	const move = {};
	c.epochMove = move;
	return move;
}

/**
 * Ends a credential mint of c. A later mint, which supersedes this one's credential too, settles what was held instead.
 * replaced: the transport the mint superseded is gone, so a close it held is moot. Otherwise a mint that succeeded
 * leaves a superseded transport, now or at its next request, and goes on as a plain close, so recovery rebuilds it;
 * one that failed delivers a held close as it came.
 */
function endEpochMove(c: Connection, move: object, replaced: boolean, minted: boolean): void {
	if (c.epochMove !== move) return;
	c.epochMove = undefined;
	const held = c.heldClose;
	c.heldClose = undefined;
	if (replaced || c.closing) return;
	if (minted) deliverClose(c);
	else if (held) deliverClose(c, held.code);
}

// A copy of BtwAsk from btw.ts, the event-bus contract between the two: change both alike.
/** "btw:ask" on the event bus: a side question and the asker's earlier ones; accepted is set at once by the listener. */
interface BtwAsk {
	question: string;
	history?: { question: string; response: string }[];
	signal?: AbortSignal;
	accepted?: boolean;
	reply?: (result: { answer?: string; error?: string }) => void;
}

// A copy of PlanUsageSource, UsageSnapshot from claude-usage.ts, the event-bus contract between the two, the part
// read here: change both alike.
interface LimitRow {
	label: string;
	percent: number;
	resetsAt: string | null;
}

interface UsageSnapshot {
	limits: LimitRow[];
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
interface PlanUsageSource {
	/** The plan's id, "claude" here; "plan-usage:changed" names it. */
	id: string;
	/** Whether the plan's limits apply to a model, so a consumer picks the source of the model in use. */
	appliesTo(model: { provider: string; id: string } | undefined): boolean;
	/** The latest answer younger than USAGE_MAX_AGE_MS, or null. */
	snapshot(): UsageSnapshot | null;
	/** Asks the endpoint unless the shared answer is younger than USAGE_TTL_MS; settles once that is done. */
	refresh(): Promise<void>;
}

// A copy of SubagentView from subagents.ts, the event-bus contract between the two, the part read here: change both
// alike.
/** What other extensions see of a subagent ("subagents:state" on the event bus). */
interface SubagentView {
	agentId: string;
	type: string;
	description: string;
	status: "running" | "completed" | "failed" | "aborted";
	background: boolean;
	model: string;
	startedAt: number;
	durationMs?: number;
	tokens: number;
	toolCount: number;
	lastTool?: string;
	error?: string;
}

// A copy of ClaudeLoginSource from claude-login.ts, the event-bus contract between the two: change both alike.
/** What "claude-login:source" carries. */
interface ClaudeLoginSource {
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
interface ClaudeLoginToken {
	value: string;
	renewed: boolean;
}

/**
 * What token() answers without one: no valid login, a login that reached its time limit and needs /login in Claude
 * Code, or a login of another account than CLAUDE_CODE_OAUTH_TOKEN.
 */
interface ClaudeLoginRefusal {
	value?: undefined;
	reason: "none" | "ended" | "other-account";
}

/**
 * Claude Code <-> Pi tool names and inputs, shared by the extensions that speak Claude Code's formats (subagent
 * definitions, Remote Control).
 *
 * claude-code-agents.ts carries a copy of a part of this block: change them alike.
 */
/** Pi tool name -> Claude Code tool name. Tools without an entry keep their name (MCP tools, other extension tools). */
const PI_TO_CLAUDE: Record<string, string> = {
	bash: "Bash",
	powershell: "PowerShell",
	read: "Read",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
	web_fetch: "WebFetch",
	fetch_content: "WebFetch",
	web_search: "WebSearch",
	tool_search: "ToolSearch",
	agent: "Agent",
	ask_user_question: "AskUserQuestion",
	cron_create: "CronCreate",
	cron_list: "CronList",
	cron_delete: "CronDelete",
	schedule_wakeup: "ScheduleWakeup",
	list_agents: "ListAgents",
	send_message: "SendMessage",
};

function claudeToolName(piName: string): string {
	return PI_TO_CLAUDE[piName] ?? piName;
}

type Input = Record<string, unknown>;

function absolute(cwd: string, value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
	return path.resolve(cwd, expanded);
}

/** The `tool_input` Claude Code would send to a hook for this Pi tool call. File paths are absolute, as there. */
function toClaudeInput(piName: string, input: Input, cwd: string): Input {
	switch (piName) {
		case "bash":
		case "powershell": {
			const out: Input = { command: input.command ?? "", description: input.description ?? "" };
			if (typeof input.timeout === "number") out.timeout = Math.round(input.timeout * 1000);
			return out;
		}
		case "read":
			return { file_path: absolute(cwd, input.path), offset: input.offset, limit: input.limit };
		case "write":
			return { file_path: absolute(cwd, input.path), content: input.content ?? "" };
		case "edit": {
			const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [];
			const out: Input = {
				file_path: absolute(cwd, input.path),
				edits: edits.map((e) => ({ old_string: e.oldText ?? "", new_string: e.newText ?? "" })),
				replace_all: false,
			};
			if (edits.length === 1) {
				out.old_string = edits[0].oldText ?? "";
				out.new_string = edits[0].newText ?? "";
			}
			return out;
		}
		case "grep": {
			const out: Input = { pattern: input.pattern ?? "", output_mode: "content" };
			if (input.path !== undefined) out.path = absolute(cwd, input.path);
			if (input.glob !== undefined) out.glob = input.glob;
			if (input.ignoreCase) out["-i"] = true;
			if (typeof input.context === "number") out["-C"] = input.context;
			if (typeof input.limit === "number") out.head_limit = input.limit;
			return out;
		}
		case "find": {
			const out: Input = { pattern: input.pattern ?? "" };
			if (input.path !== undefined) out.path = absolute(cwd, input.path);
			return out;
		}
		case "ls":
			return { path: absolute(cwd, input.path ?? ".") };
		case "web_search": {
			const queries = Array.isArray(input.queries) ? input.queries : [];
			return { ...input, query: input.query ?? queries[0] ?? "" };
		}
		default:
			return { ...input };
	}
}

/** The `tool_response` Claude Code would send to a PostToolUse hook, as far as Pi's result allows. */
function toClaudeResponse(
	piName: string,
	claudeInput: Input,
	text: string,
	details: unknown,
	existedBefore: boolean | undefined,
): unknown {
	switch (piName) {
		case "bash":
		case "powershell":
			return { stdout: text, stderr: "", interrupted: false, isImage: false };
		case "write":
			return {
				type: existedBefore ? "update" : "create",
				filePath: claudeInput.file_path,
				content: claudeInput.content,
			};
		case "edit": {
			const patch = (details as { patch?: unknown } | undefined)?.patch;
			return {
				filePath: claudeInput.file_path,
				oldString: claudeInput.old_string,
				newString: claudeInput.new_string,
				replaceAll: false,
				userModified: false,
				...(typeof patch === "string" ? { patch } : {}),
			};
		}
		case "read":
			return { type: "text", file: { filePath: claudeInput.file_path, content: text } };
		default:
			return text;
	}
}

/**
 * Framed, scrollable boxes for the extensions that show more than a notification can hold: overlays for /agents,
 * /cron, and /memory, and the frame and scrolling of the boxes /btw and the /diff dialog show above the prompt.
 *
 * background-agents.ts, btw.ts, diff.ts, memory.ts, scheduled-tasks.ts, subagents.ts carry a copy of this block, or of
 * a part of it: change them alike.
 */
/** Draws a rounded frame around `body`, with `title` in the top edge and `help` (the keys) as its last line. */
function frame(theme: Theme, width: number, title: string, body: string[], help: string): string[] {
	const inner = Math.max(1, width - 4);
	const border = (s: string) => theme.fg("border", s);
	const head = truncateToWidth(` ${title} `, Math.max(1, width - 4), "…");
	const lines = [border("╭─") + theme.fg("accent", head) + border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(head)))}╮`)];
	// The keys go inside the frame: below it, an overlay has no background and the line blends into the transcript.
	for (const line of [...body, "", help]) lines.push(`${border("│")} ${truncateToWidth(line, inner, "…", true)} ${border("│")}`);
	lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
	return lines;
}

/**
 * QR code encoder for the terminal: byte mode, any error correction level, versions 1–40, mask chosen by the standard
 * penalty score. A port of the public-domain algorithm of Project Nayuki's QR Code generator, reduced to what the
 * extensions need (the session link of /remote-control).
 */
type EccLevel = "L" | "M" | "Q" | "H";

const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Indexed by version (index 0 unused), per error correction level.
const ECC_CODEWORDS_PER_BLOCK: Record<EccLevel, number[]> = {
	L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
	Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const NUM_ERROR_CORRECTION_BLOCKS: Record<EccLevel, number[]> = {
	L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
	M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
	Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
	H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** A QR symbol: `modules[y][x]` is true for a dark module. */
interface QrCode {
	version: number;
	size: number;
	mask: number;
	modules: boolean[][];
}

function numRawDataModules(version: number): number {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const numAlign = Math.floor(version / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (version >= 7) result -= 36;
	}
	return result;
}

function numDataCodewords(version: number, ecl: EccLevel): number {
	return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][version] * NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
}

// --- Reed–Solomon over GF(2^8) with the QR polynomial 0x11D -------------------------------------------------------

function gfMultiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

function rsDivisor(degree: number): number[] {
	const result = new Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = gfMultiply(result[j], root);
			if (j + 1 < result.length) result[j] ^= result[j + 1];
		}
		root = gfMultiply(root, 0x02);
	}
	return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
	const result = divisor.map(() => 0);
	for (const b of data) {
		const factor = b ^ (result.shift() as number);
		result.push(0);
		divisor.forEach((coef, i) => {
			result[i] ^= gfMultiply(coef, factor);
		});
	}
	return result;
}

function addEccAndInterleave(data: number[], version: number, ecl: EccLevel): number[] {
	const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
	const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][version];
	const rawCodewords = Math.floor(numRawDataModules(version) / 8);
	const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
	const shortBlockLen = Math.floor(rawCodewords / numBlocks);

	const blocks: number[][] = [];
	const divisor = rsDivisor(blockEccLen);
	for (let i = 0, k = 0; i < numBlocks; i++) {
		const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
		k += dat.length;
		const ecc = rsRemainder(dat, divisor);
		if (i < numShortBlocks) dat.push(0);
		blocks.push(dat.concat(ecc));
	}

	const result: number[] = [];
	for (let i = 0; i < blocks[0].length; i++) {
		blocks.forEach((block, j) => {
			if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
		});
	}
	return result;
}

// --- Symbol construction ------------------------------------------------------------------------------------------

function alignmentPatternPositions(version: number, size: number): number[] {
	if (version === 1) return [];
	const numAlign = Math.floor(version / 7) + 2;
	const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
	const result = [6];
	for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
	return result;
}

class Builder {
	readonly size: number;
	readonly modules: boolean[][];
	readonly isFunction: boolean[][];

	constructor(
		readonly version: number,
		readonly ecl: EccLevel,
	) {
		this.size = version * 4 + 17;
		this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
		this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
	}

	setFunction(x: number, y: number, dark: boolean): void {
		this.modules[y][x] = dark;
		this.isFunction[y][x] = true;
	}

	drawFunctionPatterns(): void {
		for (let i = 0; i < this.size; i++) {
			this.setFunction(6, i, i % 2 === 0);
			this.setFunction(i, 6, i % 2 === 0);
		}
		this.drawFinder(3, 3);
		this.drawFinder(this.size - 4, 3);
		this.drawFinder(3, this.size - 4);

		const positions = alignmentPatternPositions(this.version, this.size);
		const last = positions.length - 1;
		for (let i = 0; i < positions.length; i++) {
			for (let j = 0; j < positions.length; j++) {
				if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
				this.drawAlignment(positions[i], positions[j]);
			}
		}
		this.drawFormatBits(0);
		this.drawVersion();
	}

	private drawFinder(x: number, y: number): void {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const xx = x + dx;
				const yy = y + dy;
				if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunction(xx, yy, dist !== 2 && dist !== 4);
			}
		}
	}

	private drawAlignment(x: number, y: number): void {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
	}

	drawFormatBits(mask: number): void {
		const data = (ECC_FORMAT_BITS[this.ecl] << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((data << 10) | rem) ^ 0x5412;
		const bit = (i: number) => ((bits >>> i) & 1) !== 0;

		for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
		this.setFunction(8, 7, bit(6));
		this.setFunction(8, 8, bit(7));
		this.setFunction(7, 8, bit(8));
		for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));

		for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
		this.setFunction(8, this.size - 8, true);
	}

	private drawVersion(): void {
		if (this.version < 7) return;
		let rem = this.version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const bits = (this.version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const bit = ((bits >>> i) & 1) !== 0;
			const a = this.size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			this.setFunction(a, b, bit);
			this.setFunction(b, a, bit);
		}
	}

	drawCodewords(data: number[]): void {
		let i = 0;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < this.size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? this.size - 1 - vert : vert;
					if (!this.isFunction[y][x] && i < data.length * 8) {
						this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
						i++;
					}
				}
			}
		}
	}

	applyMask(mask: number): void {
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				let invert: boolean;
				switch (mask) {
					case 0:
						invert = (x + y) % 2 === 0;
						break;
					case 1:
						invert = y % 2 === 0;
						break;
					case 2:
						invert = x % 3 === 0;
						break;
					case 3:
						invert = (x + y) % 3 === 0;
						break;
					case 4:
						invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
						break;
					case 5:
						invert = ((x * y) % 2) + ((x * y) % 3) === 0;
						break;
					case 6:
						invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
						break;
					default:
						invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
				}
				if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
			}
		}
	}

	penaltyScore(): number {
		let result = 0;
		const size = this.size;
		const m = this.modules;

		for (let y = 0; y < size; y++) {
			let runColor = false;
			let runX = 0;
			const history = new Array<number>(7).fill(0);
			for (let x = 0; x < size; x++) {
				if (m[y][x] === runColor) {
					runX++;
					if (runX === 5) result += PENALTY_N1;
					else if (runX > 5) result++;
				} else {
					finderPenaltyAddHistory(runX, history, size);
					if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
					runColor = m[y][x];
					runX = 1;
				}
			}
			result += finderPenaltyTerminateAndCount(runColor, runX, history, size) * PENALTY_N3;
		}
		for (let x = 0; x < size; x++) {
			let runColor = false;
			let runY = 0;
			const history = new Array<number>(7).fill(0);
			for (let y = 0; y < size; y++) {
				if (m[y][x] === runColor) {
					runY++;
					if (runY === 5) result += PENALTY_N1;
					else if (runY > 5) result++;
				} else {
					finderPenaltyAddHistory(runY, history, size);
					if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
					runColor = m[y][x];
					runY = 1;
				}
			}
			result += finderPenaltyTerminateAndCount(runColor, runY, history, size) * PENALTY_N3;
		}

		for (let y = 0; y < size - 1; y++) {
			for (let x = 0; x < size - 1; x++) {
				const color = m[y][x];
				if (color === m[y][x + 1] && color === m[y + 1][x] && color === m[y + 1][x + 1]) result += PENALTY_N2;
			}
		}

		let dark = 0;
		for (const row of m) for (const cell of row) if (cell) dark++;
		const total = size * size;
		const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
		result += k * PENALTY_N4;
		return result;
	}
}

function finderPenaltyCountPatterns(history: number[]): number {
	const n = history[1];
	const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
	return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
}

function finderPenaltyTerminateAndCount(currentRunColor: boolean, currentRunLength: number, history: number[], size: number): number {
	if (currentRunColor) {
		finderPenaltyAddHistory(currentRunLength, history, size);
		currentRunLength = 0;
	}
	currentRunLength += size;
	finderPenaltyAddHistory(currentRunLength, history, size);
	return finderPenaltyCountPatterns(history);
}

function finderPenaltyAddHistory(currentRunLength: number, history: number[], size: number): void {
	if (history[0] === 0) currentRunLength += size;
	history.pop();
	history.unshift(currentRunLength);
}

/**
 * Encodes `text` (as UTF-8 bytes) at the smallest version that holds it with error correction `ecl`. `mask` forces a
 * mask pattern (0–7); otherwise the pattern with the lowest penalty score is used.
 */
function encodeQr(text: string, ecl: EccLevel = "M", mask = -1): QrCode {
	const bytes = [...Buffer.from(text, "utf8")];
	let version = 1;
	for (; ; version++) {
		const capacityBits = numDataCodewords(version, ecl) * 8;
		const countBits = version <= 9 ? 8 : 16;
		if (4 + countBits + bytes.length * 8 <= capacityBits) break;
		if (version >= 40) throw new Error("Text too long for a QR code");
	}

	const bits: number[] = [];
	const push = (value: number, length: number) => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	push(0x4, 4);
	push(bytes.length, version <= 9 ? 8 : 16);
	for (const b of bytes) push(b, 8);

	const capacityBits = numDataCodewords(version, ecl) * 8;
	push(0, Math.min(4, capacityBits - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let b = 0;
		for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
		data.push(b);
	}

	const builder = new Builder(version, ecl);
	builder.drawFunctionPatterns();
	builder.drawCodewords(addEccAndInterleave(data, version, ecl));

	if (mask < 0 || mask > 7) {
		let best = Number.POSITIVE_INFINITY;
		for (let i = 0; i < 8; i++) {
			builder.applyMask(i);
			builder.drawFormatBits(i);
			const penalty = builder.penaltyScore();
			if (penalty < best) {
				best = penalty;
				mask = i;
			}
			builder.applyMask(i);
		}
	}
	builder.applyMask(mask);
	builder.drawFormatBits(mask);

	return { version, size: builder.size, mask, modules: builder.modules };
}

/**
 * The code as terminal lines, two modules per row with half blocks, light modules white on black so that it reads
 * on any terminal theme. `quiet` is the border in modules on each side.
 */
function renderQr(code: QrCode, quiet = 2): string[] {
	const size = code.size + quiet * 2;
	const dark = (x: number, y: number): boolean => {
		const mx = x - quiet;
		const my = y - quiet;
		if (mx < 0 || my < 0 || mx >= code.size || my >= code.size) return false;
		return code.modules[my][mx];
	};
	const lines: string[] = [];
	for (let y = 0; y < size; y += 2) {
		let line = "";
		for (let x = 0; x < size; x++) {
			const top = dark(x, y);
			const bottom = y + 1 < size ? dark(x, y + 1) : true;
			line += top ? (bottom ? " " : "▄") : bottom ? "▀" : "█";
		}
		lines.push(`\x1b[97;40m${line}\x1b[0m`);
	}
	return lines;
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_DEPTH) return;

	let ctx: ExtensionContext | null = null;
	let connection: Connection | null = null;
	let version = "unknown";
	/** False once session_shutdown ran: this runtime is being replaced or the process quits. */
	let alive = true;
	let shutdownReason: string | undefined;
	/** ask_user_question dialogs open in this runtime, by tool call id. */
	const questions = new Map<string, PendingQuestions>();

	// After session_shutdown, pi and ctx of this runtime are stale and throw: the three stay silent then.
	const setStatus = (text: string | undefined) => {
		if (alive && ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
	};
	const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
		if (alive && ctx?.hasUI) ctx.ui.notify(text, level);
	};
	const note = (line: string) => {
		if (alive) pi.appendEntry(ENTRY_TYPE, { line });
	};
	/** Whether the session was connected when it was last open: its last remote-control-state entry. */
	const sessionConnected = (context: ExtensionContext): boolean => {
		let connected = false;
		for (const entry of context.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) connected = (entry.data as { connected?: boolean } | undefined)?.connected === true;
		}
		return connected;
	};
	const recordConnected = (connected: boolean) => {
		if (alive && ctx && sessionConnected(ctx) !== connected) pi.appendEntry(STATE_ENTRY, { connected });
	};

	// --- HTTP calls the SDK module does not export -------------------------------------------------------------------

	async function sessionRequest(method: "PUT" | "POST", sessionId: string, suffix: string, body: Json, timeoutMs: number): Promise<number | null> {
		const token = await accessToken(false);
		if ("reason" in token) return null;
		try {
			const response = await fetch(`${API_BASE_URL}/v1/code/sessions/${sessionId}${suffix}`, {
				method,
				headers: requestHeaders(token.value, version),
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			return response.status;
		} catch {
			return null;
		}
	}

	const archiveSession = (sessionId: string, timeoutMs: number) => sessionRequest("POST", sessionId, "/archive", {}, timeoutMs);

	/**
	 * Archives a remote session connect() created but could not use, and once more after RETRY_DELAYS_MS[0] when the
	 * server refuses or is not reached: the refusal that made it unusable can hit the archive too.
	 */
	function archiveUnused(sessionId: string): void {
		void archiveSession(sessionId, HTTP_TIMEOUT_MS).then((status) => {
			if (status !== null && status < 300) return;
			const again = setTimeout(() => void archiveSession(sessionId, HTTP_TIMEOUT_MS), RETRY_DELAYS_MS[0]);
			again.unref?.();
		});
	}
	const updateTitle = (sessionId: string, title: string) => sessionRequest("PUT", sessionId, "", { title }, HTTP_TIMEOUT_MS);

	/** The link the server names for the session (it carries an access key), else the one Claude Code builds itself. */
	async function fetchSessionUrl(sessionId: string, token: string): Promise<string> {
		const fallback = sessionUrl(sessionId);
		try {
			const response = await fetch(`${API_BASE_URL}/v1/code/sessions/${sessionId}`, {
				headers: requestHeaders(token, version),
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
			if (!response.ok) return fallback;
			const data = (await response.json()) as Json;
			const session = (data.response_shape ?? data.session ?? data) as Json;
			const url = session.session_url;
			return typeof url === "string" && url.startsWith(`${APP_URL}/`) ? url : fallback;
		} catch {
			return fallback;
		}
	}

	// --- Session title -------------------------------------------------------------------------------------------------

	function currentTitle(explicit?: string): string {
		if (explicit?.trim()) return shorten(explicit, MAX_TITLE_CHARS);
		const name = pi.getSessionName()?.trim();
		if (name) return shorten(name, MAX_TITLE_CHARS);
		const branch = ctx?.sessionManager.getBranch() ?? [];
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const text = shorten(textOf((entry.message as UserMessage).content), MAX_TITLE_CHARS);
			if (text) return text;
		}
		return generatedName();
	}

	// --- Outgoing ------------------------------------------------------------------------------------------------------

	function write(message: Json): void {
		const c = connection;
		if (!c || c.closing) return;
		try {
			c.handle.write(message);
		} catch {
			// the transport reports its own failures through onClose
		}
	}

	function writeInit(c: Connection): void {
		write({
			type: "system",
			subtype: "init",
			cwd: ctx?.cwd ?? process.cwd(),
			session_id: c.sessionId,
			tools: pi.getActiveTools().map(claudeToolName),
			mcp_servers: [],
			model: ctx?.model?.id ?? "",
			permissionMode: "default",
			slash_commands: [...new Set([...pi.getCommands().map((command) => command.name), ...[...APP_COMMANDS].filter((name) => name !== "clear")])],
			apiKeySource: "none",
			claude_code_version: version,
			output_style: "default",
			skills: pi.getCommands().filter((command) => command.source === "skill").map((command) => command.name.replace(/^skill:/, "")),
			plugins: [],
			agents: [],
			uuid: randomUUID(),
		});
	}

	function writeHistory(c: Connection): void {
		const branch = ctx?.sessionManager.getBranch() ?? [];
		const entries = branch.filter((entry) => entry.type === "message" || entry.type === "compaction").slice(-MAX_HISTORY_MESSAGES);
		for (const entry of entries) {
			if (entry.type === "compaction") {
				// The session file does not keep what triggered a compaction.
				for (const message of c.translator.compaction(entry, { trigger: "manual" })) write({ ...message, historical: true });
				continue;
			}
			if (entry.type !== "message") continue;
			const converted = c.translator.convert(entry.message, uuidFor(`${c.sessionId}:${entry.id}`));
			if (converted) write({ ...converted, historical: true });
		}
	}

	function writeResult(c: Connection, aborted: boolean): void {
		const assistants = c.runMessages.filter((m): m is AssistantMessage => m.role === "assistant");
		const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
		let cost = 0;
		for (const m of assistants) {
			usage.input_tokens += m.usage.input;
			usage.output_tokens += m.usage.output;
			usage.cache_read_input_tokens += m.usage.cacheRead;
			usage.cache_creation_input_tokens += m.usage.cacheWrite;
			cost += m.usage.cost.total;
		}
		const last = assistants.at(-1);
		write({
			type: "result",
			subtype: "success",
			is_error: !aborted && last?.stopReason === "error",
			duration_ms: Math.max(0, Date.now() - c.runStartedAt),
			duration_api_ms: assistants.reduce((sum, m) => sum + (m.durationMs ?? 0), 0),
			num_turns: assistants.length,
			result: "",
			stop_reason: last ? stopReason(last) : null,
			total_cost_usd: cost,
			usage,
			modelUsage: {},
			permission_denials: [],
			uuid: randomUUID(),
			session_id: c.sessionId,
		});
	}

	// --- Incoming ------------------------------------------------------------------------------------------------------

	async function downloadAttachment(attachment: Json): Promise<TextContent | ImageContent | null> {
		const uuid = typeof attachment.file_uuid === "string" ? attachment.file_uuid : "";
		if (!/^[A-Za-z0-9_-]+$/.test(uuid)) return null;
		const name = typeof attachment.file_name === "string" ? attachment.file_name : "attachment";
		const token = await accessToken(false);
		if ("reason" in token) return null;
		try {
			const response = await fetch(`${API_BASE_URL}/api/oauth/files/${encodeURIComponent(uuid)}/content`, {
				headers: { Authorization: `Bearer ${token.value}`, "User-Agent": `claude-code/${version}` },
				signal: AbortSignal.timeout(60_000),
			});
			if (!response.ok) return null;
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.length > MAX_ATTACHMENT_BYTES) return null;
			const mime = response.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream";
			if (attachment.is_image === true || mime.startsWith("image/")) return { type: "image", data: bytes.toString("base64"), mimeType: mime };
			const dir = path.join(os.tmpdir(), `pi-remote-control-${os.userInfo().uid}`);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const file = path.join(dir, `${uuid.slice(-8)}-${path.basename(name).replace(/[^\w.-]+/g, "_") || "file"}`);
			writeFileSync(file, bytes, { mode: 0o600 });
			return { type: "text", text: `[Attached file from the Claude app, saved at ${file}]` };
		} catch {
			return null;
		}
	}

	async function onInbound(message: Json): Promise<void> {
		const c = connection;
		if (!c || message.type !== "user") return;
		const inner = message.message as Json | undefined;
		const content = inner?.content;
		const parts: (TextContent | ImageContent)[] = [];
		if (typeof content === "string") {
			if (content.trim()) parts.push({ type: "text", text: content });
		} else if (Array.isArray(content)) {
			for (const block of content as Json[]) {
				if (block.type === "text" && typeof block.text === "string") parts.push({ type: "text", text: block.text });
				else if (block.type === "image") {
					const source = block.source as Json | undefined;
					if (source?.type === "base64" && typeof source.data === "string") {
						parts.push({ type: "image", data: source.data, mimeType: String(source.media_type ?? "image/png") });
					}
				}
			}
		}
		const attachments = Array.isArray(message.file_attachments) ? (message.file_attachments as Json[]).slice(0, 20) : [];
		let missing = 0;
		for (const attachment of attachments) {
			const part = await downloadAttachment(attachment);
			if (part) parts.push(part);
			else missing++;
		}
		if (missing) parts.push({ type: "text", text: `[${missing} of ${attachments.length} attachments did not arrive]` });
		if (parts.length === 0) return;

		const text = parts.map((part) => (part.type === "text" ? part.text : "")).join("\n").trim();
		const onlyText = parts.every((part) => part.type === "text");
		if (onlyText && text.startsWith("/") && (await runPiCommand(c, text))) return;
		const busy = !(ctx?.isIdle() ?? true);
		const deliverAs = busy && message.priority === "later" ? "followUp" : "steer";
		c.inbound.push(text);
		pi.sendUserMessage(onlyText ? text : parts, { deliverAs, expandPromptTemplates: text.startsWith("/") });
	}

	/**
	 * A command's output in the app's transcript, as an assistant message without usage: the mobile app shows neither a
	 * system notice nor a local_command_output, and the web app no local_command_output from the history. Outside a run
	 * it comes as a turn of its own, as a run does: running, the message, a result, and a moment later idle; the app
	 * shows a spinner after every message it sends until a turn ends. During a run, the run's result ends it.
	 */
	function tell(c: Connection, text: string): void {
		if (connection !== c) return;
		const turn = !c.running && (ctx?.isIdle() ?? true);
		if (turn) c.handle.reportState("running");
		const uuid = randomUUID();
		write({
			type: "assistant",
			message: {
				id: `msg_${uuid.replace(/-/g, "").slice(0, 24)}`,
				type: "message",
				role: "assistant",
				model: ctx?.model?.id ?? "",
				content: [{ type: "text", text }],
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
			parent_tool_use_id: null,
			uuid,
			session_id: c.sessionId,
			timestamp: new Date().toISOString(),
		});
		if (turn) endOwnTurn(c);
	}

	/** Ends a turn of the extension's own (tell, a compaction outside a run): a result without usage, a moment later idle. */
	function endOwnTurn(c: Connection, isError = false): void {
		write({
			type: "result",
			subtype: "success",
			is_error: isError,
			duration_ms: 0,
			duration_api_ms: 0,
			num_turns: 0,
			result: "",
			stop_reason: "end_turn",
			total_cost_usd: 0,
			usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			modelUsage: {},
			permission_denials: [],
			uuid: randomUUID(),
			session_id: c.sessionId,
		});
		setTimeout(() => {
			if (connection === c && !c.closing && !c.running && (ctx?.isIdle() ?? true)) c.handle.reportState("idle");
		}, 500).unref?.();
	}

	/**
	 * Pi's built-in commands from the app, which Pi itself only takes from its editor. Those without terminal UI run
	 * here; /new and /reload need a command context and borrow one from /remote-control; /clear is /new, as in Claude
	 * Code. The other built-ins get a notice instead of reaching the model as a prompt. /cron goes to scheduled-tasks.ts,
	 * whose answer (the task list, or what add or delete did) comes back to the app: in the terminal it would open the
	 * task manager, which the app never sees. Anything else (extension commands, skills, prompt templates) is not
	 * handled here and goes on as a prompt.
	 */
	async function runPiCommand(c: Connection, text: string): Promise<boolean> {
		const match = text.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
		if (!match) return false;
		const name = match[1];
		const args = (match[2] ?? "").trim();
		if (TERMINAL_COMMANDS.has(name)) {
			tell(c, `/${name} needs Pi's terminal; run it there.`);
			return true;
		}
		if (name === "cron") {
			const answer: { text?: string } = {};
			pi.events.emit("scheduled-tasks:command", { args, reply: (text: string) => (answer.text = text) });
			if (answer.text === undefined) return false;
			tell(c, answer.text);
			return true;
		}
		if (!APP_COMMANDS.has(name)) return false;
		switch (name) {
			case "compact":
				// The compaction is the answer (session_compact); a refusal (too little to compact) comes as text.
				ctx?.compact({
					...(args && { customInstructions: args }),
					onError: (error) => tell(c, /^compaction/i.test(error.message) ? error.message : `Compaction failed: ${error.message}`),
				});
				return true;
			case "name": {
				if (args) pi.setSessionName(args);
				const current = pi.getSessionName();
				tell(c, args ? `Session name set: ${current ?? args}` : current ? `Session name: ${current}` : "Usage: /name <name>");
				return true;
			}
			case "model": {
				if (!args) {
					tell(c, `Model: ${ctx?.model?.id ?? "none"}. /model <name> switches, e.g. to opus, sonnet, haiku, fable or a model id.`);
					return true;
				}
				const verdict = await onSetModel(args);
				tell(c, verdict.ok ? `Model: ${ctx?.model?.id ?? args}` : verdict.error);
				return true;
			}
			case "thinking": {
				const level = args.toLowerCase();
				if (level && !THINKING_LEVELS.includes(level)) {
					tell(c, `Unknown thinking level "${args}". Available levels: ${THINKING_LEVELS.join(", ")}.`);
					return true;
				}
				if (level) {
					c.appEffort = level;
					pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
				}
				tell(c, `Thinking level: ${pi.getThinkingLevel()}`);
				return true;
			}
			case "quit":
				tell(c, "Pi quits; the remote session is archived.");
				notify("The Claude app quits Pi.");
				ctx?.shutdown();
				return true;
			case "reload":
				if (!(ctx?.isIdle() ?? true)) {
					tell(c, "Pi reloads only between runs: wait for this one to end, or interrupt it.");
					return true;
				}
				break;
		}
		const command = name === "clear" ? "new" : name;
		tell(c, command === "new" ? "Pi starts a new session." : "Pi reloads its extensions, skills, prompts, themes and context files.");
		pi.sendUserMessage(`/remote-control ${APP_COMMAND_MARK}${command}`, { expandPromptTemplates: true });
		return true;
	}

	/** The second half of runPiCommand, inside the borrowed command context. */
	async function runAppCommand(name: string, command: ExtensionCommandContext): Promise<void> {
		if (name === "new") {
			notify("The Claude app starts a new session.");
			await command.newSession();
		} else if (name === "reload") {
			notify("The Claude app reloads Pi.");
			await command.reload();
		}
	}

	/**
	 * The model the app names, among the current provider's: an exact id, a dated id (claude-haiku-4-5-20251001), or a
	 * family (opus, sonnet, haiku, fable; opusplan counts as opus) for its newest model. A context suffix such as [1m] is
	 * dropped: Pi has one entry per model.
	 */
	async function onSetModel(requested: string | undefined): Promise<Verdict> {
		const current = ctx?.model;
		if (!ctx || !current) return { ok: false, error: "No model is active." };
		const wanted = requested?.trim();
		const lower = (wanted ?? "").toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/^opusplan$/, "opus");
		if (!lower || lower === "default") return { ok: true };
		const candidates = await ctx.modelRegistry.getAvailableOfType("chat", current.provider);
		const byLength = [...candidates].sort((a, b) => b.id.length - a.id.length);
		let found =
			candidates.find((m) => m.id.toLowerCase() === lower) ??
			byLength.find((m) => lower.startsWith(`${m.id.toLowerCase()}-`) && /^\d{8}$/.test(lower.slice(m.id.length + 1)));
		if (!found) {
			const family = candidates.filter((m) => m.id.toLowerCase().includes(lower));
			found = family.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
		}
		if (!found) return { ok: false, error: `Model "${wanted}" is not available on ${current.provider} in Pi.` };
		if (!isClaudeModel(found)) return { ok: false, error: `Remote Control stays with Claude models; "${found.id}" is not one.` };
		if (found.id === current.id) return { ok: true };
		const c = connection;
		const effort = c?.appEffort;
		if (!(await pi.setModel(found))) return { ok: false, error: `Pi has no credentials for ${found.provider}/${found.id}.` };
		if (c && effort) {
			c.appEffort = effort;
			if (pi.getThinkingLevel() !== effort) pi.setThinkingLevel(effort as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
		}
		return { ok: true };
	}

	/** Pi's startup thinking level for the current model: modelThinkingLevels, else defaultThinkingLevel, else medium. */
	function startupThinkingLevel(): string {
		const settings = pi.getSettings() as Json;
		const key = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
		const perModel = (settings.modelThinkingLevels as Json | undefined)?.[key];
		if (typeof perModel === "string") return perModel;
		return typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : "medium";
	}

	/** The app's effort control: a level sets Pi's thinking level of the same name, null (auto) Pi's startup level. */
	function onApplyFlagSettings(settings: FlagSettings): Verdict {
		if (settings.ultracode === true) return { ok: false, error: "Pi has no ultracode mode." };
		if (!("effortLevel" in settings)) return { ok: true };
		const level = settings.effortLevel === null || settings.effortLevel === undefined ? startupThinkingLevel() : settings.effortLevel.toLowerCase();
		if (!EFFORTS.has(level) && level !== "off" && level !== "minimal") return { ok: false, error: `Pi has no effort "${settings.effortLevel}".` };
		if (connection) connection.appEffort = settings.effortLevel === null || settings.effortLevel === undefined ? undefined : level;
		pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
		return { ok: true };
	}

	/**
	 * Model and effort in the worker metadata, as Claude Code reports them, so the app shows the current ones. Pi's off
	 * and minimal are below Claude Code's lowest effort and go out as low.
	 */
	function reportSettings(c: Connection, force = false, current: { model?: string; level?: string } = {}): void {
		const metadata: Json = {};
		const model = current.model ?? ctx?.model?.id;
		if (model && (force || model !== c.reportedModel)) metadata.model = c.reportedModel = model;
		const level = current.level ?? pi.getThinkingLevel();
		const effort = EFFORTS.has(level) ? level : "low";
		if (force || effort !== c.reportedEffort) metadata.effort_level = c.reportedEffort = effort;
		if (Object.keys(metadata).length === 0) return;
		try {
			c.handle.reportMetadata(metadata);
		} catch {
			// the transport reports its own failures through onClose
		}
	}

	function onSetMaxThinkingTokens(tokens: number | null | undefined): Verdict {
		if (tokens === undefined) return { ok: true };
		const level = tokens === null || tokens <= 0 ? "off" : tokens <= 1_024 ? "minimal" : tokens <= 4_096 ? "low" : tokens <= 10_000 ? "medium" : tokens <= 32_000 ? "high" : "xhigh";
		if (connection) connection.appEffort = level;
		pi.setThinkingLevel(level);
		return { ok: true };
	}

	/**
	 * The app's context card (SDKControlGetContextUsageResponse): Pi's estimate of the context in use, the compaction
	 * reserve when auto-compaction is on, and the free rest, laid out on Claude Code's grid of squares. A refusal leaves
	 * the card as it was.
	 */
	async function onGetContextUsage(): Promise<Json> {
		const estimate = contextEstimate();
		const model = ctx?.model;
		if (!ctx || !model || !estimate) throw new Error("Pi has no context usage for this session yet.");
		const window = estimate.window;
		const used = estimate.tokens;
		const compaction = (pi.getSettings() as Json).compaction as Json | undefined;
		const override = (compaction?.modelOverrides as Json | undefined)?.[`${model.provider}/${model.id}`] as Json | undefined;
		const autoCompact = compaction?.enabled !== false;
		const reserveSetting = override?.reserveTokens ?? compaction?.reserveTokens;
		const reserve = autoCompact ? Math.min(window, typeof reserveSetting === "number" ? reserveSetting : 16_384) : 0;
		const categories = [
			{ id: "messages", name: "Messages", tokens: used, color: "purple_FOR_SUBAGENTS_ONLY", kind: "used" },
			...(reserve > 0 ? [{ id: "autocompact_buffer", name: "Autocompact buffer", tokens: reserve, color: "inactive", kind: "buffer" }] : []),
			{ id: "free_space", name: "Free space", tokens: Math.max(0, window - used - reserve), color: "promptBorder", kind: "free" },
		];
		const columns = window >= 1_000_000 ? 20 : 10;
		const rows = 10;
		const total = columns * rows;
		const squaresOf = (tokens: number) => Math.min(total, Math.round((tokens / window) * total));
		const square = (category: (typeof categories)[number], fullness = 1) => ({
			color: category.color,
			isFilled: true,
			categoryName: category.name,
			tokens: category.tokens,
			percentage: Math.round((category.tokens / window) * 100),
			squareFullness: fullness,
		});
		const [messages, ...rest] = categories;
		const buffer = rest.find((category) => category.kind === "buffer");
		const free = rest.find((category) => category.kind === "free")!;
		const cells = Array.from({ length: used > 0 ? Math.max(1, squaresOf(used)) : 0 }, () => square(messages));
		const bufferSquares = buffer ? squaresOf(buffer.tokens) : 0;
		while (cells.length < total - bufferSquares) cells.push(square(free));
		while (buffer && cells.length < total) cells.push(square(buffer));
		const gridRows = Array.from({ length: rows }, (_, row) => cells.slice(row * columns, (row + 1) * columns));
		const branch = ctx.sessionManager.getBranch();
		let apiUsage: Json | null = null;
		for (let i = branch.length - 1; i >= 0 && !apiUsage; i--) {
			const entry = branch[i];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const u = (entry.message as AssistantMessage).usage;
			apiUsage = { input_tokens: u.input, output_tokens: u.output, cache_creation_input_tokens: u.cacheWrite, cache_read_input_tokens: u.cacheRead };
		}
		return {
			categories,
			totalTokens: used,
			maxTokens: window,
			rawMaxTokens: window,
			percentage: Math.round((used / window) * 100),
			gridRows,
			model: model.id,
			memoryFiles: [],
			mcpTools: [],
			agents: [],
			...(autoCompact ? { autoCompactThreshold: window - reserve } : {}),
			isAutoCompactEnabled: autoCompact,
			apiUsage,
		};
	}

	/**
	 * Pi's context estimate and window. After a compaction Pi has no estimate until the next response; the estimate of
	 * the compacted context stands in, the messages the model gets next, as Pi computes it for the compaction's result.
	 */
	function contextEstimate(): { tokens: number; window: number } | undefined {
		const usage = ctx?.getContextUsage();
		if (!ctx || !usage || usage.contextWindow <= 0) return undefined;
		if (usage.tokens !== null) return { tokens: usage.tokens, window: usage.contextWindow };
		try {
			const messages = ctx.sessionManager.buildSessionProjection().messages;
			return { tokens: messages.reduce((sum, message) => sum + estimateTokens(message), 0), window: usage.contextWindow };
		} catch {
			return undefined;
		}
	}

	/** Pi's context estimate as Claude Code's context_usage worker metadata, which the app's context indicator shows. */
	function reportContext(c: Connection, force = false): void {
		const estimate = contextEstimate();
		if (!estimate) return;
		const contextUsage = { used_tokens: estimate.tokens, max_tokens: estimate.window };
		const key = JSON.stringify(contextUsage);
		if (!force && key === c.reportedContext) return;
		c.reportedContext = key;
		try {
			c.handle.reportMetadata({ context_usage: contextUsage });
		} catch {
			// the transport reports its own failures through onClose
		}
	}

	// --- Plan usage ----------------------------------------------------------------------------------------------------

	/** The plan sources on the event bus by id (claude-usage.ts: "claude"). */
	const usageSources = new Map<string, PlanUsageSource>();
	/** The plan limits of the model in use; null without a source for it. */
	const usageSource = (): PlanUsageSource | null =>
		[...usageSources.values()].find((source) => source.appliesTo(ctx?.model ?? undefined)) ?? null;
	/** claude-login.ts, once it answered; without it a run-out login is not renewed. */
	let loginSource: ClaudeLoginSource | null = null;

	/** The plan limits as Claude Code forwards its rate limits: a rate_limit_event and rate_limit_info in the worker metadata. */
	function reportRateLimits(c: Connection, force = false): void {
		const snapshot = usageSource()?.snapshot();
		const info = snapshot ? rateLimitInfo(snapshot) : undefined;
		if (!info || c.closing) return;
		const key = JSON.stringify(info);
		if (!force && key === c.reportedRateLimits) return;
		c.reportedRateLimits = key;
		try {
			c.handle.write({ type: "rate_limit_event", rate_limit_info: info, uuid: randomUUID(), session_id: c.sessionId });
			c.handle.reportMetadata({
				rate_limit_info: { status: info.status, resetsAt: info.resetsAt ?? null, rateLimitType: info.rateLimitType ?? null, isUsingOverage: false },
			});
		} catch {
			// the transport reports its own failures through onClose
		}
	}

	/** The session part of the get_usage reply: Pi's totals over the current branch, which /new starts afresh. */
	function sessionUsage(): Json {
		interface ModelTotals {
			inputTokens: number;
			outputTokens: number;
			cacheReadInputTokens: number;
			cacheCreationInputTokens: number;
			webSearchRequests: number;
			costUSD: number;
			contextWindow: number;
			maxOutputTokens: number;
		}
		const models: Record<string, ModelTotals> = {};
		let cost = 0;
		let apiMs = 0;
		let added = 0;
		let removed = 0;
		let startedAt: number | undefined;
		for (const entry of ctx?.sessionManager.getBranch() ?? []) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			const timestamp = (message as { timestamp?: unknown }).timestamp;
			if (startedAt === undefined && typeof timestamp === "number") startedAt = timestamp;
			if (message.role === "assistant") {
				const m = message as AssistantMessage;
				const known = ctx?.modelRegistry.find(m.provider, m.model);
				const row = (models[m.model] ??= {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					webSearchRequests: 0,
					costUSD: 0,
					contextWindow: known?.contextWindow ?? 0,
					maxOutputTokens: known?.maxTokens ?? 0,
				});
				row.inputTokens += m.usage.input;
				row.outputTokens += m.usage.output;
				row.cacheReadInputTokens += m.usage.cacheRead;
				row.cacheCreationInputTokens += m.usage.cacheWrite;
				row.costUSD += m.usage.cost.total;
				cost += m.usage.cost.total;
				apiMs += m.durationMs ?? 0;
			} else if (message.role === "toolResult") {
				const r = message as ToolResultMessage;
				const patch = (r.details as Json | undefined)?.patch;
				if (r.toolName !== "edit" || r.isError || typeof patch !== "string") continue;
				const lines = patchLines(patch);
				added += lines.added;
				removed += lines.removed;
			}
		}
		return {
			total_cost_usd: cost,
			total_api_duration_ms: apiMs,
			total_duration_ms: startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt),
			total_lines_added: added,
			total_lines_removed: removed,
			model_usage: models,
		};
	}

	/**
	 * The app's usage card (SDKControlGetUsageResponse): Pi's totals of the session and the plan limits, asked afresh
	 * unless the shared answer is younger than five minutes. Without claude-usage.ts, or while the endpoint fails for an
	 * hour, rate_limits is null. behaviors, Claude Code's scan of its local transcripts, stays null.
	 */
	async function onGetUsage(): Promise<Json> {
		const source = usageSource();
		if (source) {
			await Promise.race([source.refresh().catch(() => {}), new Promise((resolve) => setTimeout(resolve, HTTP_TIMEOUT_MS).unref?.())]);
		}
		const snapshot = source?.snapshot() ?? null;
		return {
			session: sessionUsage(),
			subscription_type: await subscriptionType(),
			rate_limits_available: snapshot !== null,
			rate_limits: snapshot ? planRateLimits(snapshot) : null,
			behaviors: null,
		};
	}

	// --- Questions -----------------------------------------------------------------------------------------------------

	/** The open questions as Claude Code's permission request, on c's transport unless they went out there already. */
	function offerQuestions(c: Connection, q: PendingQuestions): void {
		if (c.closing || q.handle === c.handle) return;
		q.requestId = randomUUID();
		q.handle = c.handle;
		try {
			c.handle.sendControlRequest({
				type: "control_request",
				request_id: q.requestId,
				request: {
					subtype: "can_use_tool",
					tool_name: "AskUserQuestion",
					input: { questions: q.open.questions },
					tool_use_id: q.open.toolCallId,
					requires_user_interaction: true,
				},
			});
			c.handle.reportState("requires_action");
		} catch {
			// the transport reports its own failures through onClose
		}
	}

	function onQuestionsOpen(data: unknown): void {
		const open = data as QuestionsOpen | undefined;
		if (!alive || typeof open?.toolCallId !== "string" || !Array.isArray(open.questions) || typeof open.answer !== "function") return;
		const q: PendingQuestions = { open };
		questions.set(open.toolCallId, q);
		if (connection) offerQuestions(connection, q);
	}

	/** Answered in the terminal, dismissed or interrupted: the app learns the answer, and its request is withdrawn. */
	function onQuestionsClose(data: unknown): void {
		const closed = data as QuestionsClose | undefined;
		const q = typeof closed?.toolCallId === "string" ? questions.get(closed.toolCallId) : undefined;
		if (!q) return;
		questions.delete(q.open.toolCallId);
		if (!q.handle || !q.requestId) return;
		try {
			if (!q.answered) {
				if (closed?.answers) {
					q.handle.sendControlResponse({
						type: "control_response",
						response: {
							subtype: "success",
							request_id: q.requestId,
							response: { behavior: "allow", updatedInput: { questions: q.open.questions, answers: closed.answers } },
						},
					});
				}
				q.handle.sendControlCancelRequest(q.requestId);
			}
			const c = connection;
			if (c && !c.closing && c.handle === q.handle && ![...questions.values()].some((other) => other.handle === c.handle)) {
				c.handle.reportState((ctx?.isIdle() ?? true) ? "idle" : "running");
			}
		} catch {
			// the transport reports its own failures through onClose
		}
	}

	/** The app's answer to a question request: allow carries the answers, deny what the user wrote instead. */
	function onPermissionResponse(response: Json): boolean {
		const reply = response.response as Json | undefined;
		const q = [...questions.values()].find((pending) => pending.requestId !== undefined && pending.requestId === reply?.request_id);
		if (!q || reply?.subtype !== "success") return false;
		const result = reply.response as Json | undefined;
		const input = result?.updatedInput as Json | undefined;
		const answers = input?.answers;
		if (result?.behavior === "allow" && answers && typeof answers === "object" && !Array.isArray(answers)) {
			q.answered = true;
			if (q.open.answer(answers as Record<string, string>, input?.annotations as Json | undefined)) return true;
		} else if (result?.behavior === "deny") {
			q.answered = true;
			if (q.open.decline(typeof result.message === "string" ? result.message : undefined)) return true;
		}
		q.answered = false;
		return false;
	}

	// --- Side questions and background tasks ------------------------------------------------------------------------

	/** The app's /btw, answered by btw.ts with the app's own earlier side questions. */
	function onSideQuestion(
		request: { question: string; history?: { question: string; response: string }[] },
		signal: AbortSignal,
		onProgress: (progress: Json) => void,
	): Promise<{ response: string | null; synthetic: boolean }> {
		return new Promise((resolve, reject) => {
			const ask: BtwAsk = {
				question: request.question,
				history: request.history ?? [],
				signal,
				reply: (result) => {
					if (signal.aborted) reject(new Error("Side question cancelled"));
					else if (result.error) reject(new Error(result.error));
					else resolve({ response: result.answer ?? "", synthetic: false });
				},
			};
			pi.events.emit("btw:ask", ask);
			if (!ask.accepted) reject(new Error("Pi answers side questions with btw.ts, which is not loaded."));
			else onProgress({ status: "started" });
		});
	}

	/** Subagents as the app last heard of them, by agent id, so only changes go out. */
	const tasksSent = new Map<string, { status: SubagentView["status"]; tokens: number; toolCount: number; lastTool?: string; progressAt: number }>();
	let backgroundSent: string | undefined;
	let subagents: SubagentView[] = [];
	/** Sends the progress a running agent made within TASK_PROGRESS_MS of its last report, once that time is up. */
	let progressTimer: NodeJS.Timeout | null = null;

	/**
	 * Pi's subagents as Claude Code's task events: task_started when one starts, task_progress when its tokens or tools
	 * moved (at most every TASK_PROGRESS_MS), task_notification when it ends, and background_tasks_changed with the live
	 * background ones whenever that set changes. Agents that had ended before the app heard of them are not announced.
	 */
	function reportTasks(c: Connection, force = false): void {
		if (c.closing) return;
		const now = Date.now();
		const send = (message: Json) => {
			try {
				c.handle.write({ ...message, uuid: randomUUID(), session_id: c.sessionId });
			} catch {
				// the transport reports its own failures through onClose
			}
		};
		for (const agent of subagents) {
			const usage = { total_tokens: agent.tokens, tool_uses: agent.toolCount, duration_ms: agent.durationMs ?? Math.max(0, now - agent.startedAt) };
			const sent = tasksSent.get(agent.agentId);
			if (!sent) {
				tasksSent.set(agent.agentId, { status: agent.status, tokens: agent.tokens, toolCount: agent.toolCount, lastTool: agent.lastTool, progressAt: now });
				if (agent.status !== "running") continue;
				send({ type: "system", subtype: "task_started", task_id: agent.agentId, description: agent.description, subagent_type: agent.type, task_type: "local_agent", is_backgrounded: agent.background });
				continue;
			}
			if (agent.status === "running") {
				const moved = agent.tokens !== sent.tokens || agent.toolCount !== sent.toolCount || agent.lastTool !== sent.lastTool;
				if (!moved) continue;
				if (now - sent.progressAt < TASK_PROGRESS_MS) {
					progressTimer ??= setTimeout(() => {
						progressTimer = null;
						if (alive && connection) reportTasks(connection);
					}, TASK_PROGRESS_MS - (now - sent.progressAt));
					progressTimer.unref?.();
					continue;
				}
				Object.assign(sent, { tokens: agent.tokens, toolCount: agent.toolCount, lastTool: agent.lastTool, progressAt: now });
				send({
					type: "system",
					subtype: "task_progress",
					task_id: agent.agentId,
					description: agent.description,
					subagent_type: agent.type,
					usage,
					...(agent.lastTool ? { summary: agent.lastTool } : {}),
				});
			} else if (sent.status === "running") {
				sent.status = agent.status;
				const status = agent.status === "completed" ? "completed" : agent.status === "aborted" ? "stopped" : "failed";
				send({ type: "system", subtype: "task_notification", task_id: agent.agentId, status, output_file: "", summary: agent.error ?? agent.description, usage });
			}
		}
		const live = subagents
			.filter((agent) => agent.status === "running" && agent.background)
			.map((agent) => ({ task_id: agent.agentId, task_type: "local_agent", subagent_type: agent.type, description: agent.description }));
		const key = JSON.stringify(live);
		if (!force && key === backgroundSent) return;
		backgroundSent = key;
		send({ type: "system", subtype: "background_tasks_changed", tasks: live });
	}

	/** The tasks anew for a new or rebuilt connection: the live background set goes out even when it did not change. */
	function resendTasks(c: Connection): void {
		backgroundSent = undefined;
		pi.events.emit("subagents:request", undefined);
		if (backgroundSent === undefined) reportTasks(c, true);
	}

	/** The app's stop button: a running subagent is stopped. */
	async function onStopTask(taskId: string): Promise<Json> {
		const agent = subagents.find((a) => a.agentId === taskId);
		if (!agent || agent.status !== "running") throw new Error(`No running task ${taskId}.`);
		pi.events.emit("subagents:stop", taskId);
		return {};
	}

	function onRename(title: string): Verdict {
		const clean = shorten(title, MAX_TITLE_CHARS);
		if (!clean) return { ok: false, error: "The title is empty." };
		if (connection) {
			connection.remoteTitle = clean;
			connection.title = clean;
		}
		pi.setSessionName(clean);
		return { ok: true };
	}

	// --- Credentials and recovery --------------------------------------------------------------------------------------

	/** Why there is no token, for the user. */
	const loginHint = (refusal: ClaudeLoginRefusal) =>
		refusal.reason === "other-account"
			? OTHER_ACCOUNT_HINT
			: refusal.reason === "ended"
				? ENDED_HINT
				: loginSource
					? LOGIN_HINT
					: LOGIN_HINT + NO_RENEWAL_HINT;

	/** What to do about a login the server rejected. */
	const rejectedHint = () =>
		`Claude.ai login was rejected — run !!claude auth login, then /remote-control again.`;

	/**
	 * The access token from claude-login.ts: Claude Code's login, with renew a run-out one renewed by Claude Code first,
	 * and while CLAUDE_CODE_OAUTH_TOKEN is set only one of that token's account. Without the extension the token is
	 * read here, and a run-out login is not renewed. A renewal goes into the session log.
	 */
	async function accessToken(renew = true): Promise<Token | ClaudeLoginRefusal> {
		if (loginSource) {
			const token = await loginSource.token({ renew });
			if ("reason" in token) return token;
			if (token.renewed) note("Remote Control had the claude.ai login renewed, which had run out.");
			return { value: token.value };
		}
		return (await readAccessToken()) ?? { reason: "none" };
	}

	/**
	 * passing: the server was not reached or failed for the moment, so a later try may succeed; rejected: it refused the
	 * login (HTTP 401).
	 */
	async function fetchCredentials(
		module: BridgeModule,
		sessionId: string,
	): Promise<RemoteCredentials | { error: string; terminal: boolean; passing?: boolean; rejected?: boolean }> {
		const token = await accessToken();
		if ("reason" in token) return { error: loginHint(token), terminal: false };
		const watch = watchApiRequests((p) => p.endsWith(`/${sessionId}/bridge`));
		let result: unknown;
		try {
			result = await module.fetchRemoteCredentials(sessionId, API_BASE_URL, token.value, HTTP_TIMEOUT_MS);
		} finally {
			watch.stop();
		}
		if (result && typeof result === "object" && typeof (result as Json).worker_jwt === "string") return result as RemoteCredentials;
		if (module.isCredentialsRejection(result)) return { error: rejectedHint(), terminal: true, rejected: true };
		if (module.isCredentialsFailure(result)) {
			const r = result as Json;
			const reason = r.reason === "untrusted_device"
				? "this device is not enrolled for your organization's Trusted Devices policy"
				: r.reason === "session_stale_relogin"
					? "your claude.ai login is too old for this organization — log in again"
					: `the server refused the request (${r.reason}${r.status ? `, HTTP ${r.status}` : ""})`;
			return { error: `Remote Control is not available: ${reason}.`, terminal: true };
		}
		return { error: `Could not fetch the session's credentials: ${watch.reason() ?? "the Remote Control server was not reached"}.`, terminal: false, passing: true };
	}

	function scheduleRefresh(c: Connection): void {
		if (c.refreshTimer) clearTimeout(c.refreshTimer);
		const delay = Math.max(30_000, c.credentialsAt + c.credentials.expires_in * 1000 - TOKEN_REFRESH_BUFFER_MS - Date.now());
		c.refreshTimer = setTimeout(() => {
			c.refreshTimer = null;
			void recover(c, "refresh");
		}, delay);
		c.refreshTimer.unref?.();
	}

	/** Mints a fresh worker credential and rebuilds the transport; retries with backoff while the server is unreachable. */
	async function recover(c: Connection, cause: string): Promise<void> {
		if (c.closing || c.recovery || connection !== c) return;
		const token = {};
		c.recovery = token;
		/** Parking the connection or a new loop of the next runtime ends this one. */
		const current = () => !c.closing && connection === c && c.recovery === token;
		let failingSince: number | undefined;
		let noted = false;
		try {
			const { module } = await loadBridge();
			for (;;) {
				if (!current()) return;
				const move = beginEpochMove(c);
				const result = await fetchCredentials(module, c.sessionId).catch((error: unknown) => {
					endEpochMove(c, move, false, false);
					throw error;
				});
				if (!current()) {
					endEpochMove(c, move, false, "worker_jwt" in result);
					return;
				}
				if ("worker_jwt" in result) {
					const mintedAt = Date.now();
					try {
						// reconnectTransport closes the superseded transport before it awaits anything.
						const reconnecting = c.handle.reconnectTransport({ ingressToken: result.worker_jwt, apiBaseUrl: result.api_base_url, epoch: result.worker_epoch });
						endEpochMove(c, move, true, true);
						await reconnecting;
					} catch (error) {
						if (current()) await teardown(c, { archive: false, message: `Remote Control disconnected: ${errorText(error)}. /remote-control reconnects.` }, "error");
						return;
					}
					c.credentials = result;
					c.credentialsAt = mintedAt;
					if (!current()) return;
					c.recoveryAttempt = 0;
					scheduleRefresh(c);
					reportSettings(c, true);
					if ([...questions.values()].some((q) => q.handle === c.handle)) c.handle.reportState("requires_action");
					setStatus("⇄ /rc active");
					if (noted && failingSince !== undefined) note(`Remote Control is connected again (renewal failing since ${clock(failingSince)}).`);
					if (cause !== "refresh" || noted) notify("Remote Control reconnected.");
					return;
				}
				endEpochMove(c, move, false, false);
				if (!current()) return;
				if (result.terminal) {
					await teardown(c, { archive: false, message: `Remote Control disconnected: ${result.error}` }, "error");
					return;
				}
				const wait = RECOVERY_BACKOFF_MS[Math.min(c.recoveryAttempt, RECOVERY_BACKOFF_MS.length - 1)];
				c.recoveryAttempt++;
				setStatus(`⇄ /rc reconnecting… (${result.error})`);
				failingSince ??= Date.now();
				if (!noted && Date.now() - failingSince >= OFFLINE_NOTE_MS) {
					noted = true;
					const message = `Remote Control cannot renew its connection since ${clock(failingSince)}: ${result.error} It keeps trying.`;
					note(message);
					notify(message, "warning");
				}
				await new Promise((resolve) => setTimeout(resolve, wait).unref?.());
			}
		} finally {
			if (c.recovery === token) c.recovery = null;
		}
	}

	/**
	 * Attaches the bridge anew for a connection that other code of this extension attached (CODE_VERSION): same remote
	 * session, a fresh worker credential, the read stream resumed after the last event the old handle read. The old
	 * handle is closed first; a handle closed on purpose reports no close of its own.
	 */
	async function reattach(c: Connection): Promise<void> {
		if (c.closing || c.recovery || connection !== c) return;
		const token = {};
		c.recovery = token;
		const current = () => !c.closing && connection === c && c.recovery === token;
		let move: object | undefined;
		let minted = false;
		try {
			const loaded = await loadBridge();
			if (!current()) return;
			move = beginEpochMove(c);
			const credentials = await fetchCredentials(loaded.module, c.sessionId);
			minted = "worker_jwt" in credentials;
			if (!current()) return;
			if (!("worker_jwt" in credentials)) {
				note(`Remote Control keeps the bridge of the older extension code (${credentials.error}); /remote-control reconnects with the current one.`);
				return;
			}
			const sequenceNum = c.handle.getSequenceNum();
			const mintedAt = Date.now();
			try {
				c.handle.close();
			} catch {
				// already closed
			}
			// Closed on purpose, the old handle reports nothing more; what it reported since the mint was the mint's doing.
			endEpochMove(c, move, true, true);
			move = undefined;
			c.version = version = loaded.version;
			try {
				c.handle = await loaded.module.attachBridgeSession(bridgeOptions(c, credentials, sequenceNum));
			} catch (error) {
				await teardown(c, { archive: false, message: `Remote Control disconnected: ${errorText(error)}. /remote-control reconnects.` }, "error");
				return;
			}
			c.credentials = credentials;
			c.credentialsAt = mintedAt;
			c.codeVersion = CODE_VERSION;
			// Parked meanwhile: the next owner brings the app up to date on the new handle.
			if (!current()) return;
			scheduleRefresh(c);
			writeInit(c);
			c.handle.reportState((ctx?.isIdle() ?? true) ? "idle" : "running");
			for (const q of questions.values()) offerQuestions(c, q);
			reportSettings(c, true);
			reportContext(c, true);
			reportRateLimits(c, true);
			resendTasks(c);
		} finally {
			if (c.recovery === token) c.recovery = null;
			// The old handle stays: a close it held now goes on, and recovery may follow, since this attempt is over.
			if (move) endEpochMove(c, move, false, minted);
		}
	}

	function onClose(c: Connection, code?: number): void {
		if (c.closing || connection !== c) return;
		// Here as well as in bridgeOptions: a handle older code attached reports its close straight to the router.
		if (c.epochMove) {
			c.heldClose ??= { code };
			return;
		}
		switch (code) {
			case 4090:
				// The server's codes behind 4090: another worker took over, the epoch is stale, or the session is no longer active.
				void teardown(c, { archive: false, message: "Remote Control ended: the server gave this session to another connection or ended it (close 4090). /remote-control starts a new one." }, "warning");
				return;
			case 403:
			case 404:
				void teardown(c, { archive: false, message: `Remote Control ended: the server rejected the session (HTTP ${code}). /remote-control starts a new one.` }, "warning");
				return;
			default:
				setStatus("⇄ /rc reconnecting…");
				void recover(c, `close ${code ?? "unknown"}`);
		}
	}

	// --- Connect and disconnect ----------------------------------------------------------------------------------------

	/** The bridge callbacks for c in this runtime; they act only while this runtime owns c. */
	function routerFor(c: Connection): Router {
		const mine = () => connection === c;
		return {
			inbound: (message) => (mine() ? onInbound(message) : undefined),
			permissionResponse: (response) => (mine() ? onPermissionResponse(response) : false),
			interrupt: () => {
				if (mine()) ctx?.abort();
			},
			setModel: (model) => (mine() ? onSetModel(model) : SWITCHING),
			setMaxThinkingTokens: (tokens) => (mine() ? onSetMaxThinkingTokens(tokens) : SWITCHING),
			applyFlagSettings: (settings) => (mine() ? onApplyFlagSettings(settings) : SWITCHING),
			contextUsage: () => (mine() ? onGetContextUsage() : Promise.reject(new Error(SWITCHING.error))),
			usage: () => (mine() ? onGetUsage() : Promise.reject(new Error(SWITCHING.error))),
			initializeState: () => ({ current_model: ctx?.model?.id ?? null, current_permission_mode: "default" }),
			rename: (title) => (mine() ? onRename(title) : SWITCHING),
			sideQuestion: (request, signal, onProgress) => (mine() ? onSideQuestion(request, signal, onProgress) : Promise.reject(new Error(SWITCHING.error))),
			stopTask: (taskId) => (mine() ? onStopTask(taskId) : Promise.reject(new Error(SWITCHING.error))),
			close: (code) => onClose(c, code),
		};
	}

	/**
	 * Makes this runtime the owner of c and brings the app up to date with this session: a fresh init, the history if
	 * none went out yet, the run state, model and effort; then what arrived while c had no owner.
	 */
	function activate(c: Connection): void {
		connection = c;
		version = c.version;
		if (ctx) c.translator.cwd = ctx.cwd;
		c.router = routerFor(c);
		writeInit(c);
		if (!c.started) {
			writeHistory(c);
			c.started = true;
		}
		const idle = ctx?.isIdle() ?? true;
		if (idle && c.running) {
			writeResult(c, true);
			c.running = false;
		}
		c.handle.reportState(idle ? "idle" : "running");
		for (const q of questions.values()) offerQuestions(c, q);
		reportSettings(c, true);
		reportContext(c, true);
		reportRateLimits(c, true);
		void usageSource()?.refresh().catch(() => {});
		resendTasks(c);
		setStatus("⇄ /rc active");
		recordConnected(true);
		const closed = c.pendingClose;
		c.pendingClose = undefined;
		if (closed) onClose(c, closed.code);
		else scheduleRefresh(c);
		const pending = c.pending.splice(0);
		if (pending.length) {
			void (async () => {
				for (const message of pending) await onInbound(message);
			})().catch(() => {});
		}
	}

	/**
	 * Hands c over to the next runtime (/new, /resume, /fork, /reload): this runtime lets go of it, and the bridge keeps
	 * the transport, its heartbeats and the remote session. Closed if no runtime takes it within HANDOVER_TIMEOUT_MS.
	 */
	function park(c: Connection): void {
		if (connection === c) connection = null;
		c.router = null;
		if (c.refreshTimer) {
			clearTimeout(c.refreshTimer);
			c.refreshTimer = null;
		}
		if (c.recovery) {
			c.recovery = null;
			c.pendingClose ??= {};
		}
		const s = shared();
		if (s.adopt) {
			s.adopt(c);
			return;
		}
		if (s.parked) {
			clearTimeout(s.parked.timer);
			void teardown(s.parked.connection, { archive: true });
		}
		const timer = setTimeout(() => {
			if (s.parked?.connection === c) s.parked = null;
			if (!c.router) void teardown(c, { archive: true });
		}, HANDOVER_TIMEOUT_MS);
		timer.unref?.();
		s.parked = { connection: c, timer };
	}

	/** Takes over a connection from the previous runtime; reason is the session_start reason, or late (see Shared). */
	function adopt(c: Connection, reason: string): void {
		if (c.closing) return;
		version = c.version;
		if (connection) {
			void teardown(c, { archive: true });
			return;
		}
		if (!ctx || !isClaudeModel(ctx.model)) {
			void teardown(c, { archive: true, message: `Remote Control disconnected: ${ctx?.model?.id ?? "no model"} is not a Claude model.` }, "warning");
			return;
		}
		activate(c);
		if (c.codeVersion !== CODE_VERSION) void reattach(c);
		if (reason === "late") {
			note(`Remote Control active: ${c.url}`);
			notify(`Remote Control active — ${c.url}`);
		} else if (reason !== "reload") {
			note(`Remote Control continues: ${c.url}`);
		}
	}

	const adoptLate = (c: Connection) => adopt(c, "late");

	/**
	 * Connects. automatic: Pi connects by itself (at start, on reopening a connected session), so a failure that may pass
	 * is tried again after RETRY_DELAYS_MS, a rejected login once; attempt counts the tries so far, first is the first
	 * one's failure, rejected tells that the last one was a rejected login.
	 */
	async function connect(explicitName?: string, automatic?: { attempt: number; first?: string; rejected?: boolean }): Promise<void> {
		cancelRetry();
		const context = ctx;
		const s = shared();
		if (connection || s.connecting || !context) return;
		if (!isClaudeModel(context.model)) {
			notify("Remote Control works with a Claude model; switch with /model first.", "warning");
			return;
		}
		const cwd = context.cwd;
		const modelId = context.model?.id;
		s.connecting = true;
		setStatus("⇄ /rc connecting…");
		try {
			const token = await accessToken();
			if ("reason" in token) throw new Error(loginHint(token));
			const loaded = await loadBridge();
			version = loaded.version;
			const patches = loaded.patches;
			const module = loaded.module;
			const title = currentTitle(explicitName);

			const watch = watchApiRequests((p) => p === "/v1/code/sessions");
			let created: unknown;
			try {
				created = await module.createCodeSession(API_BASE_URL, token.value, title, HTTP_TIMEOUT_MS, undefined, undefined, cwd, modelId);
			} finally {
				watch.stop();
			}
			if (typeof created !== "string") {
				if (module.isCredentialsRejection(created)) throw new RejectedLogin(rejectedHint());
				if (module.isCreateSessionFailure(created)) {
					const r = created as Json;
					const detail = typeof r.detail === "string" && r.detail ? `: ${r.detail}` : "";
					throw new RefusedConnect(`Session creation failed (server ${r.status}${detail}). Remote Control needs a Pro, Max, Team, or Enterprise claude.ai account with Remote Control allowed.`);
				}
				throw new PassingFailure(`Could not create the remote session: ${watch.reason() ?? "the Remote Control server was not reached"}.`);
			}
			const sessionId = created;

			const credentials = await fetchCredentials(module, sessionId);
			if (!("worker_jwt" in credentials)) {
				archiveUnused(sessionId);
				if (credentials.passing) throw new PassingFailure(credentials.error);
				throw credentials.rejected ? new RejectedLogin(credentials.error) : new RefusedConnect(credentials.error);
			}
			const credentialsAt = Date.now();

			const c: Connection = {
				sessionId,
				url: await fetchSessionUrl(sessionId, token.value),
				title,
				version,
				handle: undefined as unknown as BridgeHandle,
				translator: new Translator(sessionId, cwd),
				credentials,
				credentialsAt,
				refreshTimer: null,
				recovery: null,
				recoveryAttempt: 0,
				closing: false,
				started: false,
				running: false,
				runStartedAt: Date.now(),
				runMessages: [],
				router: null,
				pending: [],
				inbound: [],
				codeVersion: CODE_VERSION,
			};
			c.handle = await module.attachBridgeSession(bridgeOptions(c, credentials));
			if (!alive) {
				// Pi replaced this runtime while connecting: the next one takes the connection, unless Pi quits.
				if (shutdownReason === "quit") await teardown(c, { archive: true, timeoutMs: SHUTDOWN_TIMEOUT_MS });
				else park(c);
				return;
			}
			activate(c);
			if (automatic?.first) note(`Remote Control connected at attempt ${automatic.attempt + 1}; the first failed: ${automatic.first}`);
			note(`Remote Control active: ${c.url}`);
			notify(`Remote Control active — ${c.url}`);
			const missing = missingRepairs(patches);
			if (missing.length) {
				const warning = bridgeWarning(missing, version);
				note(warning);
				notify(warning, "warning");
			}
		} catch (error) {
			const text = errorText(error);
			const attempt = automatic?.attempt ?? 0;
			const rejected = error instanceof RejectedLogin;
			// A rejected login is tried again once: two in a row are a login that needs renewing.
			const passing = error instanceof PassingFailure || (rejected && !automatic?.rejected);
			if (automatic && passing && alive && attempt < RETRY_DELAYS_MS.length) {
				const delay = RETRY_DELAYS_MS[attempt];
				const next = { attempt: attempt + 1, first: automatic.first ?? (rejected ? REJECTED_REASON : text), rejected };
				retry = setTimeout(() => {
					retry = null;
					void connect(explicitName, next);
				}, delay);
				retry.unref?.();
				setStatus(`⇄ /rc retrying at ${clock(Date.now() + delay, true)}`);
				return;
			}
			setStatus(undefined);
			const tries = attempt > 0 ? ` after ${attempt + 1} attempts` : "";
			// Refused for good: the session stops connecting by itself, at every /reload or start.
			const forget =
				automatic && (error instanceof RefusedConnect || rejected) && alive && ctx !== null && sessionConnected(ctx);
			if (forget) recordConnected(false);
			const after = forget ? " This session no longer connects by itself; /rc connects it." : "";
			note(`Remote Control failed${tries}: ${text}${after}`);
			notify(tries ? `Remote Control failed${tries}: ${text}${after}` : `Remote Control: ${text}${after}`, "error");
		} finally {
			s.connecting = false;
		}
	}

	/** A pending automatic retry of connect(), dropped when /rc connects at once or the runtime ends. */
	let retry: ReturnType<typeof setTimeout> | null = null;
	function cancelRetry(): void {
		if (!retry) return;
		clearTimeout(retry);
		retry = null;
		setStatus(undefined);
	}

	/** opts.quit: Pi quits, so the session keeps its record and connects again when it is opened. */
	async function teardown(c: Connection, opts: { archive: boolean; message?: string; timeoutMs?: number; quit?: boolean }, level: "info" | "warning" | "error" = "info"): Promise<void> {
		if (c.closing) return;
		c.closing = true;
		const active = connection === c;
		if (active) connection = null;
		if (active && !opts.quit) recordConnected(false);
		c.router = null;
		c.pending = [];
		if (c.refreshTimer) clearTimeout(c.refreshTimer);
		const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
		try {
			await Promise.race([c.handle.flush(), new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.())]);
		} catch {
			// nothing left to deliver
		}
		try {
			c.handle.close();
		} catch {
			// already closed
		}
		if (opts.archive) await archiveSession(c.sessionId, timeoutMs);
		setStatus(undefined);
		if (opts.message) {
			note(opts.message);
			notify(opts.message, level);
		}
	}

	async function disconnect(message = "Remote Control disconnected."): Promise<void> {
		const c = connection;
		if (!c) return;
		await teardown(c, { archive: true, message });
	}

	// --- Status panel ---------------------------------------------------------------------------------------------------

	async function statusPanel(c: Connection, command: ExtensionCommandContext): Promise<void> {
		if (command.mode !== "tui") {
			const answer = await command.ui.select(`Remote Control is active: ${c.url}`, ["Keep connected", "Disconnect"]);
			if (answer === "Disconnect") await disconnect();
			return;
		}
		const action = await command.ui.custom<"disconnect" | "keep">((tui, theme, _keybindings, done) => {
			const qr = renderQr(encodeQr(c.url, "M"), 2);
			return {
				render(width: number): string[] {
					const body = [
						theme.fg("muted", "Scan with the Claude app, or open the link on any device:"),
						theme.fg("accent", c.url),
						"",
						...qr,
						"",
						`${theme.fg("muted", "Title: ")}${truncateToWidth(c.title, Math.max(10, width - 12), "…")}`,
						`${theme.fg("muted", "State: ")}${c.handle.isConnected() ? theme.fg("success", "connected") : theme.fg("warning", "reconnecting…")}`,
					];
					const key = (name: string) => theme.fg("accent", theme.bold(name));
					const help = `${key("d")} disconnect ${theme.fg("dim", "·")} ${key("Esc")} keep the connection`;
					return frame(theme, width, "Remote Control", body, help);
				},
				handleInput(data: string): void {
					if (data === "d" || data === "D") done("disconnect");
					else if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") done("keep");
					else tui.requestRender();
				},
				invalidate(): void {},
			};
		}, { overlay: true, overlayOptions: { anchor: "center", width: 72, maxHeight: "95%", margin: 1 } });
		if (action === "disconnect") await disconnect();
	}

	async function askToEnable(command: ExtensionCommandContext): Promise<boolean> {
		if (readState().enabled === true) return true;
		const answer = await command.ui.select(
			"Enable Remote Control?\n\nTake this session with you and pick up right where you left off on any device. Open the Code tab in the Claude mobile app, or visit claude.ai/code in a browser.\n\nWhile connected, the conversation is stored on Anthropic's servers; execution and files stay on this machine.",
			["Enable Remote Control — opens a secure connection to claude.ai", "Never mind — /remote-control asks again next time"],
		);
		if (!answer?.startsWith("Enable")) return false;
		writeState({ enabled: true });
		return true;
	}

	// --- Lifecycle -------------------------------------------------------------------------------------------------------

	const unsubscribe = [
		pi.events.on(QUESTIONS_OPEN, onQuestionsOpen),
		pi.events.on(QUESTIONS_CLOSE, onQuestionsClose),
		pi.events.on("plan-usage:source", (data) => {
			const source = data as PlanUsageSource | undefined;
			if (
				typeof source?.id === "string" &&
				typeof source.appliesTo === "function" &&
				typeof source.snapshot === "function" &&
				typeof source.refresh === "function"
			) {
				usageSources.set(source.id, source);
			}
		}),
		pi.events.on("plan-usage:changed", (data) => {
			const id = (data as { id?: unknown } | undefined)?.id;
			if (alive && connection && (id === undefined || id === usageSource()?.id)) reportRateLimits(connection);
		}),
		pi.events.on("claude-login:source", (data) => {
			const source = data as ClaudeLoginSource | undefined;
			if (typeof source?.token === "function") loginSource = source;
		}),
		// A new SDK from claude-sdk-update.ts: its bridge is checked against the repairs at once, not only at the next /rc.
		pi.events.on("claude-sdk-update:installed", (data) => {
			const dir = (data as { dir?: unknown } | undefined)?.dir;
			if (typeof dir !== "string" || !ctx?.hasUI) return;
			const warning = bridgeCheck(dir);
			if (warning) ctx.ui.notify(warning, "warning");
		}),
		pi.events.on("subagents:state", (data) => {
			if (!Array.isArray(data)) return;
			subagents = data as SubagentView[];
			if (alive && connection) reportTasks(connection);
		}),
	];
	pi.events.emit("plan-usage:source-request", undefined);
	pi.events.emit("claude-login:source-request", undefined);

	pi.registerFlag("remote-control", { description: "Connect the session to claude.ai and the Claude app at start", type: "boolean", default: false });

	pi.on("session_start", (event, context) => {
		ctx = context;
		if (!context.hasUI) return;
		const s = shared();
		s.adopt = adoptLate;
		const parked = s.parked;
		if (parked) {
			s.parked = null;
			clearTimeout(parked.timer);
			adopt(parked.connection, event.reason);
			return;
		}
		if (!isClaudeModel(context.model)) return;
		// reload: a connect still to be retried, or a handover that did not happen, comes back with the session's record.
		const reopened = (event.reason === "startup" || event.reason === "resume" || event.reason === "reload") && readState().enabled === true && sessionConnected(context);
		if (event.reason !== "startup" && !reopened) return;
		if (event.reason === "startup") {
			const warning = bridgeCheck(claudeSdkDir());
			if (warning) context.ui.notify(warning, "warning");
		}
		const wanted = reopened || pi.getFlag("remote-control") === true || (startupSetting() && readState().enabled === true);
		if (wanted) setTimeout(() => void connect(undefined, { attempt: 0 }), 500).unref?.();
	});

	pi.on("session_shutdown", async (event) => {
		cancelRetry();
		const s = shared();
		if (s.adopt === adoptLate) s.adopt = null;
		const c = connection;
		if (c && event.reason === "quit") await teardown(c, { archive: true, timeoutMs: SHUTDOWN_TIMEOUT_MS, quit: true });
		else if (c) park(c);
		for (const off of unsubscribe) off();
		questions.clear();
		alive = false;
		shutdownReason = event.reason;
		ctx = null;
	});

	pi.on("model_select", (event) => {
		if (connection && !isClaudeModel(event.model)) {
			void disconnect(`Remote Control disconnected: ${event.model.id} is not a Claude model.`);
		} else if (connection) {
			reportSettings(connection, false, { model: event.model.id });
			reportContext(connection);
		}
	});

	pi.on("thinking_level_select", (event) => {
		const c = connection;
		if (!c) return;
		if (c.appEffort !== undefined && event.level !== c.appEffort) c.appEffort = undefined;
		reportSettings(c, false, { level: event.level });
	});

	pi.on("session_info_changed", (event) => {
		const c = connection;
		if (!c || !event.name || event.name === c.remoteTitle || event.name === c.title) return;
		c.title = shorten(event.name, MAX_TITLE_CHARS);
		void updateTitle(c.sessionId, c.title);
	});

	/** A compaction's status, as Claude Code sends it while it compacts and with the outcome. */
	function writeStatus(c: Connection, status: Json): void {
		write({ type: "system", subtype: "status", ...status, uuid: randomUUID(), session_id: c.sessionId });
	}

	pi.on("session_before_compact", () => {
		const c = connection;
		if (!c || c.compacting) return;
		c.compacting = { startedAt: Date.now(), turn: !c.running };
		if (c.compacting.turn) c.handle.reportState("running");
		writeStatus(c, { status: "compacting" });
	});

	pi.on("session_compact", (event) => {
		const c = connection;
		if (!c) return;
		const compacting = c.compacting;
		c.compacting = undefined;
		const meta = {
			trigger: event.reason === "manual" ? ("manual" as const) : ("auto" as const),
			postTokens: contextEstimate()?.tokens,
			durationMs: compacting ? Date.now() - compacting.startedAt : undefined,
		};
		for (const message of c.translator.compaction(event.compactionEntry, meta)) write(message);
		writeStatus(c, { status: null, compact_result: "success" });
		reportContext(c, true);
		if (compacting?.turn && !c.running) endOwnTurn(c);
	});

	pi.on("session_compact_failed", (event) => {
		const c = connection;
		const compacting = c?.compacting;
		if (!c || !compacting) return;
		c.compacting = undefined;
		writeStatus(c, { status: null, compact_result: "failed", ...(event.errorMessage && { compact_error: event.errorMessage }) });
		if (compacting.turn && !c.running) endOwnTurn(c, !event.aborted);
	});

	pi.on("agent_start", () => {
		const c = connection;
		if (!c) return;
		c.running = true;
		c.runStartedAt = Date.now();
		c.runMessages = [];
		c.handle.reportState("running");
	});

	// A write reports "update" or "create" as in Claude Code, so the file is checked before the write runs.
	pi.on("tool_call", (event) => {
		const c = connection;
		if (!c || event.toolName !== "write") return undefined;
		const file = absolute(c.translator.cwd, (event.input as Json).path);
		if (file) c.translator.existedBefore.set(event.toolCallId, existsSync(file));
		return undefined;
	});

	pi.on("message_end", (event) => {
		const c = connection;
		if (!c) return;
		const message = event.message;
		if (message.role === "user") {
			const text = textOf((message as UserMessage).content).trim();
			const index = c.inbound.indexOf(text);
			if (index >= 0) {
				c.inbound.splice(index, 1);
				return;
			}
		}
		if (message.role === "assistant" || message.role === "toolResult") c.runMessages.push(message);
		const converted = c.translator.convert(message, randomUUID());
		if (converted) write(converted);
		if (message.role === "assistant") reportContext(c);
	});

	pi.on("agent_end", () => {
		const c = connection;
		if (!c) return;
		writeResult(c, false);
		c.running = false;
		reportContext(c);
		void usageSource()?.refresh().catch(() => {});
	});

	pi.on("agent_settled", (event) => {
		const c = connection;
		if (!c) return;
		c.running = false;
		if (event.aborted && c.runMessages.length === 0) writeResult(c, true);
		c.handle.reportState("idle");
	});

	// --- Command -----------------------------------------------------------------------------------------------------------

	for (const name of ["remote-control", "rc"]) {
		pi.registerCommand(name, {
			description: "Connect this session to claude.ai and the Claude app; again for status and disconnect",
			handler: async (args, command) => {
				if (args.startsWith(APP_COMMAND_MARK)) {
					await runAppCommand(args.slice(APP_COMMAND_MARK.length), command);
					return;
				}
				if (shared().connecting) {
					command.ui.notify("Remote Control is connecting…", "info");
					return;
				}
				if (connection) {
					await statusPanel(connection, command);
					return;
				}
				if (!isClaudeModel(command.model)) {
					command.ui.notify("Remote Control works with a Claude model; switch with /model first.", "warning");
					return;
				}
				if (!(await askToEnable(command))) return;
				await connect(args.trim() || undefined);
			},
		});
	}

	pi.registerEntryRenderer<{ line: string }>(ENTRY_TYPE, (entry, _options, theme) => {
		return new Text(theme.fg("dim", `⇄ ${entry.data?.line ?? "Remote Control"}`), 0, 0);
	});
}
