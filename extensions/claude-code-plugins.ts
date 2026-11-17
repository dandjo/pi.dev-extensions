/**
 * Claude Code plugins for Pi: the skills, hooks, and agents of the plugins of Claude Code marketplaces that are
 * installed as Pi packages, kept current. It reads Claude Code's plugin format only and needs no Claude model: the
 * plugins work with any provider.
 *
 * - A marketplace is a package in the user's Pi settings (pi install, not --local) whose folder holds
 *   .claude-plugin/marketplace.json, from git as well as from a local folder. Without one the extension does nothing.
 *   It clones nothing itself: the files are Pi's package install.
 * - On every Pi start, `pi update <source>` brings each git or npm marketplace package up to date in the background,
 *   as by hand, but in a child process whose output stays out of the terminal, and git never prompts
 *   (GIT_TERMINAL_PROMPT=0, SSH in batch mode). One Pi process updates at a time; one starting meanwhile waits and uses
 *   the result. Local folders are not updated, and subagent processes and Pi with PI_OFFLINE set update nothing.
 * - From the package, a mirror of every plugin listed in .claude-plugin/marketplace.json is built in
 *   ~/.pi/agent/claude-code-marketplaces/<name>/plugins (<name> from the package folder), adapted to Pi:
 *   - skill names get the plugin as prefix (my-plugin:guidelines -> my-plugin-guidelines), since Pi has no plugin
 *     namespaces and plain names collide between plugins;
 *   - references to the skills of the marketplace are rewritten the same way (/my-plugin:review ->
 *     /skill:my-plugin-review);
 *   - ${CLAUDE_SKILL_DIR} and ${CLAUDE_PLUGIN_ROOT} are replaced with the absolute mirror paths, which Pi does not
 *     substitute itself.
 *   A git package's mirror is rebuilt when its commit changes, a local folder's at every load.
 * - Plugin hooks and scripts are mirrored as they are. Every mirrored plugin is linked into
 *   ~/.pi/agent/claude-code-plugins, where claude-code-hooks.ts runs its hooks and claude-code-agents.ts finds its
 *   agents; a plugin name two marketplaces share goes to the first. Links into a mirror (a directory with a .source stamp, this one's or an earlier one's) are
 *   replaced or removed as the mirrors change; other entries there are left alone.
 * - When an update changed a plugin or what the package itself loads into Pi (package.json and the extensions,
 *   skills, prompts, and themes it names), Pi reloads by itself as soon as it is at rest in the terminal: no run or
 *   compaction, nothing queued, no prompt just submitted, and the empty prompt editor in focus, so no selector or
 *   dialog is open and no typing is lost. Until then what was loaded before stays active. /marketplace-update updates
 *   and reloads right away.
 * - Up to its rename this file was claude-marketplaces.ts, with the mirrors in ~/.pi/agent/claude-marketplaces and
 *   the links in ~/.pi/agent/claude-plugins. claude-code-hooks.ts and claude-code-agents.ts read the old link folder
 *   after the new one. Two days after a start first found the old folders (RETIRE_AFTER_MS), so that Pi sessions still
 *   running the old version keep their skills and hooks until they reload, the old mirrors and the links into them
 *   are deleted, and other entries of the old link folder move into ~/.pi/agent/claude-code-plugins unless the name
 *   is taken there. An old link folder that is itself a link stays as it is.
 * - Earlier versions cloned the marketplaces of ~/.pi/agent/claude-marketplaces.json into
 *   ~/.pi/agent/claude-marketplaces/<name>/repo. Such a clone is deleted unless a package lives in it; while the file
 *   is there, every start names what is left to do: the pi install of a marketplace not installed yet, or deleting it.
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
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

/** The marketplace list of earlier versions, no longer read. */
const LEGACY_CONFIG = path.join(getAgentDir(), "claude-marketplaces.json");
const ROOT = path.join(getAgentDir(), "claude-code-marketplaces");
/** Where claude-code-hooks.ts and claude-code-agents.ts look for Claude Code plugins. */
const PLUGIN_LINKS = path.join(getAgentDir(), "claude-code-plugins");
/** The folders of the version named claude-marketplaces.ts: its mirrors (and older clones), its plugin links. */
const OLD_ROOT = path.join(getAgentDir(), "claude-marketplaces");
const OLD_LINKS = path.join(getAgentDir(), "claude-plugins");
/** When a start first found the old folders; they are cleared RETIRE_AFTER_MS later. */
const RETIRE_MARK = path.join(ROOT, ".old-folders-since");
const RETIRE_AFTER_MS = 2 * 24 * 60 * 60_000;
/** The stamp in a mirror: the commit it was built from and the generator version. */
const STAMP_NAME = ".source";
const GENERATOR_VERSION = 2;
const GIT_TIMEOUT_MS = 60_000;
/** A `pi update` running longer is stopped; it may install npm dependencies. */
const UPDATE_TIMEOUT_MS = 180_000;
/** Held by the Pi process that updates, with its pid inside; another one waits for it. */
const LOCK = path.join(ROOT, ".update.lock");
/** A lock this old is given up even if its process still seems to run (a pid reused). */
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_POLL_MS = 500;
/** Git must never ask: no terminal prompt, SSH in batch mode. */
const GIT_ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
};
const COMMAND = "marketplace-update";
/** Marks the internal /marketplace-update call that lends the automatic reload a command context. */
const RELOAD_MARK = "\u0000reload";
/** An empty widget, only there to reach the TUI for the focus check. */
const WIDGET_KEY = "claude-code-plugins";
const REST_POLL_MS = 1_000;
/** A prompt submitted this recently may still be on its way to the model, before its run starts. */
const INPUT_GRACE_MS = 5_000;

const run = promisify(execFile);

interface Marketplace {
	/** The package source in Pi's settings, as `pi update` takes it. */
	source: string;
	/** Whether `pi update` moves it: a git or npm package, not a local folder. */
	updatable: boolean;
	/** The directory name below ROOT, from the package folder. */
	slug: string;
	/** The package folder. */
	repo: string;
	out: string;
	stamp: string;
}

interface Plugin {
	name: string;
	dir: string;
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

/** The marketplaces among the user's packages, in the order of the settings. */
function findMarketplaces(packages: ConfiguredPackage[]): Marketplace[] {
	const found: { source: string; repo: string }[] = [];
	for (const pkg of packages) {
		if (pkg.scope !== "user" || !pkg.installedPath) continue;
		const repo = path.resolve(pkg.installedPath);
		if (found.some((m) => m.repo === repo)) continue;
		if (existsSync(path.join(repo, ".claude-plugin", "marketplace.json"))) found.push({ source: pkg.source, repo });
	}
	const base = (repo: string) => path.basename(repo).replace(/[^A-Za-z0-9._-]+/g, "-") || "marketplace";
	const counts = new Map<string, number>();
	for (const { repo } of found) counts.set(base(repo), (counts.get(base(repo)) ?? 0) + 1);
	return found.map(({ source, repo }) => {
		const name = base(repo);
		const slug = (counts.get(name) ?? 0) > 1 ? `${name}-${createHash("sha256").update(repo).digest("hex").slice(0, 6)}` : name;
		const out = path.join(ROOT, slug, "plugins");
		return { source, updatable: !isLocalSource(source), slug, repo, out, stamp: path.join(out, STAMP_NAME) };
	});
}

async function git(args: string[], cwd?: string): Promise<string> {
	const { stdout } = await run("git", args, { cwd, timeout: GIT_TIMEOUT_MS, env: { ...process.env, ...GIT_ENV } });
	return stdout.trim();
}

/** The package's commit, or for an npm package its version; null when neither is known. */
async function revision(m: Marketplace): Promise<string | null> {
	const commit = await git(["rev-parse", "--short", "HEAD"], m.repo).catch(() => null);
	if (commit) return commit;
	try {
		const version = JSON.parse(readFileSync(path.join(m.repo, "package.json"), "utf8"))?.version;
		return typeof version === "string" && version ? version : null;
	} catch {
		return null;
	}
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
	mkdirSync(ROOT, { recursive: true });
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

/** A git URL or package source reduced to host/path, to tell whether two name the same repository. */
function repoIdentity(source: string): string {
	return source
		.trim()
		.replace(/^git:(?!\/\/)/, "")
		.replace(/^[a-z+]+:\/\//i, "")
		.replace(/^[^@/:]+@/, "")
		.replace(/^([^/:]+):(?!\d)/, "$1/")
		.replace(/^([^/]+):\d+\//, "$1/")
		.replace(/@[^/]*$/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.toLowerCase();
}

/** What is left to do about the marketplace list of earlier versions; null without the file. */
function legacyNotice(packages: ConfiguredPackage[]): string | null {
	let text: string;
	try {
		text = readFileSync(LEGACY_CONFIG, "utf8");
	} catch {
		return null;
	}
	let urls: string[] = [];
	try {
		const map = JSON.parse(text)?.marketplaces;
		if (map && typeof map === "object" && !Array.isArray(map)) urls = Object.keys(map).map((url) => url.trim()).filter(Boolean);
	} catch {
		// Unreadable: nothing in it to carry over.
	}
	const installed = new Set(packages.filter((pkg) => pkg.scope === "user").map((pkg) => repoIdentity(pkg.source)));
	const missing = urls.filter((url) => !installed.has(repoIdentity(url)));
	if (missing.length === 0) return `${LEGACY_CONFIG} is no longer read; delete it.`;
	const install = (url: string) => (/^[a-z+]+:\/\//i.test(url) ? url : `git:${url.replace(/\.git$/, "")}`);
	return `${LEGACY_CONFIG} is no longer read: Claude Code marketplaces are Pi packages now. Run ${missing
		.map((url) => `!!pi install ${install(url)}`)
		.join(", ")}, then delete the file.`;
}

/** Deletes the clones earlier versions kept in OLD_ROOT/<name>/repo, unless a configured package lives in one. */
function removeLegacyClones(packages: ConfiguredPackage[]): void {
	if (!existsSync(OLD_ROOT)) return;
	const used = packages.flatMap((pkg) => (pkg.installedPath ? [path.resolve(pkg.installedPath)] : []));
	for (const entry of readdirSync(OLD_ROOT, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const clone = path.join(OLD_ROOT, entry.name, "repo");
		if (!existsSync(path.join(clone, ".git"))) continue;
		if (used.some((dir) => dir === clone || dir.startsWith(clone + path.sep))) continue;
		rmSync(clone, { recursive: true, force: true });
	}
}

/** Whether something is at that path, a broken link included. */
function present(file: string): boolean {
	try {
		lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * Clears the folders of the version named claude-marketplaces.ts, RETIRE_AFTER_MS after a start first found them:
 * until then Pi sessions still running that version read their skills and hooks there. The mirrors and the links into
 * them go, and so do links whose name PLUGIN_LINKS has already or whose target is gone; other entries of the old link
 * folder move into PLUGIN_LINKS, and an old link folder that is itself a link stays. A clone a configured package lives in stays too (removeLegacyClones), with
 * the folders around it.
 */
function retireOldFolders(): void {
	if (!present(OLD_ROOT) && !present(OLD_LINKS)) {
		rmSync(RETIRE_MARK, { force: true });
		return;
	}
	let since = Number.NaN;
	try {
		since = Number(readFileSync(RETIRE_MARK, "utf8"));
	} catch {
		// first found now
	}
	if (!Number.isFinite(since) || since <= 0) {
		mkdirSync(ROOT, { recursive: true });
		writeFileSync(RETIRE_MARK, String(Date.now()));
		return;
	}
	if (Date.now() - since < RETIRE_AFTER_MS) return;

	if (present(OLD_LINKS) && !lstatSync(OLD_LINKS).isSymbolicLink()) {
		for (const entry of readdirSync(OLD_LINKS, { withFileTypes: true })) {
			const from = path.join(OLD_LINKS, entry.name);
			if (entry.isSymbolicLink()) {
				let target: string | null = null;
				try {
					target = path.resolve(OLD_LINKS, readlinkSync(from));
				} catch {
					// unreadable: moved like any other entry
				}
				const intoMirror =
					target !== null &&
					(target.startsWith(OLD_ROOT + path.sep) ||
						existsSync(path.join(path.dirname(target), STAMP_NAME)) ||
						(!existsSync(target) && target.startsWith(getAgentDir() + path.sep)));
				if (intoMirror) {
					rmSync(from, { force: true });
					continue;
				}
			}
			const to = path.join(PLUGIN_LINKS, entry.name);
			if (entry.isSymbolicLink() && (present(to) || !existsSync(from))) {
				// shadowed by the new folder, or pointing nowhere: a link holds nothing to keep
				rmSync(from, { force: true });
				continue;
			}
			if (present(to)) continue;
			mkdirSync(PLUGIN_LINKS, { recursive: true });
			try {
				renameSync(from, to);
			} catch {
				// another Pi process moved it
			}
		}
		try {
			rmdirSync(OLD_LINKS);
		} catch {
			// a name taken in the new folder keeps its entry here
		}
	}

	if (present(OLD_ROOT)) {
		for (const entry of readdirSync(OLD_ROOT, { withFileTypes: true })) {
			const dir = path.join(OLD_ROOT, entry.name);
			if (entry.name === ".update.lock") {
				rmSync(dir, { recursive: true, force: true });
				continue;
			}
			if (!entry.isDirectory()) continue;
			const mirror = path.join(dir, "plugins");
			if (existsSync(path.join(mirror, STAMP_NAME))) rmSync(mirror, { recursive: true, force: true });
			for (const leftover of ["plugins.old", "plugins.tmp"]) rmSync(path.join(dir, leftover), { recursive: true, force: true });
			try {
				rmdirSync(dir);
			} catch {
				// a clone a package lives in, or something else's
			}
		}
		try {
			rmdirSync(OLD_ROOT);
		} catch {
			// not empty
		}
	}
	if (!present(OLD_ROOT) && !present(OLD_LINKS)) rmSync(RETIRE_MARK, { force: true });
}

/** The marketplace's name in its manifest, else the directory name. */
function label(m: Marketplace): string {
	try {
		const name = JSON.parse(readFileSync(path.join(m.repo, ".claude-plugin", "marketplace.json"), "utf8"))?.name;
		return typeof name === "string" && name ? name : m.slug;
	} catch {
		return m.slug;
	}
}

/** The plugins of the manifest whose source is a directory in the clone; others (github, url) are not mirrored. */
function marketplacePlugins(m: Marketplace): Plugin[] {
	const manifest = JSON.parse(readFileSync(path.join(m.repo, ".claude-plugin", "marketplace.json"), "utf8"));
	const plugins: Plugin[] = [];
	for (const entry of manifest.plugins ?? []) {
		if (typeof entry?.name !== "string" || typeof entry?.source !== "string") continue;
		const dir = path.resolve(m.repo, entry.source);
		if (dir.startsWith(m.repo + path.sep) && existsSync(dir)) plugins.push({ name: entry.name, dir });
	}
	return plugins;
}

function skillDirs(pluginDir: string): string[] {
	const skillsDir = path.join(pluginDir, "skills");
	if (!existsSync(skillsDir)) return [];
	return readdirSync(skillsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(path.join(skillsDir, entry.name, "SKILL.md")))
		.map((entry) => entry.name);
}

function markdownFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...markdownFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
	}
	return files;
}

function frontmatterName(skillFile: string): string | null {
	const match = readFileSync(skillFile, "utf8").match(/^---\r?\n[\s\S]*?^name:\s*["']?([a-z0-9-]+)["']?\s*$/m);
	return match ? match[1] : null;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Builds the Pi mirror of all plugins of a marketplace from its clone and swaps it in atomically. */
function generate(m: Marketplace, commit: string): void {
	const plugins = marketplacePlugins(m);

	// "my-plugin:guidelines" -> "my-plugin-guidelines", for every skill that exists.
	const skillNames = new Map<string, string>();
	for (const plugin of plugins) {
		for (const dir of skillDirs(plugin.dir)) {
			const name = frontmatterName(path.join(plugin.dir, "skills", dir, "SKILL.md")) ?? dir;
			skillNames.set(`${plugin.name}:${name}`, `${plugin.name}-${name}`);
		}
	}
	const reference =
		plugins.length > 0 ? new RegExp(`(\\/?)\\b((?:${plugins.map((p) => escapeRegExp(p.name)).join("|")}):[a-z0-9-]+)`, "g") : null;

	const tmp = `${m.out}.tmp`;
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	for (const plugin of plugins) {
		const target = path.join(tmp, plugin.name);
		const finalRoot = path.join(m.out, plugin.name);
		cpSync(plugin.dir, target, { recursive: true });

		for (const file of markdownFiles(target)) {
			const relative = path.relative(target, file).split(path.sep);
			let text = readFileSync(file, "utf8");

			text = text.replaceAll("${CLAUDE_PLUGIN_ROOT}", finalRoot);
			if (relative[0] === "skills" && relative.length > 2) {
				text = text.replaceAll("${CLAUDE_SKILL_DIR}", path.join(finalRoot, "skills", relative[1]));
			}
			if (reference) {
				text = text.replace(reference, (whole, slash: string, ref: string) => {
					const piName = skillNames.get(ref);
					if (!piName) return whole;
					return slash ? `/skill:${piName}` : piName;
				});
			}
			if (relative[0] === "skills" && relative.length === 3 && relative[2] === "SKILL.md") {
				text = text.replace(
					/^(---\r?\n[\s\S]*?^name:\s*["']?)([a-z0-9-]+)(["']?\s*$)/m,
					(_whole, before: string, name: string, after: string) => `${before}${plugin.name}-${name}${after}`,
				);
			}
			writeFileSync(file, text);
		}
	}
	writeFileSync(path.join(tmp, STAMP_NAME), `${commit} ${GENERATOR_VERSION}\n`);

	const old = `${m.out}.old`;
	rmSync(old, { recursive: true, force: true });
	if (existsSync(m.out)) renameSync(m.out, old);
	renameSync(tmp, m.out);
	rmSync(old, { recursive: true, force: true });
}

/** The plugin directories of the mirrors, by name; a name two marketplaces share goes to the first. */
function mirroredPlugins(marketplaces: Marketplace[]): Map<string, string> {
	const result = new Map<string, string>();
	for (const m of marketplaces) {
		if (!existsSync(m.out)) continue;
		for (const entry of readdirSync(m.out, { withFileTypes: true })) {
			if (entry.isDirectory() && !result.has(entry.name)) result.set(entry.name, path.join(m.out, entry.name));
		}
	}
	return result;
}

/**
 * Links every mirrored plugin into PLUGIN_LINKS. A link into a mirror (its target's directory holds a .source stamp)
 * that no longer names the mirrored plugin is replaced or removed, and so is a broken link into Pi's agent directory or
 * of a mirrored plugin's name, wherever it points; every other entry belongs to someone else and stays as it is.
 */
function linkPlugins(marketplaces: Marketplace[]): void {
	const wanted = mirroredPlugins(marketplaces);
	mkdirSync(PLUGIN_LINKS, { recursive: true });
	for (const entry of readdirSync(PLUGIN_LINKS, { withFileTypes: true })) {
		if (!entry.isSymbolicLink()) continue;
		const link = path.join(PLUGIN_LINKS, entry.name);
		let target: string;
		try {
			target = path.resolve(PLUGIN_LINKS, readlinkSync(link));
		} catch {
			continue;
		}
		const intoMirror = existsSync(path.join(path.dirname(target), STAMP_NAME));
		const broken = !existsSync(target) && (target.startsWith(getAgentDir() + path.sep) || wanted.has(entry.name));
		if ((intoMirror || broken) && wanted.get(entry.name) !== target) rmSync(link, { force: true });
	}
	for (const [name, dir] of wanted) {
		const link = path.join(PLUGIN_LINKS, name);
		try {
			lstatSync(link);
			continue; // ours already, or someone else's plugin of that name
		} catch {
			// not there yet
		}
		try {
			symlinkSync(dir, link, "dir");
		} catch {
			// another Pi process was quicker
		}
	}
}

function isCurrent(m: Marketplace, commit: string): boolean {
	return existsSync(m.stamp) && readFileSync(m.stamp, "utf8").trim() === `${commit} ${GENERATOR_VERSION}`;
}

/**
 * What of a package needs a reload when it changes: the plugin list, the plugins, and what the package itself loads
 * into Pi — package.json and the folders of its extensions, skills, prompts, and themes (Pi's default folders without
 * a pi entry in package.json).
 */
function reloadPaths(m: Marketplace): string[] {
	const paths = [".claude-plugin/marketplace.json", "package.json"];
	try {
		paths.push(...marketplacePlugins(m).map((plugin) => path.relative(m.repo, plugin.dir)));
	} catch {
		// No readable manifest: the manifest path itself covers it.
	}
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

/** Whether what needs a reload differs between two revisions of a package; when in doubt, yes. */
async function reloadNeeded(m: Marketplace, from: string | null, to: string | null): Promise<boolean> {
	if (from === to) return false;
	if (!from || !to) return true;
	try {
		await git(["diff", "--quiet", from, to, "--", ...reloadPaths(m)], m.repo);
		return false;
	} catch {
		return true;
	}
}

function skillPaths(marketplaces: Marketplace[]): string[] {
	return [...mirroredPlugins(marketplaces).values()]
		.map((dir) => path.join(dir, "skills"))
		.filter((dir) => existsSync(dir));
}

type UpdateResult = { m: Marketplace; from: string | null; to: string | null } | { m: Marketplace; error: string };

/**
 * The update in flight, shared by the session runtimes of this process: /reload loads this file afresh, and a session
 * started with /new or /resume while the startup update still runs must see it too. null: another Pi process did it.
 */
const shared = globalThis as typeof globalThis & Record<symbol, Promise<UpdateResult[] | null> | undefined>;
const UPDATE = Symbol.for("pi.claude-code-plugins.update");

/**
 * Updates every git and npm marketplace package with `pi update` and rebuilds the mirrors that changed, one failing not
 * holding up the others; concurrent callers in this process share a run, and another Pi process updating meanwhile
 * makes this one wait and skip it (null).
 */
function update(marketplaces: Marketplace[]): Promise<UpdateResult[] | null> {
	shared[UPDATE] ??= (async () => {
		const updatable = marketplaces.filter((m) => m.updatable);
		if (updatable.length === 0) return [];
		const release = await takeLock();
		if (!release) return null;
		try {
			const results: UpdateResult[] = [];
			for (const m of updatable) {
				try {
					const from = await revision(m);
					await piUpdate(m.source);
					const to = await revision(m);
					if (to && !isCurrent(m, to)) generate(m, to);
					results.push({ m, from, to });
				} catch (error) {
					results.push({ m, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
				}
			}
			linkPlugins(marketplaces);
			return results;
		} finally {
			release();
		}
	})().finally(() => {
		shared[UPDATE] = undefined;
	});
	return shared[UPDATE];
}

export default function (pi: ExtensionAPI) {
	let packages: ConfiguredPackage[];
	try {
		packages = configuredPackages();
	} catch {
		return; // Pi reports unreadable settings itself.
	}
	const marketplaces = findMarketplaces(packages);
	const legacy = legacyNotice(packages);
	if (!process.env.PI_SUBAGENT_DEPTH) {
		try {
			removeLegacyClones(packages);
		} catch {
			// The next start retries.
		}
		try {
			retireOldFolders();
		} catch {
			// The next start retries.
		}
	}
	if (legacy && !process.env.PI_SUBAGENT_DEPTH) {
		pi.on("session_start", (event, ctx) => {
			if (event.reason === "startup" && ctx.hasUI) ctx.ui.notify(legacy, "warning");
		});
	}
	if (marketplaces.length === 0) {
		// A marketplace removed since: its links go, so claude-code-hooks.ts no longer runs the hooks of its copy.
		if (!process.env.PI_SUBAGENT_DEPTH && existsSync(PLUGIN_LINKS)) {
			try {
				linkPlugins([]);
			} catch {
				// The next start retries.
			}
		}
		return;
	}

	// Before any session_start, when claude-code-hooks.ts reads the plugins: the links of the mirrors as they are.
	if (!process.env.PI_SUBAGENT_DEPTH) {
		try {
			linkPlugins(marketplaces);
		} catch {
			// The next start or update retries.
		}
	}

	// State of this session runtime; Pi may reuse the loaded module for the next one.
	let ctx: ExtensionContext | null = null;
	// Pi's TUI answers which component has the focus, though its TUI interface does not declare the method; without it
	// the focus counts as the editor's.
	let tui: (TUI & { getFocusedComponent?: () => unknown }) | null = null;
	/** The revision per marketplace package (by folder) whose plugins and resources this runtime loaded. */
	const loaded = new Map<string, string | null>();
	// Pi emits resources_discover after session_start, at the start and at /reload alike.
	let markDiscovered = () => {};
	const discovered = new Promise<void>((resolve) => (markDiscovered = resolve));
	/** What the due reload brings, e.g. "acme plugins updated a -> b"; null when no reload is due. */
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

	/** Reloads through /marketplace-update, which has the command context reload needs. */
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

	/** Schedules a reload when a package now holds plugins or resources that differ from those this runtime loaded. */
	async function checkPackages(): Promise<void> {
		const changes: string[] = [];
		for (const m of marketplaces) {
			if (!m.updatable || !loaded.has(m.repo)) continue;
			const before = loaded.get(m.repo) ?? null;
			const current = await revision(m);
			if (!(await reloadNeeded(m, before, current))) continue;
			changes.push(before ? `${label(m)} updated ${before} -> ${current}` : `${label(m)} installed (${current})`);
		}
		if (changes.length === 0 || !ctx || due !== null) return;
		const what = changes.join("; ");
		if (ctx.mode === "tui") scheduleReload(what);
		else if (ctx.hasUI) ctx.ui.notify(`${what}; /reload loads them.`, "info");
	}

	pi.on("resources_discover", async () => {
		let generated = false;
		for (const m of marketplaces) {
			const current = await revision(m);
			// A local folder may have changed without a commit, so its mirror is rebuilt at every load, though not by
			// subagent processes, which use the mirror of the Pi that started them.
			const stamp = m.updatable ? current : process.env.PI_SUBAGENT_DEPTH ? null : `${current ?? "local"}+${Date.now().toString(36)}`;
			if (stamp && !isCurrent(m, stamp)) {
				try {
					generate(m, stamp);
					generated = true;
				} catch {
					// Keep the previous mirror; the next update retries.
				}
			}
			loaded.set(m.repo, current);
		}
		if (generated) {
			try {
				linkPlugins(marketplaces);
			} catch {
				// The next start or update retries.
			}
		}
		markDiscovered();
		return { skillPaths: skillPaths(marketplaces) };
	});

	pi.on("session_start", (event, context) => {
		ctx = context;
		if (process.env.PI_SUBAGENT_DEPTH || process.env.PI_OFFLINE) return;
		// Only the start updates; a later session waits for an update still running, or finds one finished since its
		// resources were loaded. The check waits for the resources and then for the next macrotask, so it never runs
		// inside the start or reload that is still under way.
		const updating = event.reason === "startup" ? update(marketplaces) : shared[UPDATE];
		Promise.all([updating, discovered])
			.then(([results]) => {
				const failed = (results ?? []).filter((r): r is Extract<UpdateResult, { error: string }> => "error" in r);
				if (failed.length > 0 && ctx?.hasUI) {
					ctx.ui.notify(`Marketplace update failed: ${failed.map((r) => `${label(r.m)}: ${r.error}`).join("; ")}`, "warning");
				}
			})
			.then(() => new Promise((resolve) => setTimeout(resolve, 0)))
			.then(checkPackages)
			.catch((error) => {
				if (ctx?.hasUI) ctx.ui.notify(`Marketplace update failed: ${error instanceof Error ? error.message : error}`, "warning");
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
		description: "Update the Claude Code marketplace packages and reload their plugins",
		handler: async (args, command) => {
			if (args === RELOAD_MARK) {
				await command.reload();
				return;
			}
			const results = await update(marketplaces);
			if (results === null || results.length === 0) {
				command.ui.notify(results === null ? "Another Pi process has just updated the marketplace packages." : "No marketplace package to update: local folders load as they are.", "info");
				stopWaiting();
				await command.reload();
				return;
			}
			const lines = results.map((r) =>
				"error" in r
					? `${label(r.m)}: update failed (${r.error})`
					: r.from === r.to
						? `${label(r.m)}: already current (${r.to})`
						: `${label(r.m)}: updated ${r.from ?? "none"} -> ${r.to}`,
			);
			const ok = results.some((r) => !("error" in r));
			command.ui.notify(lines.join("\n"), ok ? "info" : "error");
			if (!ok) return;
			stopWaiting();
			await command.reload();
		},
	});
}
