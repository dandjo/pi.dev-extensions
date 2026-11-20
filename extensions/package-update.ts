/**
 * Package update: keeps the package of this extension current. At every Pi start it updates the package, and reloads
 * Pi once it is at rest when the update changed what Pi loads. It needs nothing from any provider.
 *
 * - The package of this file is the user package (pi install, not --local) whose folder holds it. Loaded another way
 *   (with -e, say) it has none and updates nothing. Every other installed package stays as it is until `pi update` by
 *   hand.
 * - On every Pi start, `pi update <source>` brings the git or npm package up to date in the background, as by hand,
 *   but in a child process whose output stays out of the terminal, and git never prompts (GIT_TERMINAL_PROMPT=0, SSH
 *   in batch mode). One Pi process updates at a time; one starting meanwhile waits and uses the result. A local folder
 *   is not updated, and subagent processes and Pi with PI_OFFLINE set update nothing.
 * - When the update changed what the package loads into Pi (package.json and the extensions, skills, prompts, and
 *   themes it names), Pi reloads by itself as soon as it is at rest in the terminal:
 *   no run or compaction, nothing queued, no prompt just submitted, and the empty prompt editor in focus, so no
 *   selector or dialog is open and no typing is lost. Until then what was loaded before stays active. A change found by
 *   an update of another Pi process counts too. /update updates and reloads right away.
 */

import {
	CustomEditor,
	DefaultPackageManager,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const GIT_TIMEOUT_MS = 60_000;
/** git rev-parse while the extensions load, which holds up Pi's start. */
const REV_PARSE_TIMEOUT_MS = 10_000;
/** A `pi update` running longer is stopped; it may install npm dependencies. */
const UPDATE_TIMEOUT_MS = 180_000;
/** Held by the Pi process that updates, with its pid inside; another one waits for it. */
const LOCK = path.join(getAgentDir(), "package-update.lock");
/** A lock this old is given up even if its process still seems to run (a pid reused). */
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_POLL_MS = 500;
/** Git must never ask: no terminal prompt, SSH in batch mode. */
const GIT_ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
};
const COMMAND = "update";
/** Marks the internal /update call that lends the automatic reload a command context. */
const RELOAD_MARK = "\u0000reload";
/** An empty widget, only there to reach the TUI for the focus check. */
const WIDGET_KEY = "package-update";
const REST_POLL_MS = 1_000;
/** A prompt submitted this recently may still be on its way to the model, before its run starts. */
const INPUT_GRACE_MS = 5_000;

const run = promisify(execFile);

/** The package this extension keeps current: the one it came with. */
interface Own {
	/** The package source in Pi's settings, as `pi update` takes it. */
	source: string;
	/** The package folder. */
	repo: string;
	/** Whether `pi update` moves it: a git or npm package, not a local folder. */
	updatable: boolean;
}

interface ConfiguredPackage {
	source: string;
	scope: "user" | "project";
	installedPath?: string;
}

/** The packages of Pi's settings, the user's and the project's of the current directory. */
function configuredPackages(): ConfiguredPackage[] {
	const agentDir = getAgentDir();
	const cwd = process.cwd();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	return new DefaultPackageManager({ cwd, agentDir, settingsManager }).listConfiguredPackages();
}

/** Pi's test for a local package source: everything without a known remote prefix. */
function isLocalSource(source: string): boolean {
	return !/^(npm|git|github|http|https|ssh|builtin):/.test(source.trim());
}

/** The user package this file came with; null when none holds it. */
function ownPackage(packages: ConfiguredPackage[]): Own | null {
	let self: string;
	try {
		self = realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return null;
	}
	for (const pkg of packages) {
		if (pkg.scope !== "user" || !pkg.installedPath) continue;
		try {
			if (self.startsWith(realpathSync(pkg.installedPath) + path.sep)) {
				return { source: pkg.source, repo: path.resolve(pkg.installedPath), updatable: !isLocalSource(pkg.source) };
			}
		} catch {
			// not installed (yet)
		}
	}
	return null;
}

async function git(args: string[], cwd?: string): Promise<string> {
	const { stdout } = await run("git", args, { cwd, timeout: GIT_TIMEOUT_MS, env: { ...process.env, ...GIT_ENV } });
	return stdout.trim();
}

/** The version in an npm package's package.json, or null. */
function packageVersion(repo: string): string | null {
	try {
		const version = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"))?.version;
		return typeof version === "string" && version ? version : null;
	} catch {
		return null;
	}
}

/** The package's commit, or for an npm package its version; null when neither is known. */
async function revision(repo: string): Promise<string | null> {
	const commit = await git(["rev-parse", "--short", "HEAD"], repo).catch(() => null);
	return commit || packageVersion(repo);
}

/** revision() while the extensions load. */
function revisionSync(repo: string): string | null {
	try {
		const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: repo,
			timeout: REV_PARSE_TIMEOUT_MS,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, ...GIT_ENV },
		}).trim();
		if (commit) return commit;
	} catch {
		// not a git checkout
	}
	return packageVersion(repo);
}

/** Runs `pi update <source>` with the Pi that runs this extension, its output kept out of the terminal. */
async function piUpdate(source: string): Promise<void> {
	const script = process.argv[1];
	const [command, args] = script && existsSync(script) ? [process.execPath, [script]] : ["pi", []];
	try {
		await run(command, [...args, "update", source], {
			cwd: getAgentDir(),
			timeout: UPDATE_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
			env: { ...process.env, ...GIT_ENV },
		});
	} catch (error) {
		const failure = error as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
		if (failure.killed) throw new Error(`pi update ran longer than ${UPDATE_TIMEOUT_MS / 1000} s`);
		const lines = `${failure.stderr ?? ""}\n${failure.stdout ?? ""}`
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		throw new Error(lines.find((line) => /error|fatal|denied|failed/i.test(line)) ?? lines.at(-1) ?? failure.message ?? "pi update failed");
	}
}

function lockOwnerAlive(): boolean {
	try {
		const pid = Number(readFileSync(path.join(LOCK, "pid"), "utf8"));
		if (!Number.isInteger(pid) || pid <= 0) return false;
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Takes the update lock and returns its release, or null when another Pi process held it and has finished: that
 * process updated the packages, so this one does not again.
 */
async function takeLock(): Promise<(() => void) | null> {
	mkdirSync(path.dirname(LOCK), { recursive: true });
	for (;;) {
		try {
			mkdirSync(LOCK);
			writeFileSync(path.join(LOCK, "pid"), String(process.pid));
			const release = () => rmSync(LOCK, { recursive: true, force: true });
			process.once("exit", release);
			return () => {
				process.off("exit", release);
				release();
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let age: number;
		try {
			age = Date.now() - statSync(LOCK).mtimeMs;
		} catch {
			return null; // released just now
		}
		// Give the owner a moment to write its pid before judging it dead.
		if (age > LOCK_STALE_MS || (age > 2_000 && !lockOwnerAlive())) {
			rmSync(LOCK, { recursive: true, force: true });
			continue;
		}
		await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
		if (!existsSync(LOCK)) return null;
	}
}

/** The package's name, else its folder. */
function label(m: Own): string {
	try {
		const name = JSON.parse(readFileSync(path.join(m.repo, "package.json"), "utf8"))?.name;
		if (typeof name === "string" && name) return name;
	} catch {
		// no package.json
	}
	return path.basename(m.repo);
}

/**
 * What of the package needs a reload when it changes: package.json and the folders of the extensions, skills, prompts,
 * and themes it names (Pi's default folders without a pi entry).
 */
function reloadPaths(m: Own): string[] {
	const paths = ["package.json"];
	let manifest: Record<string, unknown> | undefined;
	try {
		const pi = JSON.parse(readFileSync(path.join(m.repo, "package.json"), "utf8"))?.pi;
		if (pi && typeof pi === "object" && !Array.isArray(pi)) manifest = pi;
	} catch {
		manifest = undefined;
	}
	for (const kind of ["extensions", "skills", "prompts", "themes"]) {
		if (!manifest) {
			paths.push(kind);
			continue;
		}
		const entries = manifest[kind];
		for (const entry of Array.isArray(entries) ? entries : []) {
			if (typeof entry !== "string" || entry.startsWith("!")) continue;
			// A glob counts from the folder its first wildcard is in.
			const wildcard = entry.search(/[*?[{]/);
			const fixed = (wildcard < 0 ? entry : entry.slice(0, entry.lastIndexOf("/", wildcard) + 1)).replace(/^\.\//, "").replace(/\/+$/, "");
			paths.push(fixed || ".");
		}
	}
	return paths;
}

/** Whether what needs a reload differs between two revisions of the package; when in doubt, yes. */
async function reloadNeeded(m: Own, from: string | null, to: string | null): Promise<boolean> {
	if (from === to) return false;
	if (!from || !to) return true;
	try {
		await git(["diff", "--quiet", from, to, "--", ...reloadPaths(m)], m.repo);
		return false;
	} catch {
		return true;
	}
}

type UpdateResult = { from: string | null; to: string | null } | { error: string };

/**
 * The update in flight, shared by the session runtimes of this process: /reload loads this file afresh, and a session
 * started with /new or /resume while the startup update still runs must see it too. null: another Pi process did it.
 */
const shared = globalThis as typeof globalThis & Record<symbol, Promise<UpdateResult | null> | undefined>;
const UPDATE = Symbol.for("pi.package-update.update");

/**
 * Updates the package with `pi update`; concurrent callers in this process share a run, and another Pi process
 * updating meanwhile makes this one wait and skip it (null).
 */
function update(m: Own): Promise<UpdateResult | null> {
	shared[UPDATE] ??= (async () => {
		const release = await takeLock();
		if (!release) return null;
		try {
			const from = await revision(m.repo);
			await piUpdate(m.source);
			return { from, to: await revision(m.repo) };
		} catch (error) {
			return { error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
		} finally {
			release();
		}
	})().finally(() => {
		shared[UPDATE] = undefined;
	});
	return shared[UPDATE];
}

export default function (pi: ExtensionAPI) {
	let own: Own | null = null;
	try {
		own = ownPackage(configuredPackages());
	} catch {
		// Pi reports unreadable settings itself.
	}
	/** The package's revision whose resources this runtime loaded. */
	const loaded = own?.updatable ? revisionSync(own.repo) : null;

	// State of this session runtime; Pi may reuse the loaded module for the next one.
	let ctx: ExtensionContext | null = null;
	// Pi's TUI answers which component has the focus, though its TUI interface does not declare the method; without it
	// the focus counts as the editor's.
	let tui: (TUI & { getFocusedComponent?: () => unknown }) | null = null;
	// Pi emits resources_discover after session_start, at the start and at /reload alike.
	let markDiscovered = () => {};
	const discovered = new Promise<void>((resolve) => (markDiscovered = resolve));
	/** What the due reload brings, e.g. "acme updated a -> b"; null when no reload is due. */
	let due: string | null = null;
	let poll: ReturnType<typeof setInterval> | null = null;
	let lastInput = 0;

	function atRest(): boolean {
		if (!ctx || !tui) return false;
		return (
			ctx.isIdle() &&
			!ctx.hasPendingMessages() &&
			Date.now() - lastInput > INPUT_GRACE_MS &&
			ctx.ui.getEditorText() === "" &&
			(typeof tui.getFocusedComponent !== "function" || tui.getFocusedComponent() instanceof CustomEditor)
		);
	}

	function stopWaiting(): void {
		due = null;
		if (poll) clearInterval(poll);
		poll = null;
		if (tui) ctx?.ui.setWidget(WIDGET_KEY, undefined);
		tui = null;
	}

	/** Reloads through /update, which has the command context reload needs. */
	function reloadIfAtRest(): void {
		if (!ctx || due === null || !atRest()) return;
		const notice = `${due}; reloading.`;
		stopWaiting();
		ctx.ui.notify(notice, "info");
		pi.sendUserMessage(`/${COMMAND} ${RELOAD_MARK}`, { expandPromptTemplates: true });
	}

	function scheduleReload(what: string): void {
		if (!ctx) return;
		due = what;
		if (!tui) {
			ctx.ui.setWidget(
				WIDGET_KEY,
				(widgetTui) => {
					tui = widgetTui;
					return { render: () => [], invalidate: () => {} };
				},
				{ placement: "belowEditor" },
			);
		}
		reloadIfAtRest();
		if (due === null) return;
		ctx.ui.notify(`${what}; Pi reloads once it is idle.`, "info");
		poll ??= setInterval(reloadIfAtRest, REST_POLL_MS);
		poll.unref?.();
	}

	/** Schedules a reload when the package now holds resources that differ from those this runtime loaded. */
	async function checkPackage(m: Own): Promise<void> {
		const current = await revision(m.repo);
		if (!(await reloadNeeded(m, loaded, current)) || !ctx || due !== null) return;
		const what = loaded ? `${label(m)} updated ${loaded} -> ${current}` : `${label(m)} installed (${current})`;
		if (ctx.mode === "tui") scheduleReload(what);
		else if (ctx.hasUI) ctx.ui.notify(`${what}; /reload loads them.`, "info");
	}

	pi.on("resources_discover", async () => {
		markDiscovered();
	});

	pi.on("session_start", (event, context) => {
		ctx = context;
		const m = own;
		if (!m?.updatable || process.env.PI_SUBAGENT_DEPTH || process.env.PI_OFFLINE) return;
		// Only the start updates; a later session waits for an update still running, or finds one finished since its
		// resources were loaded. The check waits for the resources and then for the next macrotask, so it never runs
		// inside the start or reload that is still under way.
		const updating = event.reason === "startup" ? update(m) : shared[UPDATE];
		Promise.all([updating, discovered])
			.then(([result]) => {
				if (result && "error" in result && ctx?.hasUI) ctx.ui.notify(`Package update failed: ${label(m)}: ${result.error}`, "warning");
			})
			.then(() => new Promise((resolve) => setTimeout(resolve, 0)))
			.then(() => checkPackage(m))
			.catch((error) => {
				if (ctx?.hasUI) ctx.ui.notify(`Package update failed: ${error instanceof Error ? error.message : error}`, "warning");
			});
	});

	pi.on("input", () => {
		lastInput = Date.now();
		return { action: "continue" };
	});

	pi.on("agent_start", () => {
		lastInput = 0;
	});

	pi.on("session_shutdown", () => {
		stopWaiting();
		ctx = null;
	});

	pi.registerCommand(COMMAND, {
		description: "Update this package of extensions and reload",
		handler: async (args, command) => {
			if (args === RELOAD_MARK) {
				await command.reload();
				return;
			}
			const result = own?.updatable ? await update(own) : undefined;
			if (!own || !result) {
				command.ui.notify(
					result === null
						? "Another Pi process has just updated the package."
						: "No package to update: this file was not installed with pi install, or from a local folder, which loads as it is.",
					"info",
				);
				stopWaiting();
				await command.reload();
				return;
			}
			if ("error" in result) {
				command.ui.notify(`${label(own)}: update failed (${result.error})`, "error");
				return;
			}
			command.ui.notify(
				result.from === result.to ? `${label(own)}: already current (${result.to})` : `${label(own)}: updated ${result.from ?? "none"} -> ${result.to}`,
				"info",
			);
			stopWaiting();
			await command.reload();
		},
	});
}
