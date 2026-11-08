/**
 * Claude Code marketplaces for Pi: the skills, hooks, and agents of the plugins of Claude Code marketplaces in git.
 *
 * - The marketplaces come from ~/.pi/agent/claude-marketplaces.json, a map from each marketplace's git URL to its
 *   settings, like mcpServers in Pi's mcp.json: {"marketplaces": {"git@example.com:team/marketplace.git": {}}}.
 *   Without that file the extension does nothing.
 * - Each marketplace is cloned into ~/.pi/agent/claude-marketplaces/<name>/repo (<name> from the URL) and pulled in
 *   the background on every Pi start. From the clone, a mirror of every plugin listed in
 *   .claude-plugin/marketplace.json is built in ~/.pi/agent/claude-marketplaces/<name>/plugins, adapted to Pi:
 *   - skill names get the plugin as prefix (my-plugin:guidelines -> my-plugin-guidelines), since Pi has no plugin
 *     namespaces and plain names collide between plugins;
 *   - references to the skills of the marketplace are rewritten the same way (/my-plugin:review ->
 *     /skill:my-plugin-review);
 *   - ${CLAUDE_SKILL_DIR} and ${CLAUDE_PLUGIN_ROOT} are replaced with the absolute mirror paths, which Pi does not
 *     substitute itself.
 * - Plugin hooks and scripts are mirrored as they are. Every mirrored plugin is linked into ~/.pi/agent/claude-plugins,
 *   where claude-hooks.ts runs its hooks and claude-agents.ts finds its agents; a plugin name two marketplaces share
 *   goes to the first. Links into a mirror (a directory with a .source stamp, this one's or an earlier one's) are
 *   replaced or removed as the mirrors change; other entries there are left alone.
 * - When an update changed a plugin, Pi reloads by itself as soon as it is at rest in the terminal: no run or
 *   compaction, nothing queued, no prompt just submitted, and the empty prompt editor in focus, so no selector or
 *   dialog is open and no typing is lost. Until then the plugins loaded before stay active. /marketplace-update pulls
 *   and reloads right away. Subagent processes do not pull, and neither does Pi with PI_OFFLINE set.
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
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
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const CONFIG_FILE = path.join(getAgentDir(), "claude-marketplaces.json");
const ROOT = path.join(getAgentDir(), "claude-marketplaces");
/** Where claude-hooks.ts and claude-agents.ts look for Claude Code plugins. */
const PLUGIN_LINKS = path.join(getAgentDir(), "claude-plugins");
/** The stamp in a mirror: the commit it was built from and the generator version. */
const STAMP_NAME = ".source";
const GENERATOR_VERSION = 2;
const GIT_TIMEOUT_MS = 60_000;
const COMMAND = "marketplace-update";
/** Marks the internal /marketplace-update call that lends the automatic reload a command context. */
const RELOAD_MARK = "\u0000reload";
/** An empty widget, only there to reach the TUI for the focus check. */
const WIDGET_KEY = "claude-marketplaces";
const REST_POLL_MS = 1_000;
/** A prompt submitted this recently may still be on its way to the model, before its run starts. */
const INPUT_GRACE_MS = 5_000;

const run = promisify(execFile);

interface Marketplace {
	url: string;
	/** The directory name below ROOT, from the URL. */
	slug: string;
	repo: string;
	out: string;
	stamp: string;
}

interface Plugin {
	name: string;
	dir: string;
}

/** The configured marketplaces in the order of the file; undefined without it. */
function loadMarketplaces(): Marketplace[] | Error | undefined {
	let text: string;
	try {
		text = readFileSync(CONFIG_FILE, "utf8");
	} catch {
		return undefined;
	}
	try {
		const config = JSON.parse(text) as { marketplaces?: unknown };
		const map = config?.marketplaces;
		if (typeof map !== "object" || map === null || Array.isArray(map)) {
			throw new Error('expected {"marketplaces": {"<git url>": {}, …}}');
		}
		const urls = Object.keys(map).filter((url) => url.trim());
		const base = (url: string) =>
			url
				.trim()
				.replace(/[/\\]+$/, "")
				.replace(/\.git$/, "")
				.replace(/[/\\]+$/, "")
				.split(/[/:\\]/)
				.pop()
				?.replace(/[^A-Za-z0-9._-]+/g, "-") || "marketplace";
		const counts = new Map<string, number>();
		for (const url of urls) counts.set(base(url), (counts.get(base(url)) ?? 0) + 1);
		return urls.map((url) => {
			const name = base(url);
			const slug = (counts.get(name) ?? 0) > 1 ? `${name}-${createHash("sha256").update(url).digest("hex").slice(0, 6)}` : name;
			const out = path.join(ROOT, slug, "plugins");
			return { url: url.trim(), slug, repo: path.join(ROOT, slug, "repo"), out, stamp: path.join(out, STAMP_NAME) };
		});
	} catch (error) {
		return new Error(`${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function git(args: string[], cwd?: string): Promise<string> {
	const { stdout } = await run("git", args, {
		cwd,
		timeout: GIT_TIMEOUT_MS,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
		},
	});
	return stdout.trim();
}

async function headCommit(m: Marketplace): Promise<string | null> {
	if (!existsSync(path.join(m.repo, ".git"))) return null;
	return git(["rev-parse", "--short", "HEAD"], m.repo).catch(() => null);
}

/** Clones or resets the clone to the remote default branch; returns the commits before and after. */
async function pull(m: Marketplace): Promise<{ from: string | null; to: string }> {
	const from = await headCommit(m);
	if (from === null) {
		rmSync(m.repo, { recursive: true, force: true });
		mkdirSync(path.dirname(m.repo), { recursive: true });
		await git(["clone", "--quiet", m.url, m.repo]);
	} else {
		await git(["fetch", "--quiet", "--prune", "origin"], m.repo);
		await git(["reset", "--quiet", "--hard", "origin/HEAD"], m.repo);
		await git(["clean", "--quiet", "-fdx"], m.repo);
	}
	return { from, to: (await headCommit(m)) ?? "unknown" };
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
 * that no longer names the mirrored plugin is replaced or removed, and so is a broken link into Pi's agent directory;
 * every other entry belongs to someone else and stays as it is.
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
		const broken = !existsSync(target) && target.startsWith(getAgentDir() + path.sep);
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

/** The commit a mirror was built from, or null without a mirror. */
function mirrorCommit(m: Marketplace): string | null {
	if (!existsSync(m.stamp)) return null;
	return readFileSync(m.stamp, "utf8").trim().split(" ")[0] || null;
}

/** Whether a plugin or the plugin list differs between two commits; when in doubt, yes. */
async function pluginsChanged(m: Marketplace, from: string | null, to: string | null): Promise<boolean> {
	if (from === to) return false;
	if (!from || !to) return true;
	try {
		const sources = marketplacePlugins(m).map((plugin) => path.relative(m.repo, plugin.dir));
		await git(["diff", "--quiet", from, to, "--", ".claude-plugin/marketplace.json", ...sources], m.repo);
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

type UpdateResult = { m: Marketplace; from: string | null; to: string } | { m: Marketplace; error: string };

/**
 * The update in flight, shared by the session runtimes of this process: /reload loads this file afresh, and a session
 * started with /new or /resume while the startup pull still runs must see it too.
 */
const shared = globalThis as typeof globalThis & Record<symbol, Promise<UpdateResult[]> | undefined>;
const UPDATE = Symbol.for("pi.claude-marketplaces.update");

/** Pulls and regenerates every marketplace, one failing not holding up the others; concurrent callers share a run. */
function update(marketplaces: Marketplace[]): Promise<UpdateResult[]> {
	shared[UPDATE] ??= (async () => {
		const results: UpdateResult[] = [];
		for (const m of marketplaces) {
			try {
				const result = await pull(m);
				if (!isCurrent(m, result.to)) generate(m, result.to);
				results.push({ m, ...result });
			} catch (error) {
				results.push({ m, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
			}
		}
		linkPlugins(marketplaces);
		return results;
	})().finally(() => {
		shared[UPDATE] = undefined;
	});
	return shared[UPDATE];
}

export default function (pi: ExtensionAPI) {
	const loadedConfig = loadMarketplaces();
	if (loadedConfig instanceof Error) {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(`claude-marketplaces: ${loadedConfig.message}`, "error");
		});
		return;
	}
	if (!loadedConfig || loadedConfig.length === 0) return;
	const marketplaces = loadedConfig;

	// Before any session_start, when claude-hooks.ts reads the plugins: the links of the mirrors as they are.
	if (!process.env.PI_SUBAGENT_DEPTH) {
		try {
			linkPlugins(marketplaces);
		} catch {
			// The next start or update retries.
		}
	}

	// State of this session runtime; Pi may reuse the loaded module for the next one.
	let ctx: ExtensionContext | null = null;
	let tui: TUI | null = null;
	/** The mirror commit per marketplace whose plugins this runtime loaded. */
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
			tui.getFocusedComponent() instanceof CustomEditor
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

	/** Schedules a reload when a mirror holds plugins that differ from those this runtime loaded. */
	async function checkMirrors(): Promise<void> {
		const changes: string[] = [];
		for (const m of marketplaces) {
			const before = loaded.get(m.slug) ?? null;
			const current = mirrorCommit(m);
			if (!(await pluginsChanged(m, before, current))) continue;
			changes.push(before ? `${label(m)} plugins updated ${before} -> ${current}` : `${label(m)} plugins installed (${current})`);
		}
		if (changes.length === 0 || !ctx || due !== null) return;
		const what = changes.join("; ");
		if (ctx.mode === "tui") scheduleReload(what);
		else if (ctx.hasUI) ctx.ui.notify(`${what}; /reload loads them.`, "info");
	}

	pi.on("resources_discover", async () => {
		let generated = false;
		for (const m of marketplaces) {
			const commit = await headCommit(m);
			if (commit && !isCurrent(m, commit)) {
				try {
					generate(m, commit);
					generated = true;
				} catch {
					// Keep the previous mirror; the next update retries.
				}
			}
			loaded.set(m.slug, mirrorCommit(m));
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
		// Only the start pulls; a later session waits for a pull still running, or finds one finished since its
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
			.then(checkMirrors)
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
		description: "Pull the Claude Code marketplaces of claude-marketplaces.json and reload their plugins",
		handler: async (args, command) => {
			if (args === RELOAD_MARK) {
				await command.reload();
				return;
			}
			const results = await update(marketplaces);
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
