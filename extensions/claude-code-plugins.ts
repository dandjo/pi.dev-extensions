/**
 * Claude Code plugins for Pi: the skills, hooks, and agents of the plugins of Claude Code marketplaces that are
 * installed as Pi packages. It reads Claude Code's plugin format only and needs no Claude model: the plugins work with
 * any provider.
 *
 * - A marketplace is a package in the user's Pi settings (pi install, not --local) whose folder holds
 *   .claude-plugin/marketplace.json, from git as well as from a local folder. Without one the extension only offers
 *   /plugins, for the plugins Claude Code installed. It clones nothing itself: the files are Pi's package install.
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
 * - Every plugin and every skill of a mirrored plugin is on unless a switch file turns it off: claude-code-plugins.json
 *   in Pi's agent directory for the user, and <project>/.pi/claude-code-plugins.json over it once the project is trusted,
 *   each {"plugins": {"<plugin>": false}, "skills": {"<plugin>:<skill>": false}}; a project's true turns on what the
 *   user's file turns off. Pi loads only the skills that are on, of plugins that are on (Claude Code's name
 *   <plugin>:<skill>, without the prefix of the mirror). claude-code-hooks.ts and claude-code-agents.ts read the
 *   plugin switches themselves, so a plugin that is off runs no hooks and offers no agents, also the copy Claude Code
 *   installed. The links stay as they are: one project may need what another turns off.
 * - /plugins lists the plugins Pi uses with their skills, like /settings: Enter or Space switches one, typing
 *   searches, Tab moves between the user's file and the project's. /plugins list|enable|disable|reset <name>
 *   [--project] does the same in words. Pi reloads afterwards when it is idle, so the change applies at once; other
 *   sessions take it at their next start or reload, their hooks already at their next prompt.
 */

import {
	DefaultPackageManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	getSettingsListTheme,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type SettingItem, SettingsList, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
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
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.join(getAgentDir(), "claude-code-marketplaces");
/** Where claude-code-hooks.ts and claude-code-agents.ts look for Claude Code plugins. */
const PLUGIN_LINKS = path.join(getAgentDir(), "claude-code-plugins");
/** The stamp in a mirror: the commit it was built from and the generator version. */
const STAMP_NAME = ".source";
const GENERATOR_VERSION = 2;
/** The switch file, in Pi's agent directory for the user and in <project>/.pi for a project. */
const SWITCH_FILE = "claude-code-plugins.json";
const COMMAND = "plugins";
const VERBS = ["list", "enable", "disable", "reset"] as const;
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

// --- switches ----------------------------------------------------------------------------------------------------------

type Scope = "user" | "project";

/** The switches of one file: plugin name, or <plugin>:<skill>, -> on or off. */
interface Layer {
	plugins: Record<string, boolean>;
	skills: Record<string, boolean>;
}

/** The switches that apply in a directory: the project's file counts once the project is trusted. */
interface Switches {
	user: Layer;
	project: Layer;
	trusted: boolean;
	/** Switch files that cannot be read, with why. */
	errors: string[];
}

function switchFile(scope: Scope, cwd: string): string {
	return scope === "user" ? path.join(getAgentDir(), SWITCH_FILE) : path.join(cwd, ".pi", SWITCH_FILE);
}

/** A switch file as it is, {} without one; an unreadable or malformed one throws, so it is never overwritten. */
function readSwitchFile(file: string): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`${file}: expected a JSON object`);
	return json as Record<string, unknown>;
}

function switchMap(json: Record<string, unknown>, key: keyof Layer): Record<string, boolean> {
	const map = json[key];
	const out: Record<string, boolean> = {};
	if (map && typeof map === "object" && !Array.isArray(map)) {
		for (const [name, value] of Object.entries(map)) if (typeof value === "boolean") out[name] = value;
	}
	return out;
}

function loadSwitches(cwd: string, trusted: boolean): Switches {
	const errors: string[] = [];
	const layer = (file: string): Layer => {
		try {
			const json = readSwitchFile(file);
			return { plugins: switchMap(json, "plugins"), skills: switchMap(json, "skills") };
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
			return { plugins: {}, skills: {} };
		}
	};
	return { user: layer(switchFile("user", cwd)), project: layer(switchFile("project", cwd)), trusted, errors };
}

/** The switch of a plugin or skill that applies, and where it comes from; undefined: none, so it is on. */
function switchOf(s: Switches, id: string): { on: boolean; scope: Scope } | undefined {
	const key: keyof Layer = id.includes(":") ? "skills" : "plugins";
	const project = s.trusted ? s.project[key][id] : undefined;
	if (project !== undefined) return { on: project, scope: "project" };
	const user = s.user[key][id];
	return user === undefined ? undefined : { on: user, scope: "user" };
}

const isOn = (s: Switches, id: string) => switchOf(s, id)?.on ?? true;

/**
 * Sets a switch in a file, or removes it (value undefined), keeping everything else in the file. A file that cannot be
 * read as JSON is left alone: the call throws. Returns whether the file changed.
 */
function writeSwitch(file: string, id: string, value: boolean | undefined): boolean {
	const json = readSwitchFile(file);
	const key: keyof Layer = id.includes(":") ? "skills" : "plugins";
	const map = json[key] && typeof json[key] === "object" && !Array.isArray(json[key]) ? { ...(json[key] as Record<string, unknown>) } : {};
	if (map[id] === value || (value === undefined && !(id in map))) return false;
	if (value === undefined) delete map[id];
	else map[id] = value;
	const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
	if (Object.keys(sorted).length > 0) json[key] = sorted;
	else delete json[key];
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
	return true;
}

// --- the plugins Pi uses -------------------------------------------------------------------------------------------------

interface SkillInfo {
	/** The skill's own name, as Claude Code's <plugin>:<name> has it. */
	name: string;
	/** Pi's name of it, as /skill:<piName> takes it. */
	piName: string;
	dir: string;
	description: string;
}

interface PluginInfo {
	name: string;
	/** Where Pi has it from: a marketplace's name, "Claude Code", or "linked". */
	origin: string;
	root: string;
	/** Its skills, of a mirrored plugin; Pi loads the skills of no other plugin. */
	skills: SkillInfo[];
	hooks: boolean;
	agents: number;
}

/** A field of a SKILL.md's frontmatter, on one line or folded (| or >) over the lines below it. */
function frontmatterValue(text: string, key: string): string | undefined {
	const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
	if (!block) return undefined;
	const lines = block.split(/\r?\n/);
	const index = lines.findIndex((line) => line.startsWith(`${key}:`));
	if (index < 0) return undefined;
	let value = lines[index].slice(key.length + 1).trim();
	if (/^[|>][-+]?$/.test(value)) {
		const folded: string[] = [];
		for (const line of lines.slice(index + 1)) {
			if (!/^\s/.test(line)) break;
			folded.push(line.trim());
		}
		value = folded.join(" ");
	}
	return value.replace(/^(["'])([\s\S]*)\1$/, "$2").trim() || undefined;
}

/** The skills of a mirrored plugin, by their own name: the mirror's names carry the plugin as prefix. */
function mirrorSkills(plugin: string, pluginDir: string): SkillInfo[] {
	const skills: SkillInfo[] = [];
	for (const dir of skillDirs(pluginDir).sort()) {
		const skillDir = path.join(pluginDir, "skills", dir);
		let text = "";
		try {
			text = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
		} catch {
			continue;
		}
		const piName = frontmatterValue(text, "name") ?? dir;
		const name = piName.startsWith(`${plugin}-`) ? piName.slice(plugin.length + 1) : piName;
		skills.push({ name, piName, dir: skillDir, description: frontmatterValue(text, "description") ?? "" });
	}
	return skills;
}

function agentCount(root: string): number {
	try {
		return readdirSync(path.join(root, "agents")).filter((name) => name.endsWith(".md")).length;
	} catch {
		return 0;
	}
}

/**
 * The plugins Pi uses, the mirrored ones first, then the others claude-code-hooks.ts and claude-code-agents.ts take (see
 * claudePlugins() there): entries of ~/.pi/agent/claude-code-plugins that lead elsewhere, and the plugins Claude Code
 * installed for the user and enabled. Of two of one name, the first wins.
 */
function pluginInfos(marketplaces: Marketplace[]): PluginInfo[] {
	const found = new Map<string, PluginInfo>();
	const add = (name: string, root: string, origin: string, skills: SkillInfo[]) => {
		if (found.has(name)) return;
		found.set(name, { name, root, origin, skills, hooks: existsSync(path.join(root, "hooks", "hooks.json")), agents: agentCount(root) });
	};
	for (const m of marketplaces) {
		if (!existsSync(m.out)) continue;
		const origin = label(m);
		const names = readdirSync(m.out, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		for (const name of names) add(name, path.join(m.out, name), origin, mirrorSkills(name, path.join(m.out, name)));
	}
	try {
		for (const name of readdirSync(PLUGIN_LINKS).sort()) {
			try {
				if (statSync(path.join(PLUGIN_LINKS, name)).isDirectory()) add(name, path.join(PLUGIN_LINKS, name), "linked", []);
			} catch {
				// a broken link
			}
		}
	} catch {
		// no such folder
	}
	const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
	const json = (file: string): any => {
		try {
			return JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return undefined;
		}
	};
	const installed = json(path.join(claudeDir, "plugins", "installed_plugins.json"))?.plugins ?? {};
	const enabled = json(path.join(claudeDir, "settings.json"))?.enabledPlugins ?? {};
	for (const id of Object.keys(installed).sort()) {
		const name = id.split("@")[0];
		if (!name || enabled[id] !== true || !Array.isArray(installed[id])) continue;
		const entry = installed[id].find((e: any) => e?.scope === "user" && typeof e.installPath === "string");
		if (entry && existsSync(entry.installPath)) add(name, entry.installPath, "Claude Code", []);
	}
	return [...found.values()];
}

/** The skill directories Pi loads: those of the mirrored plugins that are on, and of them the skills that are on. */
function skillPaths(marketplaces: Marketplace[], s: Switches): string[] {
	const paths: string[] = [];
	for (const [plugin, dir] of mirroredPlugins(marketplaces)) {
		if (!isOn(s, plugin)) continue;
		for (const skill of mirrorSkills(plugin, dir)) if (isOn(s, `${plugin}:${skill.name}`)) paths.push(skill.dir);
	}
	return paths;
}

// --- /plugins -------------------------------------------------------------------------------------------------------------

function shortPath(file: string): string {
	const home = os.homedir();
	return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

function pluginSummary(plugin: PluginInfo, s: Switches): string {
	const parts = [plugin.origin];
	if (plugin.skills.length > 0) {
		const off = plugin.skills.filter((skill) => !isOn(s, `${plugin.name}:${skill.name}`)).length;
		parts.push(`${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}${off > 0 ? `, ${off} off` : ""}`);
	}
	if (plugin.hooks) parts.push("hooks");
	if (plugin.agents > 0) parts.push(`${plugin.agents} agent${plugin.agents === 1 ? "" : "s"}`);
	return parts.join(" · ");
}

const scopeWords = (scope: Scope) => (scope === "user" ? "for you" : "in this project");

/** The plugins and the skill switches as text, for /plugins list and for /plugins outside the TUI. */
function listText(plugins: PluginInfo[], s: Switches, cwd: string): string {
	const lines = [
		`Claude Code plugins: on unless ${shortPath(switchFile("user", cwd))} or, once the project is trusted, ${shortPath(switchFile("project", cwd))} turns them off.`,
	];
	if (!s.trusted) lines.push("This project is not trusted, so its switch file does not count.");
	for (const error of s.errors) lines.push(`Unreadable, so left out: ${error}`);
	if (plugins.length === 0) lines.push("No plugins.");
	for (const plugin of plugins) {
		const own = switchOf(s, plugin.name);
		lines.push(`${own?.on === false ? "off" : "on "}  ${plugin.name} · ${pluginSummary(plugin, s)}${own ? ` (${own.on ? "on" : "off"} ${scopeWords(own.scope)})` : ""}`);
		for (const skill of plugin.skills) {
			const id = `${plugin.name}:${skill.name}`;
			const set = switchOf(s, id);
			if (set) lines.push(`       ${set.on ? "on " : "off"}  ${id} (${scopeWords(set.scope)})`);
		}
	}
	return lines.join("\n");
}

/** A plugin or skill as the switches name it: <plugin> or <plugin>:<skill>; Pi's skill name and /skill: work too. */
function resolveName(name: string, plugins: PluginInfo[]): string | undefined {
	const wanted = name.replace(/^\/?skill:/, "");
	for (const plugin of plugins) {
		if (plugin.name === wanted) return plugin.name;
		for (const skill of plugin.skills) {
			const id = `${plugin.name}:${skill.name}`;
			if (id === wanted || skill.piName === wanted) return id;
		}
	}
	return undefined;
}

/**
 * The completions of /plugins. Enter takes the first one while the list is open, without sending, so a name typed in
 * full gets none (Enter sends it), skills come only after the plugin's ":", and --project only once a "-" is typed.
 */
function completions(prefix: string, plugins: PluginInfo[], s: Switches): AutocompleteItem[] | null {
	const words = prefix.split(/\s+/);
	if (words.length <= 1) {
		const items = VERBS.filter((verb) => verb.startsWith(words[0] ?? "") && verb !== words[0]).map((verb) => ({
			value: verb === "list" ? verb : `${verb} `,
			label: verb,
		}));
		return items.length > 0 ? items : null;
	}
	const [verb, name = "", ...rest] = words;
	if (verb === "list" || !(VERBS as readonly string[]).includes(verb)) return null;
	if (rest.length > 0) {
		const flag = rest[0];
		return flag && "--project".startsWith(flag) && flag !== "--project" ? [{ value: `${verb} ${name} --project`, label: "--project" }] : null;
	}
	const ids = plugins.flatMap((plugin) => [plugin.name, ...plugin.skills.map((skill) => `${plugin.name}:${skill.name}`)]);
	if (ids.includes(name)) return null;
	const items = ids
		.filter((id) => id.startsWith(name) && (name.includes(":") || !id.includes(":")))
		.map((id) => ({ value: `${verb} ${id}`, label: id, description: isOn(s, id) ? "on" : "off" }));
	return items.length > 0 ? items.slice(0, 50) : null;
}

/** The rows of the list for one file: each plugin, then its skills below it. */
function listItems(plugins: PluginInfo[], s: Switches, scope: Scope): SettingItem[] {
	const items: SettingItem[] = [];
	const row = (id: string, label: string, about: string[]): SettingItem => {
		const key: keyof Layer = id.includes(":") ? "skills" : "plugins";
		if (scope === "user") {
			const project = s.project[key][id];
			if (project !== undefined) about.push(`This project's file turns it ${project ? "on" : "off"}${s.trusted ? "" : " once the project is trusted"}.`);
			return { id, label, description: about.join(" "), currentValue: s.user[key][id] === false ? "off" : "on", values: ["on", "off"] };
		}
		const inherited = `as for you (${s.user[key][id] === false ? "off" : "on"})`;
		const own = s.project[key][id];
		return {
			id,
			label,
			description: about.join(" "),
			currentValue: own === undefined ? inherited : own ? "on" : "off",
			values: [inherited, "on", "off"],
		};
	};
	for (const plugin of plugins) {
		items.push(row(plugin.name, plugin.name, [pluginSummary(plugin, s) + "."]));
		for (const skill of plugin.skills) {
			const about = [`/skill:${skill.piName}.`];
			if (!isOn(s, plugin.name)) about.push(`Off with its plugin.`);
			if (skill.description) about.push(skill.description.length > 300 ? `${skill.description.slice(0, 299)}…` : skill.description);
			items.push(row(`${plugin.name}:${skill.name}`, `  ${plugin.name}:${skill.name}`, about));
		}
	}
	return items;
}

/** The list behind /plugins in the TUI. Every switch is written at once; returns whether any file changed. */
async function openList(command: ExtensionCommandContext, marketplaces: Marketplace[]): Promise<boolean> {
	const plugins = pluginInfos(marketplaces);
	const trusted = command.isProjectTrusted();
	let changed = false;
	let scope: Scope = "user";
	await command.ui.custom<void>((tui, theme, _keybindings, done) => {
		let error: string | undefined;
		let items: SettingItem[] = [];
		let list: SettingsList;
		// Every row as the files say now: the counts and "off with its plugin" follow a switch, and a write that failed
		// shows the old value again. The rows stay the same objects, so a search in progress stays.
		const sync = () => {
			const fresh = new Map(listItems(plugins, loadSwitches(command.cwd, trusted), scope).map((item) => [item.id, item]));
			for (const item of items) {
				const now = fresh.get(item.id);
				if (!now) continue;
				item.description = now.description;
				item.currentValue = now.currentValue;
			}
		};
		const build = () => {
			items = listItems(plugins, loadSwitches(command.cwd, trusted), scope);
			const rows = Math.max(5, Math.min(items.length, tui.terminal.rows - 14));
			list = new SettingsList(
				items,
				rows,
				getSettingsListTheme(),
				(id, value) => {
					const on = value === "on" ? true : value === "off" ? false : undefined;
					// The user's file holds only what is off: on is the default there.
					const stored = scope === "user" && on === true ? undefined : on;
					try {
						if (writeSwitch(switchFile(scope, command.cwd), id, stored)) changed = true;
						error = undefined;
					} catch (e) {
						error = e instanceof Error ? e.message : String(e);
					}
					sync();
					tui.requestRender();
				},
				() => done(),
				{ enableSearch: true },
			);
		};
		build();
		const header = (width: number): string[] => {
			const tab = (name: Scope, text: string) => (scope === name ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text));
			const lines = [
				`${theme.fg("accent", theme.bold("Claude Code plugins"))}   ${tab("user", "For you")}  ${tab("project", "This project")}   ${theme.fg("dim", "Tab switches")}`,
				theme.fg("dim", `${shortPath(switchFile(scope, command.cwd))} · saved at once; Pi reloads when you close the list`),
			];
			if (scope === "project" && !trusted) lines.push(theme.fg("warning", "This project is not trusted: its file applies once it is."));
			if (error) lines.push(theme.fg("error", error));
			lines.push("");
			return lines.map((line) => truncateToWidth(line, width));
		};
		let headerRows = 0;
		return {
			get capturesViewportInput() {
				return list.capturesViewportInput;
			},
			render(width: number) {
				const top = header(width);
				headerRows = top.length;
				return [...top, ...list.render(width)];
			},
			invalidate() {
				list.invalidate();
			},
			handleInput(data: string) {
				if (data === "\t") {
					scope = scope === "user" ? "project" : "user";
					error = undefined;
					build();
				} else list.handleInput(data);
				tui.requestRender();
			},
			handleMouse(event: TuiMouseEvent) {
				if (event.y < headerRows) return undefined;
				const result = list.handleMouse({ ...event, y: event.y - headerRows, height: event.height - headerRows });
				tui.requestRender();
				return result;
			},
		};
	});
	return changed;
}

/** Reloads, so the switches apply, or says that /reload applies them while Pi is busy. */
async function applyNow(command: ExtensionCommandContext, what: string): Promise<void> {
	if (!command.isIdle()) {
		command.ui.notify(`${what} /reload applies it once Pi is idle.`, "info");
		return;
	}
	command.ui.notify(`${what} Reloading.`, "info");
	await command.reload();
}

/** /plugins list|enable|disable|reset <name> [--project]. */
async function switchCommand(command: ExtensionCommandContext, marketplaces: Marketplace[], words: string[]): Promise<void> {
	const project = words.includes("--project");
	const [verb, name, ...extra] = words.filter((word) => word !== "--project");
	const plugins = pluginInfos(marketplaces);
	const usage = `Usage: /${COMMAND} [list | enable <name> | disable <name> | reset <name>] [--project]; <name> is a plugin or <plugin>:<skill>.`;
	if (verb === "list" && !name) {
		command.ui.notify(listText(plugins, loadSwitches(command.cwd, command.isProjectTrusted()), command.cwd), "info");
		return;
	}
	if (!(verb === "enable" || verb === "disable" || verb === "reset") || !name || extra.length > 0) {
		command.ui.notify(usage, "warning");
		return;
	}
	const scope: Scope = project ? "project" : "user";
	const file = switchFile(scope, command.cwd);
	let id = resolveName(name, plugins);
	// A switch of something no longer there can still be reset.
	if (!id && verb === "reset") {
		const s = loadSwitches(command.cwd, true);
		if (name in s[scope].plugins || name in s[scope].skills) id = name;
	}
	if (!id) {
		command.ui.notify(`No plugin or skill ${name}. /${COMMAND} list shows them.`, "warning");
		return;
	}
	const value = verb === "reset" ? undefined : verb === "disable" ? false : scope === "project" ? true : undefined;
	let changed: boolean;
	try {
		changed = writeSwitch(file, id, value);
	} catch (error) {
		command.ui.notify(`Switches unchanged: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const trusted = command.isProjectTrusted();
	const after = loadSwitches(command.cwd, trusted);
	const pluginOn = isOn(after, id.split(":")[0]);
	const where =
		verb === "reset" ? `${id}: no switch ${scopeWords(scope)} now` : `${id} is ${verb === "enable" ? "on" : "off"} ${scopeWords(scope)}`;
	const notes = [`${where} (${shortPath(file)}).`];
	if (scope === "project" && !trusted) notes.push("The project is not trusted, so the file applies once it is.");
	notes.push(`Here it is ${pluginOn && isOn(after, id) ? "on" : "off"}${id.includes(":") && !pluginOn ? " with its plugin" : ""}.`);
	if (!changed) {
		command.ui.notify(`${notes.join(" ")} Nothing changed.`, "info");
		return;
	}
	await applyNow(command, notes.join(" "));
}

function registerPluginsCommand(pi: ExtensionAPI, marketplaces: Marketplace[]): void {
	let cwd = process.cwd();
	let trusted = false;
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		cwd = ctx.cwd;
		trusted = ctx.isProjectTrusted();
	});
	pi.registerCommand(COMMAND, {
		description: "Turn Claude Code plugins and their skills on or off, for you or this project (list, enable, disable, reset)",
		getArgumentCompletions: (prefix) => completions(prefix, pluginInfos(marketplaces), loadSwitches(cwd, trusted)),
		handler: async (args, command) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			if (words.length > 0) return switchCommand(command, marketplaces, words);
			if (command.mode !== "tui") return switchCommand(command, marketplaces, ["list"]);
			if (await openList(command, marketplaces)) await applyNow(command, "Switches saved.");
		},
	});
}

export default function (pi: ExtensionAPI) {
	let packages: ConfiguredPackage[];
	try {
		packages = configuredPackages();
	} catch {
		return; // Pi reports unreadable settings itself.
	}
	const marketplaces = findMarketplaces(packages);
	registerPluginsCommand(pi, marketplaces);
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

	pi.on("resources_discover", async (event, ctx) => {
		const switches = loadSwitches(event.cwd, ctx.isProjectTrusted());
		if (switches.errors.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Claude Code plugin switches left out: ${switches.errors.join("; ")}`, "warning");
		}
		return { skillPaths: skillPaths(marketplaces, switches) };
	});

	// package-update.ts keeps the marketplace packages current; the mirrors follow at the next load.
	const request = () => ({
		id: "claude-code-plugins",
		packages: marketplaces.map((m) => ({ source: m.source, repo: m.repo, label: label(m), reloadPaths: pluginPaths(m) })),
	});
	pi.events.on("package-update:request", () => pi.events.emit("package-update:packages", request()));
	pi.events.emit("package-update:packages", request());
}
