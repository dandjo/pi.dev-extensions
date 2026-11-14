/**
 * Claude Agent SDK updates for pi-claude-subscription.
 *
 * pi-claude-subscription runs Claude through the Claude Agent SDK, and the SDK's platform package brings the Claude
 * Code executable along. Claude Code takes each model's context window from a registry built into it: a model newer
 * than the bundled Claude Code counts as 200k, and Claude Code refuses a longer session with "Prompt is too long"
 * before any request, although the model takes 1M. `pi update` leaves the SDK where it is, since npm keeps a
 * dependency at the version of package-lock.json.
 *
 * - At every Pi start in the terminal, the SDK in Pi's npm root (~/.pi/agent/npm) is compared in the background with
 *   the npm registry. Pi in print, JSON, or RPC mode, subagents, and Pi with PI_OFFLINE set do not check.
 * - A newer version within the ranges the installed packages declare for the SDK (pi-claude-subscription's ^0.3.289,
 *   for example) is installed right away, with `npm update @anthropic-ai/claude-agent-sdk --legacy-peer-deps` as Pi
 *   installs its packages: without that flag npm 7 and newer would install Pi itself as a peer dependency. A notice
 *   names the old and the new SDK and Claude Code version. Pi processes started afterwards load the new SDK; running
 *   ones keep the old SDK code, so start them anew.
 * - A newer version outside those ranges is reported once per version: it needs a new version of the package that
 *   declares the range first (`pi update npm:pi-claude-subscription`).
 * - /claude-sdk-update checks and installs at once and reports the state, also when nothing is due.
 * - One update at a time: Pi processes starting together share a lock file in the npm root, a lock older than 15
 *   minutes counts as left over.
 * - Claude Code stays startable during the update. npm writes a package into its place file by file, and an
 *   executable of a few hundred MB can be neither found nor started for the seconds that takes ("spawn ETXTBSY").
 *   So the new version is installed into a folder beside node_modules first, and its packages, complete, take the
 *   place of the old ones with a rename each; package-lock.json gets their entries, and the `npm update` that follows
 *   finds them in place and only settles the rest. Where the folders cannot be renamed (Windows, while Claude Code
 *   runs), `npm update` installs in place as before, and a request that starts Claude Code just then fails and can be
 *   repeated.
 * - Works with npm, Pi's default. With an `npmCommand` setting for pnpm or Bun, the extension does nothing.
 */

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const SDK = "@anthropic-ai/claude-agent-sdk";
const ROOT = path.join(getAgentDir(), "npm");
const LOCK_FILE = path.join(ROOT, ".claude-sdk-update.lock");
/** Where a new version is installed before it moves into node_modules: on the same file system, so the move is a rename. */
const STAGE = path.join(ROOT, ".claude-sdk-update");
/** What a package folder is called for the moment its successor takes its place. */
const RETIRED = /\.retired-\d+$/;
/** The newest version outside the ranges already reported, so the start reports it once. */
const STATE_FILE = path.join(getAgentDir(), "claude-sdk-update.json");
const COMMAND = "claude-sdk-update";
const VIEW_TIMEOUT_MS = 60_000;
const UPDATE_TIMEOUT_MS = 15 * 60_000;
const STALE_LOCK_MS = 15 * 60_000;

const run = promisify(execFile);

interface Sdk {
	version: string;
	/** The Claude Code version the SDK brings, from its package.json. */
	claudeCode?: string;
	/** Its folder below the npm root, which is also its key in package-lock.json. */
	location: string;
}

/** A package that declares a range for the SDK, from package-lock.json. */
interface Dependent {
	name: string;
	range: string;
}

type Result =
	| { kind: "absent" }
	| { kind: "current"; installed: Sdk; blocked?: Blocked }
	| { kind: "updated"; from: Sdk; to: Sdk; blocked?: Blocked }
	| { kind: "busy"; installed: Sdk }
	| { kind: "failed"; message: string };

/** A newer version than the ranges allow. */
interface Blocked {
	latest: string;
	dependents: Dependent[];
}

/** Pi's npm command from its settings when it is npm; null for pnpm or Bun. */
function npmCommand(): { command: string; args: string[] } | null {
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

/** The packages of package-lock.json, by their path below the npm root. */
function lockPackages(): Record<string, Record<string, unknown>> {
	try {
		return JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"))?.packages ?? {};
	} catch {
		return {};
	}
}

/** The SDK in the npm root, hoisted or below the package that needs it; null when no package there brings it. */
function installedSdk(): Sdk | null {
	const hoisted = `node_modules/${SDK}`;
	const nested = Object.keys(lockPackages()).filter((key) => key.endsWith(`/node_modules/${SDK}`));
	for (const dir of [hoisted, ...nested]) {
		try {
			const manifest = JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
			if (typeof manifest?.version !== "string") continue;
			return {
				version: manifest.version,
				claudeCode: typeof manifest.claudeCodeVersion === "string" ? manifest.claudeCodeVersion : undefined,
				location: dir,
			};
		} catch {
			// Not there: the next place.
		}
	}
	return null;
}

/** The ranges the installed packages declare for the SDK. */
function dependents(): Dependent[] {
	const packages = lockPackages();
	const result: Dependent[] = [];
	for (const [key, entry] of Object.entries(packages)) {
		for (const field of ["dependencies", "optionalDependencies"]) {
			const range = (entry?.[field] as Record<string, unknown> | undefined)?.[SDK];
			if (typeof range !== "string") continue;
			const name = key === "" ? "package.json" : key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
			result.push({ name, range });
		}
	}
	return result;
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

async function npm(command: { command: string; args: string[] }, args: string[], timeout: number, cwd = ROOT): Promise<string> {
	const { stdout } = await run(command.command, [...command.args, ...args], {
		cwd,
		timeout,
		maxBuffer: 16 * 1024 * 1024,
		env: { ...process.env, npm_config_update_notifier: "false" },
	});
	return stdout.trim();
}

/** The versions of the registry a spec matches, oldest first; `npm view` answers one version as a plain string. */
async function view(command: { command: string; args: string[] }, spec: string): Promise<string[]> {
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
 * entries, so the `npm update` that follows takes them as installed. Throws when a folder cannot be moved; what was
 * moved until then stays, and that `npm update` completes it in place.
 */
async function installBeside(command: { command: string; args: string[] }, version: string, location: string): Promise<void> {
	clearStage(location);
	mkdirSync(STAGE, { recursive: true });
	writeFileSync(path.join(STAGE, "package.json"), "{}\n");
	const stage = realpathSync(STAGE);
	await npm(command, ["install", `${SDK}@${version}`, "--prefix", stage, "--legacy-peer-deps", "--no-audit", "--no-fund"], UPDATE_TIMEOUT_MS, stage);
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

/** Checks the registry and installs the newest version the ranges allow. */
async function check(onUpdate: (from: Sdk, to: string) => void): Promise<Result> {
	const command = npmCommand();
	const installed = installedSdk();
	if (!command || !installed) return { kind: "absent" };

	const ranges = dependents();
	const latest = newest(await view(command, SDK));
	if (latest === null) throw new Error(`npm view ${SDK} answered no version`);
	let allowed: string[] | null = null;
	for (const { range } of ranges) {
		const matching = new Set(await view(command, `${SDK}@${range}`));
		allowed = allowed === null ? [...matching] : allowed.filter((v) => matching.has(v));
	}
	const wanted = allowed === null ? latest : newest(allowed);
	const blocked = compare(latest, wanted ?? installed.version) > 0 && compare(latest, installed.version) > 0
		? { latest, dependents: ranges }
		: undefined;
	if (wanted === null || compare(wanted, installed.version) <= 0) return { kind: "current", installed, blocked };

	if (!takeLock()) return { kind: "busy", installed };
	try {
		onUpdate(installed, wanted);
		try {
			await installBeside(command, wanted, installed.location);
		} catch {
			// The update below installs in place what could not be moved there, or reports why nothing can be installed.
		}
		await npm(command, ["update", SDK, "--prefix", realpathSync(ROOT), "--legacy-peer-deps", "--no-audit", "--no-fund"], UPDATE_TIMEOUT_MS);
	} finally {
		rmSync(LOCK_FILE, { force: true });
	}
	const after = installedSdk();
	if (!after || compare(after.version, installed.version) <= 0) {
		throw new Error(`npm update finished, but the SDK is still ${after?.version ?? "missing"}`);
	}
	return { kind: "updated", from: installed, to: after, blocked };
}

/** The first error line npm printed, else the first line of the message. */
function describe(error: unknown): string {
	const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
	const npmError = stderr.split("\n").find((line) => /^npm (ERR!|error) /.test(line) && !/^npm (ERR!|error) *$/.test(line));
	if (npmError) return npmError.replace(/^npm (ERR!|error) /, "").trim();
	return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

const label = (sdk: Sdk) => (sdk.claudeCode ? `${sdk.version} (Claude Code ${sdk.claudeCode})` : sdk.version);

function blockedNotice(blocked: Blocked): string {
	const ranges = blocked.dependents.map((d) => `${d.name} allows ${d.range}`).join(", ");
	const packages = blocked.dependents.filter((d) => d.name !== "package.json").map((d) => `npm:${d.name}`);
	const hint = packages.length > 0 ? ` (pi update ${packages.join(" ")})` : "";
	return `Claude Agent SDK ${blocked.latest} is out, but ${ranges}: it needs a newer package first${hint}.`;
}

function reportedVersion(): string | null {
	try {
		const reported = JSON.parse(readFileSync(STATE_FILE, "utf8"))?.reported;
		return typeof reported === "string" ? reported : null;
	} catch {
		return null;
	}
}

/**
 * The check in flight, shared by the session runtimes of this process: /reload loads this file afresh, and a session
 * started with /new or /resume while the check still runs must not start a second one.
 */
const shared = globalThis as typeof globalThis & Record<symbol, Promise<Result> | undefined>;
const CHECK = Symbol.for("pi.claude-sdk-update.check");

export default function (pi: ExtensionAPI) {
	// The context of the current session runtime; the notices of a check go to the session that is current then.
	let ctx: ExtensionContext | null = null;

	function runCheck(): Promise<Result> {
		shared[CHECK] ??= check((from, to) => {
			ctx?.ui.notify(`Updating the Claude Agent SDK ${from.version} -> ${to} …`, "info");
		})
			.catch((error): Result => ({ kind: "failed", message: describe(error) }))
			.finally(() => {
				shared[CHECK] = undefined;
			});
		return shared[CHECK];
	}

	pi.on("session_start", (event, context) => {
		ctx = context;
		if (event.reason !== "startup" || context.mode !== "tui") return;
		if (process.env.PI_SUBAGENT_DEPTH || process.env.PI_OFFLINE) return;
		if (!installedSdk()) return;
		void runCheck().then((result) => {
			if (!ctx) return;
			if (result.kind === "failed") ctx.ui.notify(`Claude Agent SDK update failed: ${result.message}`, "warning");
			if (result.kind === "updated") {
				ctx.ui.notify(`Claude Agent SDK updated ${label(result.from)} -> ${label(result.to)}. Start Pi anew to load it.`, "info");
			}
			if ((result.kind === "current" || result.kind === "updated") && result.blocked) {
				if (reportedVersion() === result.blocked.latest) return;
				ctx.ui.notify(blockedNotice(result.blocked), "info");
				try {
					writeFileSync(STATE_FILE, `${JSON.stringify({ reported: result.blocked.latest })}\n`);
				} catch {
					// Reported again at the next start.
				}
			}
		});
	});

	pi.on("session_shutdown", () => {
		ctx = null;
	});

	pi.registerCommand(COMMAND, {
		description: "Check for a newer Claude Agent SDK for pi-claude-subscription and install it",
		handler: async (_args, command) => {
			command.ui.notify("Checking the Claude Agent SDK …", "info");
			const result = await runCheck();
			const lines: string[] = [];
			let level: "info" | "warning" | "error" = "info";
			switch (result.kind) {
				case "absent":
					lines.push(`No Claude Agent SDK in ${ROOT}, or Pi's npmCommand is not npm.`);
					level = "warning";
					break;
				case "current":
					lines.push(
						result.blocked
							? `Claude Agent SDK ${label(result.installed)} is the newest the installed packages allow.`
							: `Claude Agent SDK ${label(result.installed)} is current.`,
					);
					break;
				case "updated":
					lines.push(`Claude Agent SDK updated ${label(result.from)} -> ${label(result.to)}. Start Pi anew to load it.`);
					break;
				case "busy":
					lines.push(`Another Pi process is updating the Claude Agent SDK ${label(result.installed)}.`);
					break;
				case "failed":
					lines.push(`Claude Agent SDK update failed: ${result.message}`);
					level = "error";
					break;
			}
			if ((result.kind === "current" || result.kind === "updated") && result.blocked) lines.push(blockedNotice(result.blocked));
			command.ui.notify(lines.join("\n"), level);
		},
	});
}
