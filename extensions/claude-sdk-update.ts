/**
 * Claude Agent SDK updates for pi-claude-agent-sdk.
 *
 * pi-claude-agent-sdk (the claude-bridge provider) runs Claude through the Claude Agent SDK, and the SDK's platform
 * package brings the Claude Code executable along. Claude Code takes each model's context window from a registry built
 * into it: a model newer than the bundled Claude Code counts as 200k, and Claude Code refuses a longer session with
 * "Prompt is too long" before any request, although the model takes 1M. The package pins the SDK to one exact version,
 * so `pi update` brings a newer SDK only with a release of the package.
 *
 * The mechanism is an npm override in the package.json of Pi's npm root (~/.pi/agent/npm, below PI_CODING_AGENT_DIR
 * when that is set): "overrides": {"@anthropic-ai/claude-agent-sdk": "<version>"} makes npm install that version in
 * place of the pinned one. Pi creates that package.json only when it is missing, and npm keeps the field, so the
 * override outlasts `pi install` and `pi update`. Only the SDK is overridden; its platform packages follow it, since
 * the SDK names them at its own version.
 *
 * - At every Pi start in the terminal, the SDK pi-claude-agent-sdk uses (its own copy below it, else the hoisted one)
 *   is compared in the background with the npm registry's latest version. Pi in print, JSON, or RPC mode, subagents,
 *   Pi with PI_OFFLINE set, and a root without pi-claude-agent-sdk do not check.
 * - A newer version is installed right away: the override is set to it, or raised (never lowered), and
 *   `npm install --legacy-peer-deps` runs as Pi installs its packages: without that flag npm 7 and newer would install
 *   Pi itself as a peer dependency. A notice names the old and the new SDK and Claude Code version. Pi processes
 *   started afterwards load the new SDK; running ones keep the old SDK code, so start them anew. When the install
 *   fails and the SDK stayed as it was, the package.json is put back as it was.
 * - /claude-sdk-update (or /claude-sdk-update latest) checks and installs at once and reports the state: the installed
 *   SDK, the version the package pins, and the override. /claude-sdk-update pinned removes the override and installs
 *   the version the package pins again. It also turns the automatic update off, remembered as {"auto": false} in
 *   claude-sdk-update.json in Pi's agent folder, so the next start does not set the override again;
 *   /claude-sdk-update or /claude-sdk-update latest turns it on again.
 * - A check outlasts a session replaced while it runs (/new, /resume, /fork, /reload): its notices and the event below
 *   go to the session current when it ends. The checks and installs of one Pi process run one after the other.
 * - One update at a time: Pi processes starting together share a lock file in the npm root, a lock older than 15
 *   minutes counts as left over.
 * - Claude Code stays startable during the update. npm writes a package into its place file by file, and an
 *   executable of a few hundred MB can be neither found nor started for the seconds that takes ("spawn ETXTBSY").
 *   So the new version is installed into a folder beside node_modules first, and its packages, complete, take the
 *   place of the old ones with a rename each; package-lock.json gets their entries, and the `npm install` that
 *   follows finds them in place and only settles the rest. Where the folders cannot be renamed (Windows, while Claude
 *   Code runs), `npm install` installs in place, and a request that starts Claude Code just then fails and can be
 *   repeated.
 * - npm skips an optional package it cannot fetch without an error, and the platform packages with Claude Code are
 *   optional. So when the folder beside node_modules lacks one that is installed now, nothing is moved and nothing
 *   changed: the installed SDK and the override stay, and the next start tries again. After an update, every platform
 *   package installed before must still be there; a missing one is reported with the command that installs it again.
 * - Works with npm, Pi's default. With an `npmCommand` setting for pnpm or Bun, the extension does nothing.
 * - After an update, also one back to the pinned version, "claude-sdk-update:installed" on the event bus carries the
 *   new SDK's folder and versions ({ dir, version, claudeCode }), so claude-remote-control.ts can check its repairs
 *   against the new bundle at once.
 */

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const SDK = "@anthropic-ai/claude-agent-sdk";
/** The Pi package that runs on the SDK; without it in the npm root this extension does nothing. */
const PACKAGE = "pi-claude-agent-sdk";
const ROOT = path.join(getAgentDir(), "npm");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const LOCK_FILE = path.join(ROOT, ".claude-sdk-update.lock");
/** Where a new version is installed before it moves into node_modules: on the same file system, so a move renames. */
const STAGE = path.join(ROOT, ".claude-sdk-update");
/** What a package folder is called for the moment its successor takes its place. */
const RETIRED = /\.retired-\d+$/;
/** {"auto": false} after /claude-sdk-update pinned: the start leaves the SDK at the pinned version. */
const STATE_FILE = path.join(getAgentDir(), "claude-sdk-update.json");
const COMMAND = "claude-sdk-update";
const VIEW_TIMEOUT_MS = 60_000;
const UPDATE_TIMEOUT_MS = 15 * 60_000;
const STALE_LOCK_MS = 15 * 60_000;

const run = promisify(execFile);

type Npm = { command: string; args: string[] };

interface Sdk {
	version: string;
	/** The Claude Code version the SDK brings, from its package.json. */
	claudeCode?: string;
	/** Its folder below the npm root, which is also its key in package-lock.json. */
	location: string;
}

/** What is installed, and what decides it. */
interface State {
	installed: Sdk;
	/** The version (or range) pi-claude-agent-sdk declares for the SDK. */
	pinned?: string;
	/** The override in the npm root's package.json. */
	override?: string;
	auto: boolean;
}

type Result =
	| { kind: "absent"; reason: string }
	| { kind: "current"; state: State }
	| { kind: "updated"; from: Sdk; state: State }
	| { kind: "pinned"; from: Sdk; state: State }
	| { kind: "busy"; state: State }
	| { kind: "failed"; message: string };

/** Pi's npm command from its settings when it is npm; null for pnpm or Bun. */
function npmCommand(): Npm | null {
	let configured: unknown;
	try {
		configured = JSON.parse(readFileSync(path.join(getAgentDir(), "settings.json"), "utf8"))?.npmCommand;
	} catch {
		configured = undefined;
	}
	if (!Array.isArray(configured) || configured.length === 0) return { command: "npm", args: [] };
	if (!configured.every((part) => typeof part === "string" && part)) return null;
	const [command, ...args] = configured as string[];
	const name = (part: string) => path.basename(part).replace(/\.(cmd|exe)$/i, "");
	const separator = args.lastIndexOf("--");
	const manager = separator >= 0 && args[separator + 1] ? name(args[separator + 1]) : name(command);
	return manager === "npm" ? { command, args } : null;
}

function readJson(file: string): any {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** pi-claude-agent-sdk in the npm root with the SDK version it declares; null when it is not installed there. */
function installedPackage(): { pinned?: string } | null {
	const manifest = readJson(path.join(ROOT, "node_modules", PACKAGE, "package.json"));
	if (!manifest || typeof manifest !== "object") return null;
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		const spec = manifest[field]?.[SDK];
		if (typeof spec === "string") return { pinned: spec };
	}
	return {};
}

/**
 * The platform packages with Claude Code installed beside the SDK at `location`, by their names in the SDK's scope
 * (claude-agent-sdk-linux-x64, …).
 */
function platformPackages(location: string): string[] {
	const own = path.basename(SDK);
	try {
		return readdirSync(path.dirname(path.join(ROOT, location)), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(`${own}-`) && !RETIRED.test(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/** The stage lacks a platform package installed now: npm could not fetch it. */
class IncompleteStage extends Error {}

/**
 * The SDK pi-claude-agent-sdk loads: its own copy below it (npm nests one there when another version is hoisted),
 * else the hoisted one; null when there is none. claude-remote-control.ts looks it up in the same order.
 */
function installedSdk(): Sdk | null {
	for (const dir of [`node_modules/${PACKAGE}/node_modules/${SDK}`, `node_modules/${SDK}`]) {
		const manifest = readJson(path.join(ROOT, dir, "package.json"));
		if (typeof manifest?.version !== "string") continue;
		return {
			version: manifest.version,
			claudeCode: typeof manifest.claudeCodeVersion === "string" ? manifest.claudeCodeVersion : undefined,
			location: dir,
		};
	}
	return null;
}

function readOverride(): string | undefined {
	const value = readJson(PACKAGE_JSON)?.overrides?.[SDK];
	return typeof value === "string" ? value : undefined;
}

/** Sets the override to `version`, or removes it without one; the other fields stay. Answers the file as it was. */
function writeOverride(version: string | undefined): string | undefined {
	let before: string | undefined;
	try {
		before = readFileSync(PACKAGE_JSON, "utf8");
	} catch {
		before = undefined;
	}
	const json = before === undefined ? { name: "pi-extensions", private: true } : JSON.parse(before);
	const overrides = { ...(json.overrides ?? {}) };
	if (version === undefined) delete overrides[SDK];
	else overrides[SDK] = version;
	if (Object.keys(overrides).length > 0) json.overrides = overrides;
	else delete json.overrides;
	writeFileSync(`${PACKAGE_JSON}.new`, JSON.stringify(json, null, 2));
	renameSync(`${PACKAGE_JSON}.new`, PACKAGE_JSON);
	return before;
}

function autoEnabled(): boolean {
	return readJson(STATE_FILE)?.auto !== false;
}

function setAuto(on: boolean): void {
	try {
		if (on) rmSync(STATE_FILE, { force: true });
		else writeFileSync(STATE_FILE, `${JSON.stringify({ auto: false })}\n`);
	} catch {
		// The setting stays as it was; the command's report still says what it did.
	}
}

/** The state of the root, or why there is nothing to do. */
function currentState(): { command: Npm; state: State } | { reason: string } {
	const command = npmCommand();
	if (!command) return { reason: "Pi's npmCommand is not npm" };
	const pkg = installedPackage();
	if (!pkg) return { reason: `${PACKAGE} is not installed in ${ROOT}` };
	const installed = installedSdk();
	if (!installed) return { reason: `${PACKAGE} in ${ROOT} has no Claude Agent SDK` };
	return { command, state: { installed, pinned: pkg.pinned, override: readOverride(), auto: autoEnabled() } };
}

/** Compares two versions; a pre-release sorts before its release. */
function compare(a: string, b: string): number {
	const [coreA, preA = ""] = a.split(/-(.*)/s);
	const [coreB, preB = ""] = b.split(/-(.*)/s);
	const partsA = coreA.split(".").map(Number);
	const partsB = coreB.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (partsA[i] || 0) - (partsB[i] || 0);
		if (diff !== 0) return diff;
	}
	if (preA === preB) return 0;
	if (!preA) return 1;
	if (!preB) return -1;
	return preA < preB ? -1 : 1;
}

const newest = (versions: string[]) => versions.reduce<string | null>((max, v) => (max === null || compare(v, max) > 0 ? v : max), null);
const EXACT = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

async function npm(command: Npm, args: string[], timeout: number, cwd = ROOT): Promise<string> {
	const { stdout } = await run(command.command, [...command.args, ...args], {
		cwd,
		timeout,
		maxBuffer: 16 * 1024 * 1024,
		env: { ...process.env, npm_config_update_notifier: "false" },
	});
	return stdout.trim();
}

/** The versions of the registry a spec matches, oldest first; `npm view` answers one version as a plain string. */
async function view(command: Npm, spec: string): Promise<string[]> {
	const out = await npm(command, ["view", spec, "version", "--json"], VIEW_TIMEOUT_MS);
	if (!out) return [];
	const parsed: unknown = JSON.parse(out);
	return (Array.isArray(parsed) ? parsed : [parsed]).filter((v): v is string => typeof v === "string");
}

/** Takes the lock file for this process; false while another process holds a lock that is not left over. */
function takeLock(retry = true): boolean {
	try {
		const fd = openSync(LOCK_FILE, "wx");
		writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
		closeSync(fd);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !retry) throw error;
	}
	try {
		if (Date.now() - statSync(LOCK_FILE).mtimeMs < STALE_LOCK_MS) return false;
		rmSync(LOCK_FILE, { force: true });
	} catch {
		// Gone in between: try once more.
	}
	try {
		return takeLock(false);
	} catch {
		return false;
	}
}

/** Removes what an interrupted update left beside the packages. */
function clearStage(location: string): void {
	rmSync(STAGE, { recursive: true, force: true });
	const scope = path.dirname(path.join(ROOT, location));
	try {
		for (const name of readdirSync(scope)) if (RETIRED.test(name)) rmSync(path.join(scope, name), { recursive: true, force: true });
	} catch {
		// No such folder: nothing was left there.
	}
}

/**
 * Installs `version` of the SDK beside node_modules and moves its packages, complete, into the place of the installed
 * ones: the SDK and the platform packages with Claude Code, which are named after it. package-lock.json gets their
 * entries, so the `npm install` that follows takes them as installed. Throws when a folder cannot be moved; what was
 * moved until then stays, and that `npm install` completes it in place.
 */
async function installBeside(command: Npm, version: string, location: string): Promise<void> {
	clearStage(location);
	mkdirSync(STAGE, { recursive: true });
	writeFileSync(path.join(STAGE, "package.json"), "{}\n");
	const stage = realpathSync(STAGE);
	await npm(command, ["install", `${SDK}@${version}`, "--prefix", stage, "--legacy-peer-deps", "--no-audit", "--no-fund"], UPDATE_TIMEOUT_MS, stage);
	const scope = path.join(stage, "node_modules", path.dirname(SDK));
	const missing = platformPackages(location).filter((name) => !existsSync(path.join(scope, name)));
	if (missing.length > 0) {
		clearStage(location);
		throw new IncompleteStage(`npm did not fetch ${missing.map((name) => `${path.dirname(SDK)}/${name}@${version}`).join(", ")}; the installed SDK stays, the next start tries again`);
	}
	try {
		const staged: Record<string, Record<string, unknown>> = JSON.parse(readFileSync(path.join(stage, "package-lock.json"), "utf8"))?.packages ?? {};
		const lockFile = path.join(ROOT, "package-lock.json");
		const lock = JSON.parse(readFileSync(lockFile, "utf8"));
		const own = `node_modules/${SDK}`;
		// Where the installed SDK lies, its platform packages lie beside it.
		const base = location.slice(0, location.length - SDK.length);
		// Claude Code first, the SDK that starts it last.
		const keys = Object.keys(staged)
			.filter((key) => key === own || key.startsWith(`${own}-`))
			.sort((a, b) => Number(a === own) - Number(b === own));
		for (const key of keys) {
			const target = base + key.slice("node_modules/".length);
			const from = path.join(stage, key);
			// The platform packages of other systems are in the lock file only.
			if (existsSync(from)) {
				const to = path.join(ROOT, target);
				const retired = `${to}.retired-${process.pid}`;
				mkdirSync(path.dirname(to), { recursive: true });
				const had = existsSync(to);
				if (had) renameSync(to, retired);
				try {
					renameSync(from, to);
				} catch (error) {
					if (had) renameSync(retired, to);
					throw error;
				}
				if (had) rmSync(retired, { recursive: true, force: true });
			}
			const flags = Object.fromEntries(Object.entries(lock.packages?.[target] ?? {}).filter(([field]) => ["dev", "optional", "devOptional", "peer"].includes(field)));
			lock.packages[target] = { ...staged[key], ...flags };
		}
		writeFileSync(`${lockFile}.new`, `${JSON.stringify(lock, null, 2)}\n`);
		renameSync(`${lockFile}.new`, lockFile);
		// npm's own note of what node_modules holds is older than the folders now, and npm reads them again.
		rmSync(path.join(ROOT, "node_modules", ".package-lock.json"), { force: true });
	} finally {
		clearStage(location);
	}
}

/**
 * Brings the SDK to `version` with the override set to `override` (removed without one), under the lock. The
 * package.json is put back when the SDK did not change. Answers the SDK afterwards, or null when another process holds
 * the lock.
 */
async function install(command: Npm, installed: Sdk, version: string, override: string | undefined, onStart?: () => void): Promise<Sdk | null> {
	if (!takeLock()) return null;
	onStart?.();
	const platform = platformPackages(installed.location);
	let before: string | undefined;
	try {
		before = writeOverride(override);
		try {
			await installBeside(command, version, installed.location);
		} catch (error) {
			if (error instanceof IncompleteStage) throw error;
			// The install below puts in place what could not be moved there, or reports why nothing can be installed.
		}
		await npm(command, ["install", "--prefix", realpathSync(ROOT), "--legacy-peer-deps", "--no-audit", "--no-fund"], UPDATE_TIMEOUT_MS);
	} catch (error) {
		if (before !== undefined && installedSdk()?.version !== version) {
			try {
				writeFileSync(PACKAGE_JSON, before);
			} catch {
				// The override stays; the next install of Pi's packages applies it.
			}
		}
		throw error;
	} finally {
		rmSync(LOCK_FILE, { force: true });
	}
	const after = installedSdk();
	if (!after || after.version !== version) throw new Error(`npm install finished, but the SDK is ${after?.version ?? "missing"}, not ${version}`);
	const lost = platform.filter((name) => !platformPackages(after.location).includes(name));
	if (lost.length > 0) {
		throw new Error(
			`npm removed ${lost.map((name) => `${path.dirname(SDK)}/${name}`).join(", ")}, so Claude Code may not start; ` +
				`run npm install --legacy-peer-deps --no-audit --no-fund in ${ROOT}`,
		);
	}
	return after;
}

/** Checks the registry and installs its latest version through the override when it is newer than the installed one. */
async function check(automatic: boolean, onUpdate: (from: Sdk, to: string) => void): Promise<Result> {
	const found = currentState();
	if (!("command" in found)) return { kind: "absent", reason: found.reason };
	const { command, state } = found;
	const latest = newest(await view(command, SDK));
	if (latest === null) throw new Error(`npm view ${SDK} answered no version`);
	if (compare(latest, state.installed.version) <= 0) return { kind: "current", state };
	// /claude-sdk-update pinned in another Pi process while this one started.
	if (automatic && !autoEnabled()) return { kind: "current", state: { ...state, auto: false } };
	const after = await install(command, state.installed, latest, latest, () => onUpdate(state.installed, latest));
	if (!after) return { kind: "busy", state };
	return { kind: "updated", from: state.installed, state: { ...state, installed: after, override: latest } };
}

/** Removes the override and installs the version pi-claude-agent-sdk pins. */
async function pin(): Promise<Result> {
	const found = currentState();
	if (!("command" in found)) return { kind: "absent", reason: found.reason };
	const { command, state } = found;
	if (!state.pinned) throw new Error(`${PACKAGE} declares no version of ${SDK}`);
	const target = EXACT.test(state.pinned) ? state.pinned : newest(await view(command, `${SDK}@${state.pinned}`));
	if (target === null) throw new Error(`npm view ${SDK}@${state.pinned} answered no version`);
	if (state.override === undefined && state.installed.version === target) return { kind: "current", state };
	const after = await install(command, state.installed, target, undefined);
	if (!after) return { kind: "busy", state };
	return { kind: "pinned", from: state.installed, state: { ...state, installed: after, override: undefined } };
}

/** The first error line npm printed, else the first line of the message. */
function describe(error: unknown): string {
	const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
	const npmError = stderr.split("\n").find((line) => /^npm (ERR!|error) /.test(line) && !/^npm (ERR!|error) *$/.test(line));
	if (npmError) return npmError.replace(/^npm (ERR!|error) /, "").trim();
	return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

const label = (sdk: Sdk) => (sdk.claudeCode ? `${sdk.version} (Claude Code ${sdk.claudeCode})` : sdk.version);

function stateLine(state: State): string {
	const override = state.override ? `override ${state.override}` : "no override";
	return `SDK ${label(state.installed)}; ${PACKAGE} pins ${state.pinned ?? "nothing"}; ${override}; automatic updates ${state.auto ? "on" : "off (/claude-sdk-update turns them on)"}.`;
}

interface Shared {
	/** The start's or the command's check in flight, which a second one joins. */
	check?: Promise<Result>;
	/** The end of the last check or install queued: they run one after the other. */
	queue?: Promise<unknown>;
	/** The session runtime current now, with the context of its session_start; none between two runtimes. */
	live?: { pi: ExtensionAPI; ctx: ExtensionContext };
}

/**
 * Shared by the session runtimes of this process. /reload loads this file afresh, and /new, /resume, /fork, and /reload
 * replace the runtime while a check may still run: a session started then must not start a second check, and the pi
 * and ctx of a replaced runtime throw when used, which ends Pi from a promise. So whatever a check reports goes to the
 * runtime current when it ends.
 */
const store = globalThis as typeof globalThis & Record<symbol, Shared | undefined>;
const shared: Shared = (store[Symbol.for("pi.claude-sdk-update")] ??= {});

/** Runs `job` after the ones queued before, and announces a changed SDK on the event bus. */
function enqueue(job: () => Promise<Result>): Promise<Result> {
	const next = (shared.queue ?? Promise.resolve())
		.catch(() => {})
		.then(job)
		.catch((error): Result => ({ kind: "failed", message: describe(error) }))
		.then((result) => {
			if (result.kind === "updated" || result.kind === "pinned") {
				shared.live?.pi.events.emit("claude-sdk-update:installed", {
					dir: path.join(ROOT, result.state.installed.location),
					version: result.state.installed.version,
					claudeCode: result.state.installed.claudeCode,
				});
			}
			return result;
		});
	shared.queue = next;
	return next;
}

function runCheck(automatic: boolean): Promise<Result> {
	shared.check ??= enqueue(() =>
		check(automatic, (from, to) => {
			shared.live?.ctx.ui.notify(`Updating the Claude Agent SDK ${from.version} -> ${to} …`, "info");
		}),
	).finally(() => {
		shared.check = undefined;
	});
	return shared.check;
}

const RESTART = "Start running Pi processes anew to load it.";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event, context) => {
		shared.live = { pi, ctx: context };
		if (event.reason !== "startup" || context.mode !== "tui") return;
		if (process.env.PI_SUBAGENT_DEPTH || process.env.PI_OFFLINE) return;
		if (!autoEnabled() || !installedPackage() || !installedSdk()) return;
		void runCheck(true).then((result) => {
			const ctx = shared.live?.ctx;
			if (!ctx) return;
			if (result.kind === "failed") ctx.ui.notify(`Claude Agent SDK update failed: ${result.message}`, "warning");
			if (result.kind === "updated") {
				ctx.ui.notify(`Claude Agent SDK updated ${label(result.from)} -> ${label(result.state.installed)}. ${RESTART}`, "info");
			}
		});
	});

	pi.on("session_shutdown", () => {
		if (shared.live?.pi === pi) shared.live = undefined;
	});

	pi.registerCommand(COMMAND, {
		description: "Update the Claude Agent SDK of pi-claude-agent-sdk to the newest version; `pinned` goes back to the package's",
		getArgumentCompletions: (prefix: string) =>
			["latest", "pinned"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
		handler: async (args, command) => {
			const mode = args.trim().toLowerCase() || "latest";
			if (mode !== "latest" && mode !== "pinned") {
				command.ui.notify(`Usage: /${COMMAND} [latest|pinned]`, "warning");
				return;
			}
			setAuto(mode === "latest");
			command.ui.notify(mode === "latest" ? "Checking the Claude Agent SDK …" : "Installing the Claude Agent SDK the package pins …", "info");
			const result = mode === "latest" ? await runCheck(false) : await enqueue(pin);
			const lines: string[] = [];
			let level: "info" | "warning" | "error" = "info";
			switch (result.kind) {
				case "absent":
					lines.push(`Nothing to update: ${result.reason}.`);
					level = "warning";
					break;
				case "current":
					lines.push(mode === "latest" ? "The Claude Agent SDK is current." : "The Claude Agent SDK is the one the package pins.");
					lines.push(stateLine(result.state));
					break;
				case "updated":
					lines.push(`Claude Agent SDK updated ${label(result.from)} -> ${label(result.state.installed)}. ${RESTART}`);
					lines.push(stateLine(result.state));
					break;
				case "pinned":
					lines.push(`Claude Agent SDK back at the pinned version: ${label(result.from)} -> ${label(result.state.installed)}. ${RESTART}`);
					lines.push(stateLine(result.state));
					break;
				case "busy":
					lines.push("Another Pi process is updating the Claude Agent SDK; try again in a few minutes.");
					lines.push(stateLine(result.state));
					break;
				case "failed":
					lines.push(`Claude Agent SDK ${mode === "latest" ? "update" : "install"} failed: ${result.message}`);
					level = "error";
					break;
			}
			// Not command.ui: the session may have been replaced while the check ran, and this context with it.
			(shared.live?.ctx ?? command).ui.notify(lines.join("\n"), level);
		},
	});
}
