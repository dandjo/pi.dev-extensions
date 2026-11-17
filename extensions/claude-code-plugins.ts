/**
 * Claude Code plugins for Pi: the skills, hooks, and agents of the plugins of Claude Code marketplaces that are
 * installed as Pi packages. It reads Claude Code's plugin format only and needs no Claude model: the plugins work with
 * any provider.
 *
 * - A marketplace is a package in the user's Pi settings (pi install, not --local) whose folder holds
 *   .claude-plugin/marketplace.json, from git as well as from a local folder. Without one the extension does nothing.
 *   It clones nothing itself: the files are Pi's package install.
 * - package-update.ts keeps the marketplace packages current: this extension asks it to over the event bus
 *   ("package-update:packages"), with the plugin list and the plugins as what needs a reload when it changes. Without
 *   it a package stays as installed until `pi update` by hand.
 * - From the package, a mirror of every plugin listed in .claude-plugin/marketplace.json is built in
 *   ~/.pi/agent/claude-code-marketplaces/<name>/plugins (<name> from the package folder), adapted to Pi:
 *   - skill names get the plugin as prefix (my-plugin:guidelines -> my-plugin-guidelines), since Pi has no plugin
 *     namespaces and plain names collide between plugins;
 *   - references to the skills of the marketplace are rewritten the same way (/my-plugin:review ->
 *     /skill:my-plugin-review);
 *   - ${CLAUDE_SKILL_DIR} and ${CLAUDE_PLUGIN_ROOT} are replaced with the absolute mirror paths, which Pi does not
 *     substitute itself.
 *   A git package's mirror is rebuilt when its commit changes, so after an update at the next load, a local folder's
 *   at every load; either while the extension loads, before session_start, so claude-code-hooks.ts runs the
 *   SessionStart hooks of the current mirror.
 * - Plugin hooks and scripts are mirrored as they are. Every mirrored plugin is linked into
 *   ~/.pi/agent/claude-code-plugins, where claude-code-hooks.ts runs its hooks and claude-code-agents.ts finds its
 *   agents; a plugin name two marketplaces share goes to the first. Links into a mirror (a directory with a .source
 *   stamp) are replaced or removed as the mirrors change; other entries there are left alone.
 */

import { DefaultPackageManager, type ExtensionAPI, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";

const ROOT = path.join(getAgentDir(), "claude-code-marketplaces");
/** Where claude-code-hooks.ts and claude-code-agents.ts look for Claude Code plugins. */
const PLUGIN_LINKS = path.join(getAgentDir(), "claude-code-plugins");
/** The stamp in a mirror: the commit it was built from and the generator version. */
const STAMP_NAME = ".source";
const GENERATOR_VERSION = 2;
/** git rev-parse while the extension loads, which holds up Pi's start. */
const REV_PARSE_TIMEOUT_MS = 10_000;
/** Git must never ask: no terminal prompt, SSH in batch mode. */
const GIT_ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
};
/** A Claude Code marketplace installed as a Pi package. */
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

/** The version in an npm package's package.json, or null. */
function packageVersion(m: Marketplace): string | null {
	try {
		const version = JSON.parse(readFileSync(path.join(m.repo, "package.json"), "utf8"))?.version;
		return typeof version === "string" && version ? version : null;
	} catch {
		return null;
	}
}

/** The package's commit, or for an npm package its version; null when neither is known. */
function revisionSync(m: Marketplace): string | null {
	try {
		const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: m.repo,
			timeout: REV_PARSE_TIMEOUT_MS,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, ...GIT_ENV },
		}).trim();
		if (commit) return commit;
	} catch {
		// not a git checkout
	}
	return packageVersion(m);
}

/** The marketplace's name in its manifest, else the directory name. */
function label(m: Marketplace): string {
	try {
		const name = JSON.parse(readFileSync(path.join(m.repo, ".claude-plugin", "marketplace.json"), "utf8"))?.name;
		if (typeof name === "string" && name) return name;
	} catch {
		// no readable manifest
	}
	return m.slug;
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

/**
 * Copies a directory tree file by file. Not fs.cpSync: Node implements it with std::filesystem, and an error there, such
 * as a folder another process removed meanwhile, aborts the whole Pi process instead of throwing.
 */
function copyTree(from: string, to: string): void {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const source = path.join(from, entry.name);
		const target = path.join(to, entry.name);
		if (entry.isDirectory()) copyTree(source, target);
		else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
		else if (entry.isFile()) copyFileSync(source, target);
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Removes the build folders (<mirror>.tmp-<pid>, <mirror>.old-<pid>) of processes that are gone. */
function removeStaleBuilds(m: Marketplace): void {
	const parent = path.dirname(m.out);
	const base = path.basename(m.out);
	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return;
	}
	for (const name of entries) {
		const match = name.startsWith(`${base}.`) ? /^(?:tmp|old)-(\d+)$/.exec(name.slice(base.length + 1)) : null;
		if (!match || alive(Number(match[1]))) continue;
		rmSync(path.join(parent, name), { recursive: true, force: true });
	}
}

/**
 * Builds the Pi mirror of all plugins of a marketplace from its clone and swaps it in. Pi processes that load at the same
 * time (a /reload in every session) each build in a folder of their own; the first to finish swaps its mirror in, and
 * the others drop theirs once they find the mirror current.
 */
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

	removeStaleBuilds(m);
	const tmp = `${m.out}.tmp-${process.pid}`;
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	for (const plugin of plugins) {
		const target = path.join(tmp, plugin.name);
		const finalRoot = path.join(m.out, plugin.name);
		copyTree(plugin.dir, target);

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

	// Another process may have swapped in the same mirror meanwhile.
	if (isCurrent(m, commit)) {
		rmSync(tmp, { recursive: true, force: true });
		return;
	}
	const old = `${m.out}.old-${process.pid}`;
	rmSync(old, { recursive: true, force: true });
	try {
		renameSync(m.out, old);
	} catch {
		// No mirror yet, or another process is swapping its own in.
	}
	try {
		renameSync(tmp, m.out);
	} catch (error) {
		// Another process was quicker: keep its mirror, which is current unless the package moved on meanwhile.
		rmSync(tmp, { recursive: true, force: true });
		if (!isCurrent(m, commit)) throw error;
	}
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

/** What of a marketplace needs a reload when it changes: the plugin list and the plugins. */
function pluginPaths(m: Marketplace): string[] {
	const paths = [".claude-plugin/marketplace.json"];
	try {
		paths.push(...marketplacePlugins(m).map((plugin) => path.relative(m.repo, plugin.dir)));
	} catch {
		// No readable manifest: the manifest path itself covers it.
	}
	return paths;
}

function skillPaths(marketplaces: Marketplace[]): string[] {
	return [...mirroredPlugins(marketplaces).values()]
		.map((dir) => path.join(dir, "skills"))
		.filter((dir) => existsSync(dir));
}

export default function (pi: ExtensionAPI) {
	let packages: ConfiguredPackage[];
	try {
		packages = configuredPackages();
	} catch {
		return; // Pi reports unreadable settings itself.
	}
	const marketplaces = findMarketplaces(packages);
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

	// Before any session_start, at the start and at /reload alike, since claude-code-hooks.ts runs the SessionStart
	// hooks there: mirrors rebuilt where the package changed, then linked. A git or npm package's mirror is rebuilt when
	// its revision changed (after an update by package-update.ts or by hand), a local folder's at every load, as it may have changed
	// without a commit, though not by subagent processes, which use the mirror of the Pi that started them.
	let generated = false;
	for (const m of marketplaces) {
		const current = revisionSync(m);
		const stamp = m.updatable ? current : process.env.PI_SUBAGENT_DEPTH ? null : `${current ?? "local"}+${Date.now().toString(36)}`;
		if (stamp && !isCurrent(m, stamp)) {
			try {
				generate(m, stamp);
				generated = true;
			} catch {
				// Keep the previous mirror; the next load retries.
			}
		}
	}
	if (generated || !process.env.PI_SUBAGENT_DEPTH) {
		try {
			linkPlugins(marketplaces);
		} catch {
			// The next load retries.
		}
	}

	pi.on("resources_discover", async () => ({ skillPaths: skillPaths(marketplaces) }));

	// package-update.ts keeps the marketplace packages current; the mirrors follow at the next load.
	const request = () => ({
		id: "claude-code-plugins",
		packages: marketplaces.map((m) => ({ source: m.source, repo: m.repo, label: label(m), reloadPaths: pluginPaths(m) })),
	});
	pi.events.on("package-update:request", () => pi.events.emit("package-update:packages", request()));
	pi.events.emit("package-update:packages", request());
}
