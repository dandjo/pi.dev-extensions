/**
 * Resume fix for pi-claude-subscription: brings the fixes of that provider's pull request #4 ("Resume correctly after
 * edited history", https://github.com/jkeskikangas/pi-claude-subscription/pull/4) into an installed version without
 * them.
 *
 * - Up to 0.2.4 the provider, after a change in older messages (a cut by context-gc, any context edit), resumes Claude
 *   Code's transcript at the last unchanged message and sends everything after it as one user turn: every later
 *   response is lost, without an error. With the pull request it writes them into a fork of the transcript instead,
 *   and the cached part before the change stays cached.
 * - At every Pi start in the terminal it looks for pi-claude-subscription among the configured packages. When the
 *   files the pull request changes are exactly those of a version it knows (0.2.4), it fetches the pull request's
 *   versions from GitHub at a fixed commit, checks them against the SHA-256 it carries, and puts them in place, each
 *   with a rename, after all of them have arrived. Then Pi reloads once it is at rest, and the provider runs with the
 *   fix.
 * - It warns at every start until something is done about it: with an error when the fix cannot be applied (a version
 *   or files it does not know, the fixed files no longer on GitHub), since Claude then loses the responses after a
 *   change in older messages; with a warning when the installed version has the fix itself (a release with the pull
 *   request merged), since this extension is no longer needed then.
 * - A reinstall of the package, for a newer version on npm, brings the old files back; the next start fixes them again.
 * - /claude-sdk-resume-fix shows the state and applies the fix at once.
 * - Pi in print, JSON, or RPC mode, subagents, and Pi with PI_OFFLINE set do not check. One Pi process patches at a
 *   time, through a lock file in Pi's agent folder; one starting meanwhile waits and reloads as well.
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
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import * as path from "node:path";

const PACKAGE = "pi-claude-subscription";
const COMMAND = "claude-sdk-resume-fix";
/** Marks the internal /claude-sdk-resume-fix call that lends the automatic reload a command context. */
const RELOAD_MARK = "\u0000reload";
const WIDGET_KEY = "claude-sdk-resume-fix";
const LOCK_FILE = path.join(getAgentDir(), ".claude-sdk-resume-fix.lock");
const STALE_LOCK_MS = 5 * 60_000;
const LOCK_WAIT_MS = 2 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const REST_POLL_MS = 1_000;
/** Time after the last keystroke during which Pi does not count as at rest. */
const INPUT_GRACE_MS = 5_000;
const SOURCE = "https://raw.githubusercontent.com/jkeskikangas/pi-claude-subscription";

interface Fix {
	version: string;
	/** The head of the pull request, where the fixed files come from. */
	commit: string;
	/** Each file the pull request changes, with its SHA-256 in the release and with the fix. */
	files: Record<string, { release: string; fixed: string }>;
}

const FIXES: Fix[] = [
	{
		version: "0.2.4",
		commit: "d9b91699f2bc9356fae4e11e6c0fd10940de82b7",
		files: {
			"src/cc-sessions.ts": {
				release: "c76a7fadcc05e9942e48858896f95091247fcdcc0bcf05b4c2a170a110430202",
				fixed: "e3ea8030af68b9c2465352ee8206454c90cec97c2aa8711fd10f6d9cb3c00baf",
			},
			"src/provider.ts": {
				release: "966607ccba5c8c3b834af3c89181a37bea62d9ffa97ac4e940c40ed62dca93d4",
				fixed: "5db2705328952918e5ad668af5cebd59477fe6e3935b915ff35feeb580e3fa6f",
			},
			"src/session.ts": {
				release: "5dc9047779ca26a7b424b4e6cbfdbd3f7692e9b62a6c629a1fbf5cf5661ce137",
				fixed: "f5738d19d91fc3db1cdf44e249a3c3e51159f1acb89887e4d490e45d0559ef30",
			},
		},
	},
];

type State =
	| { kind: "absent" }
	/** patch: by this extension; release: a version it has no patch for has the fix itself; other: patched otherwise. */
	| { kind: "fixed"; version: string; by: "patch" | "release" | "other" }
	| { kind: "due"; dir: string; version: string; fix: Fix; files: string[] }
	| { kind: "unknown"; version: string };

type Outcome = State | { kind: "patched"; version: string; files: number } | { kind: "busy" };

function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function fileHash(file: string): string | null {
	try {
		return sha256(readFileSync(file));
	} catch {
		return null;
	}
}

/** The configured pi-claude-subscription, its folder and version. The package listing is the same as in claude-marketplaces.ts. */
function findPackage(): { dir: string; version: string } | null {
	const agentDir = getAgentDir();
	const cwd = process.cwd();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	for (const pkg of new DefaultPackageManager({ cwd, agentDir, settingsManager }).listConfiguredPackages()) {
		if (!pkg.installedPath) continue;
		const dir = path.resolve(pkg.installedPath);
		try {
			const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
			if (manifest?.name === PACKAGE) return { dir, version: String(manifest.version ?? "unknown") };
		} catch {
			// Not a package with a manifest.
		}
	}
	return null;
}

function inspect(): State {
	const pkg = findPackage();
	if (!pkg) return { kind: "absent" };
	const { dir, version } = pkg;
	const fix = FIXES.find((f) => f.version === version);
	if (fix) {
		const files = Object.entries(fix.files).map(([file, hashes]) => ({ file, hashes, actual: fileHash(path.join(dir, file)) }));
		if (files.every((f) => f.actual === f.hashes.fixed)) return { kind: "fixed", version, by: "patch" };
		if (files.every((f) => f.actual === f.hashes.fixed || f.actual === f.hashes.release)) {
			return { kind: "due", dir, version, fix, files: files.filter((f) => f.actual === f.hashes.release).map((f) => f.file) };
		}
	}
	// The fix from elsewhere, a release with the pull request merged above all: its writer appends to a fork and records
	// the entries it wrote.
	try {
		const sessions = readFileSync(path.join(dir, "src", "cc-sessions.ts"), "utf8");
		const provider = readFileSync(path.join(dir, "src", "provider.ts"), "utf8");
		if (sessions.includes("appendToSession") && provider.includes("rememberWritten")) {
			return { kind: "fixed", version, by: fix ? "other" : "release" };
		}
	} catch {
		// Files moved or renamed: a version this extension does not know.
	}
	return { kind: "unknown", version };
}

/** A lock file shared by the Pi processes; one older than STALE_LOCK_MS counts as left over (as in claude-sdk-update.ts). */
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

/** Fetches and checks every file first; only then each takes its place with a rename. */
async function apply(state: Extract<State, { kind: "due" }>): Promise<void> {
	const fetched = new Map<string, Buffer>();
	for (const file of state.files) {
		const url = `${SOURCE}/${state.fix.commit}/${file}`;
		const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
		const data = Buffer.from(await response.arrayBuffer());
		const hash = sha256(data);
		if (hash !== state.fix.files[file]?.fixed) throw new Error(`${url} has unexpected content (SHA-256 ${hash.slice(0, 12)}…)`);
		fetched.set(file, data);
	}
	for (const [file, data] of fetched) {
		const target = path.join(state.dir, file);
		const temp = `${target}.${process.pid}.resume-fix`;
		writeFileSync(temp, data);
		renameSync(temp, target);
	}
}

/** Applies the fix when it is due. "patched" also when another Pi process applied it while this one waited. */
async function run(): Promise<Outcome> {
	const before = inspect();
	if (before.kind !== "due") return before;
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (!takeLock()) {
		if (Date.now() > deadline) return { kind: "busy" };
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	try {
		const state = inspect();
		if (state.kind === "fixed") return { kind: "patched", version: state.version, files: 0 };
		if (state.kind !== "due") return state;
		await apply(state);
		return { kind: "patched", version: state.version, files: state.files.length };
	} finally {
		rmSync(LOCK_FILE, { force: true });
	}
}

function unknownNotice(version: string): string {
	return (
		`The resume fix cannot be applied to ${PACKAGE} ${version}: it knows neither this version nor its files. ` +
		"After a change in older messages, for example a cut by context-gc, Claude loses the responses that follow it. " +
		`See https://github.com/jkeskikangas/pi-claude-subscription/pull/4; /${COMMAND} shows the state.`
	);
}

function failedNotice(error: unknown): string {
	return (
		`The resume fix for ${PACKAGE} could not be applied: ${error instanceof Error ? error.message : error}. ` +
		"Until it is, Claude loses the responses after a change in older messages, for example a cut by context-gc."
	);
}

function obsoleteNotice(version: string): string {
	return `${PACKAGE} ${version} has the fix of its pull request #4 itself: ${COMMAND}.ts is no longer needed, remove it.`;
}

function patchedNotice(outcome: Extract<Outcome, { kind: "patched" }>): string {
	return outcome.files > 0
		? `${PACKAGE} ${outcome.version}: applied the fix of its pull request #4 for resuming after edited history (${outcome.files} files)`
		: `${PACKAGE} ${outcome.version}: another Pi process applied the fix of its pull request #4`;
}

export default function (pi: ExtensionAPI) {
	// State of this session runtime; Pi may reuse the loaded module for the next one.
	let ctx: ExtensionContext | null = null;
	// Pi's TUI answers which component has the focus, though its TUI interface does not declare the method; without it
	// the focus counts as the editor's.
	let tui: (TUI & { getFocusedComponent?: () => unknown }) | null = null;
	/** What the due reload brings; null when no reload is due. */
	let due: string | null = null;
	let poll: ReturnType<typeof setInterval> | null = null;
	let lastInput = 0;

	// The reload while at rest is the same as in claude-marketplaces.ts.
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

	/** Reloads through /claude-sdk-resume-fix, which has the command context reload needs. */
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

	pi.on("session_start", (event, context) => {
		ctx = context;
		if (event.reason !== "startup" || context.mode !== "tui") return;
		if (process.env.PI_SUBAGENT_DEPTH || process.env.PI_OFFLINE) return;
		void run()
			.then((outcome) => {
				if (!ctx) return;
				if (outcome.kind === "patched") scheduleReload(patchedNotice(outcome));
				if (outcome.kind === "unknown") ctx.ui.notify(unknownNotice(outcome.version), "error");
				if (outcome.kind === "fixed" && outcome.by === "release") ctx.ui.notify(obsoleteNotice(outcome.version), "warning");
			})
			.catch((error) => ctx?.ui.notify(`${failedNotice(error)} The next start tries again.`, "error"));
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
		description: "Show whether pi-claude-subscription resumes correctly after edited history, and apply the fix",
		handler: async (args, command) => {
			if (args === RELOAD_MARK) {
				await command.reload();
				return;
			}
			let outcome: Outcome;
			try {
				outcome = await run();
			} catch (error) {
				command.ui.notify(failedNotice(error), "error");
				return;
			}
			switch (outcome.kind) {
				case "absent":
					command.ui.notify(`${PACKAGE} is not among Pi's configured packages; nothing to fix.`, "info");
					return;
				case "fixed":
					if (outcome.by === "release") command.ui.notify(obsoleteNotice(outcome.version), "warning");
					else {
						command.ui.notify(
							outcome.by === "patch"
								? `${PACKAGE} ${outcome.version} has the fix of its pull request #4, applied by this extension. A Pi started before it was applied needs /reload.`
								: `${PACKAGE} ${outcome.version} has the fix of its pull request #4 in other files than this extension brings.`,
							"info",
						);
					}
					return;
				case "patched":
					command.ui.notify(`${patchedNotice(outcome)}; reloading.`, "info");
					stopWaiting();
					await command.reload();
					return;
				case "busy":
					command.ui.notify("Another Pi process is applying the fix; try again in a moment.", "info");
					return;
				case "unknown":
					command.ui.notify(unknownNotice(outcome.version), "error");
					return;
				case "due":
					return;
			}
		},
	});
}
