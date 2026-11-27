/**
 * 1Password: tools that read and write 1Password items and run commands with secrets, through the 1Password CLI (op)
 * and its desktop app integration, so that the user approves Pi once per session instead of once per command, and no
 * secret value reaches the model.
 *
 * - Once per session: the desktop app ties an approval to a terminal session — on Linux to the terminal (tty) and a
 *   start time — for 10 minutes of inactivity, which every use renews, and at most 12 hours. Pi's bash tool starts each
 *   command in a session of its own without a terminal, so op there asks every time. These tools start op from Pi's
 *   own process, in Pi's terminal: the first call asks, the next ones go through. On macOS, op 2.40 and later shares
 *   one approval among a program's calls anyway.
 * - onepassword_items lists items (id, title, category, vault), by vault, category, tag, or part of the title.
 *   onepassword_item shows an item's fields by label, type, and section, whether each is set, and its op:// reference;
 *   never a value, of the websites only the host, and nothing of the notes but whether there are any: a URL or a note
 *   can hold a password.
 * - onepassword_run runs a shell command with secrets in environment variables given as op:// references (op run): op
 *   resolves them for the command alone and masks their values in the output. The command runs in a session of its
 *   own without a terminal, as the bash tool's do, so a program that asks on the terminal fails instead of drawing
 *   into Pi.
 * - onepassword_write creates an item or changes one: text fields from values in the call, secret fields (concealed,
 *   one-time password) only from a generated password, a command's output, or a file. The item goes to op as JSON in a
 *   private temporary file, removed at once, never as command arguments, which other processes can read. 1Password
 *   keeps earlier values in the item's history.
 * - Without op on the PATH the extension adds no tools.
 */

import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** How long an op call may take: the first one waits for the user's approval in the app. */
const OP_TIMEOUT_MS = 120_000;
/** How long a command that gives a secret field its value may take. */
const COMMAND_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_DEFAULT_S = 300;
const RUN_TIMEOUT_MAX_S = 3600;
/** The output onepassword_run returns: its end, at most this many lines and bytes, as the bash tool does. */
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const LIST_LIMIT_DEFAULT = 100;
const AUTH_HINT =
	" (1Password asks to approve Pi's access once per session in its app: the user has to approve it there, with " +
	"Settings → Developer → Integrate with 1Password CLI turned on.)";

type Run = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

type Section = { id: string; label?: string };
type Field = {
	id: string;
	type?: string;
	purpose?: string;
	label?: string;
	value?: unknown;
	reference?: string;
	section?: Section;
	[key: string]: unknown;
};
type Item = {
	id: string;
	title?: string;
	category?: string;
	vault?: { id?: string; name?: string };
	tags?: string[];
	updated_at?: string;
	urls?: { href?: string; primary?: boolean; label?: string }[];
	sections?: Section[];
	fields?: Field[];
	files?: unknown[];
	[key: string]: unknown;
};

/** Field types for onepassword_write, by the names op's JSON uses. */
const FIELD_TYPES = {
	text: "STRING",
	concealed: "CONCEALED",
	email: "EMAIL",
	url: "URL",
	phone: "PHONE",
	date: "DATE",
	otp: "OTP",
} as const;
const SECRET_TYPES = new Set(["CONCEALED", "OTP"]);
/** The symbols of a generated password: those op's own generator uses. */
const SYMBOLS = "!@.-_*";
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";

function onPath(program: string): boolean {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		try {
			accessSync(path.join(dir, program), constants.X_OK);
			return true;
		} catch {
			// Not in this directory.
		}
	}
	return false;
}

/** The processes op started: the children of each of its threads. */
function childrenOf(pid: number): number[] {
	const pids: number[] = [];
	try {
		for (const task of readdirSync(`/proc/${pid}/task`)) {
			const list = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim();
			if (list) pids.push(...list.split(/\s+/).map(Number));
		}
	} catch {
		// Not Linux, or op is gone.
	}
	return pids;
}

/**
 * Runs op from Pi's process, not detached: op then runs in Pi's terminal session, for which the desktop app's approval
 * holds from one call to the next. Not killed as a process group, which would be Pi's.
 */
function runOp(
	args: string[],
	options: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number; onKill?: (pid: number) => void } = {},
): Promise<Run> {
	return new Promise((resolve, reject) => {
		const child = spawn("op", args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (stderr.length > MAX_BYTES) stderr = stderr.slice(-MAX_BYTES);
		});
		const kill = () => {
			if (child.pid) options.onKill?.(child.pid);
			child.kill("SIGTERM");
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs ?? OP_TIMEOUT_MS);
		options.signal?.addEventListener("abort", kill, { once: true });
		const done = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", kill);
		};
		child.on("error", (error: NodeJS.ErrnoException) => {
			done();
			reject(error.code === "ENOENT" ? new Error("The 1Password CLI (op) is not installed or not on the PATH.") : error);
		});
		child.on("close", (code) => {
			done();
			resolve({ code, stdout, stderr, timedOut });
		});
		if (options.input !== undefined) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.input);
		}
	});
}

/** op's error message, without its "[ERROR] date time" prefix, with a hint where the approval is missing. */
function opError(run: Run, signal?: AbortSignal): Error {
	if (signal?.aborted) return new Error("Cancelled.");
	if (run.timedOut) return new Error(`op did not answer within ${OP_TIMEOUT_MS / 1000} s.${AUTH_HINT}`);
	const lines = run.stderr
		.split("\n")
		.map((line) => line.replace(/^\[ERROR\]\s+\S+\s+\S+\s+/, "").trim())
		.filter(Boolean);
	const message = lines.at(-1) ?? `op exited with code ${run.code}`;
	return new Error(/not signed in|authori[sz]|dismiss|denied|unlock|connect.*app|app.*connect/i.test(message) ? message + AUTH_HINT : message);
}

async function opJson<T>(args: string[], signal?: AbortSignal, input?: string): Promise<T> {
	const run = await runOp([...args, "--format", "json"], { signal, input });
	if (run.code !== 0) throw opError(run, signal);
	try {
		return JSON.parse(run.stdout) as T;
	} catch {
		throw new Error("op returned no JSON.");
	}
}

const vaultArgs = (vault: string | undefined) => (vault?.trim() ? ["--vault", vault.trim()] : []);
const lower = (text: string | undefined) => (text ?? "").toLowerCase().replace(/_/g, " ");
const same = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();
const isSet = (value: unknown) => (typeof value === "string" ? value.length > 0 : value !== undefined && value !== null);

/** A field's label as the user sees it: op calls the notes field notesPlain. */
function fieldLabel(field: Field): string {
	if (field.purpose === "NOTES") return "notes";
	return field.label || field.id;
}

function fieldKind(field: Field): string {
	const type = lower(field.type) || "text";
	const purpose = field.purpose && field.purpose !== "NOTES" ? `, ${lower(field.purpose)}` : "";
	return (type === "string" ? "text" : type) + purpose;
}

/** Of a website only its host: a URL can carry a user and password, its path and query a token. */
function host(href: string | undefined): string {
	try {
		return new URL(href ?? "").host || "(no host)";
	} catch {
		return "(not a URL)";
	}
}

/** An item's fields by label, type, section, set or empty, and reference; never a value. */
function describeFields(item: Item, only?: Set<string>): string[] {
	return (item.fields ?? [])
		.filter((field) => !only || only.has(field.id))
		.map((field) => {
			const section = field.section?.label ? `${field.section.label} › ` : "";
			const state = isSet(field.value) ? "set" : "empty";
			const reference = field.reference ? ` → ${field.reference}` : "";
			return `- ${section}${fieldLabel(field)} (${fieldKind(field)}): ${state}${reference}`;
		});
}

function describeItem(item: Item): string {
	const lines = [`${item.title ?? "(untitled)"} (id ${item.id})`];
	const facts = [`Category: ${lower(item.category)}`, `Vault: ${item.vault?.name ?? item.vault?.id ?? "?"}`];
	if (item.tags?.length) facts.push(`Tags: ${item.tags.join(", ")}`);
	if (item.updated_at) facts.push(`Updated: ${item.updated_at}`);
	lines.push(facts.join(" · "));
	if (item.urls?.length) lines.push(`Websites: ${item.urls.map((url) => host(url.href)).join(", ")}`);
	if (item.files?.length) lines.push(`Files: ${item.files.length}`);
	const fields = describeFields(item);
	lines.push(fields.length ? "Fields:" : "Fields: none", ...fields);
	return lines.join("\n");
}

function generatePassword(spec: { length?: number; digits?: boolean; symbols?: boolean }): string {
	const length = Math.round(spec.length ?? 32);
	if (!(length >= 8 && length <= 128)) throw new Error("generate.length must be between 8 and 128");
	const sets = [LETTERS, ...(spec.digits === false ? [] : [DIGITS]), ...(spec.symbols === false ? [] : [SYMBOLS])];
	const all = sets.join("");
	for (;;) {
		let password = "";
		for (let i = 0; i < length; i++) password += all[randomInt(all.length)];
		// Each chosen kind of character at least once, as op's generator does.
		if (sets.every((set) => [...password].some((char) => set.includes(char)))) return password;
	}
}

/** A command's standard output, for a secret field: the command runs without a terminal and nothing of it comes back. */
function commandOutput(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-2000);
		});
		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		};
		const timer = setTimeout(kill, COMMAND_TIMEOUT_MS);
		signal?.addEventListener("abort", kill, { once: true });
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			if (code !== 0) {
				const tail = stderr.trim().split("\n").slice(-5).join("\n");
				reject(new Error(`the command failed (exit ${code ?? "killed"})${tail ? `: ${tail}` : ""}`));
			} else resolve(stdout.replace(/\r?\n$/, ""));
		});
	});
}

/** The end of a command's output, at most MAX_LINES lines and MAX_BYTES bytes. */
function tail(output: string): string {
	let text = output;
	let cut = false;
	if (Buffer.byteLength(text) > MAX_BYTES) {
		text = Buffer.from(text).subarray(-MAX_BYTES).toString("utf8");
		cut = true;
	}
	const lines = text.split("\n");
	if (lines.length > MAX_LINES) {
		text = lines.slice(-MAX_LINES).join("\n");
		cut = true;
	}
	return cut ? `[output cut to its last ${MAX_LINES} lines or ${MAX_BYTES / 1024} KB]\n${text}` : text;
}

type FieldSpec = {
	label: string;
	section?: string;
	type?: keyof typeof FIELD_TYPES;
	value?: string;
	generate?: boolean | { length?: number; digits?: boolean; symbols?: boolean };
	command?: string;
	file?: string;
	delete?: boolean;
};

/** Applies the field changes to an item's JSON, in place; returns what each did, without a value. */
async function applyFields(item: Item, specs: FieldSpec[], cwd: string, signal?: AbortSignal): Promise<{ changed: Set<string>; notes: string[] }> {
	item.fields ??= [];
	const changed = new Set<string>();
	const notes: string[] = [];
	for (const spec of specs) {
		const label = spec.label?.trim();
		if (!label) throw new Error("every field needs a label");
		const fields: Field[] = item.fields;
		const matches: Field[] = fields.filter(
			(field) =>
				(same(field.label, label) || same(field.id, label) || (same(label, "notes") && field.purpose === "NOTES")) &&
				(spec.section === undefined || same(field.section?.label, spec.section)),
		);
		if (matches.length > 1) throw new Error(`"${label}" matches ${matches.length} fields; name its section`);
		let field: Field | undefined = matches[0];
		const name = `${spec.section ? `${spec.section} › ` : ""}${label}`;
		if (spec.delete) {
			if (!field) throw new Error(`there is no field "${name}" to remove`);
			const gone: Field = field;
			item.fields = fields.filter((candidate) => candidate !== gone);
			notes.push(`- ${name}: removed`);
			continue;
		}
		const generate = spec.generate === true ? {} : spec.generate === false ? undefined : spec.generate;
		const sources = [spec.value !== undefined, generate !== undefined, spec.command !== undefined, spec.file !== undefined].filter(Boolean).length;
		if (sources !== 1) throw new Error(`field "${name}": give exactly one of value, generate, command, file, or delete`);
		if (!field) {
			let section: Section | undefined;
			if (spec.section) {
				item.sections ??= [];
				section = item.sections.find((candidate) => same(candidate.label, spec.section));
				if (!section) {
					section = { id: randomBytes(13).toString("hex"), label: spec.section };
					item.sections.push(section);
				}
			}
			const type = FIELD_TYPES[spec.type ?? (spec.value !== undefined ? "text" : "concealed")];
			field = { id: randomBytes(13).toString("hex"), type, label, ...(section && { section: { id: section.id, label: section.label } }) };
			fields.push(field);
		} else if (spec.type) field.type = FIELD_TYPES[spec.type];
		if (!field.type) throw new Error(`unknown field type "${spec.type}"`);
		let how: string;
		if (spec.value !== undefined) {
			if (SECRET_TYPES.has(field.type ?? "")) {
				throw new Error(`field "${name}" is secret (${lower(field.type)}): set it with generate, command, or file, not with value`);
			}
			field.value = spec.value;
			how = "set to the given text";
		} else if (generate) {
			field.value = generatePassword(generate);
			how = `generated, ${(field.value as string).length} characters`;
		} else if (spec.command !== undefined) {
			field.value = await commandOutput(spec.command, cwd, signal);
			how = "set from the command's output";
		} else {
			field.value = readFileSync(path.resolve(cwd, spec.file as string), "utf8").replace(/\r?\n$/, "");
			how = "set from the file";
		}
		if (!isSet(field.value)) throw new Error(`field "${name}" would be empty`);
		changed.add(field.id);
		notes.push(`- ${name} (${fieldKind(field)}): ${how}`);
	}
	return { changed, notes };
}

/**
 * Shows onepassword_run in file-preview.ts's panel like bash: its command and its output, which op masks before it is
 * returned and is never sent as an update while the command runs, so the panel shows only what the model gets. The
 * registry is a plain Map on globalThis that only file-preview.ts reads; without it the entry goes unused, and nothing
 * here may fail the extension. vault.ts carries a copy of this function: change them alike.
 */
function registerPreview(tool: string): void {
	try {
		const key = Symbol.for("pi.file-preview.tools");
		const tools = ((globalThis as Record<symbol, unknown>)[key] ??= new Map()) as Map<string, unknown>;
		tools.set(tool, {
			code: "command",
			language: "bash",
			output: true,
			// The result ends with a note of its own: [exit code N], [stopped after N s], or [cancelled].
			outcome: (text: string, isError: boolean) => {
				const note = text.match(/\n?\[(exit code (\d+)|stopped after [^\]\n]*|cancelled)\]$/);
				if (!note) return { status: isError ? "failed" : "exit 0", text };
				const status = note[2] ? `exit ${note[2]}` : note[1] === "cancelled" ? "aborted" : "timed out";
				return { status, text: text.slice(0, note.index) };
			},
		});
	} catch {
		// No preview then.
	}
}

export default function (pi: ExtensionAPI) {
	if (!onPath("op")) return;
	registerPreview("onepassword_run");

	pi.registerTool({
		name: "onepassword_items",
		label: "1Password items",
		description:
			"List 1Password items: id, title, category, and vault, sorted by title, optionally only of one vault, category " +
			"(e.g. Login, Password, API Credential, Secure Note, Database, Server), or tag, or whose title contains query. " +
			"Shows no field values, websites, or notes. The user approves Pi's 1Password access once per session in the 1Password app.",
		promptSnippet: "List 1Password items by title, without secrets",
		promptGuidelines: [
			"onepassword_*: for 1Password use these tools instead of op in bash: op in bash makes the user approve every single command in the 1Password app, these tools share one approval per session.",
			"onepassword_*: never print a secret: pass it to a command as an op:// reference in onepassword_run's env (e.g. printenv DB_PASSWORD | docker login --password-stdin), and set secret fields with onepassword_write's generate, command, or file.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Part of the title, case-insensitive" })),
			vault: Type.Optional(Type.String({ description: "Vault name or id" })),
			category: Type.Optional(Type.String({ description: "Item category, e.g. Login, Password, API Credential" })),
			tag: Type.Optional(Type.String({ description: "Only items with this tag" })),
			limit: Type.Optional(Type.Number({ description: `At most this many items (default ${LIST_LIMIT_DEFAULT})` })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async execute(_id, params, signal) {
			const args = ["item", "list", ...vaultArgs(params.vault)];
			if (params.category?.trim()) args.push("--categories", params.category.trim());
			if (params.tag?.trim()) args.push("--tags", params.tag.trim());
			const items = await opJson<Item[]>(args, signal);
			const query = params.query?.trim().toLowerCase();
			const hits = items
				.filter((item) => !query || (item.title ?? "").toLowerCase().includes(query))
				.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
			const limit = Math.max(1, Math.round(params.limit ?? LIST_LIMIT_DEFAULT));
			const lines = hits.slice(0, limit).map((item) => `${item.id}  ${item.title ?? "(untitled)"}  (${lower(item.category)}, ${item.vault?.name ?? "?"})`);
			const head = hits.length === 0 ? "No items." : `${hits.length} item${hits.length === 1 ? "" : "s"}${hits.length > limit ? `, the first ${limit}` : ""}:`;
			return { content: [{ type: "text", text: [head, ...lines].join("\n") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "onepassword_item",
		label: "1Password item",
		description:
			"Show a 1Password item: category, vault, tags, the hosts of its websites, and its fields by section, label, and type, " +
			"whether each is set, and its op:// reference for onepassword_run. Never shows a field's value, a full URL, or the notes.",
		promptSnippet: "Show a 1Password item's fields and op:// references, without values",
		parameters: Type.Object({
			item: Type.String({ description: "Item id or title" }),
			vault: Type.Optional(Type.String({ description: "Vault name or id, where the title is not unique" })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async execute(_id, params, signal) {
			const item = await opJson<Item>(["item", "get", params.item, ...vaultArgs(params.vault)], signal);
			return { content: [{ type: "text", text: describeItem(item) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "onepassword_run",
		label: "1Password run",
		description:
			"Run a shell command (bash) with secrets from 1Password in environment variables: env maps each variable to an op:// " +
			'reference (from onepassword_item), e.g. {command: "printenv REGISTRY_TOKEN | docker login -u ci --password-stdin registry.example.com", ' +
			'env: {REGISTRY_TOKEN: "op://Shared/Registry/token"}}. op resolves them for this command only and masks their values in the ' +
			"output (a safety net: never print them). The command runs without a terminal; returns its output (the last 2000 lines or 50 KB) and exit code.",
		promptSnippet: "Run a command with 1Password secrets as environment variables (op run), output masked",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command, run by bash" }),
			env: Type.Record(Type.String(), Type.String(), { description: "Environment variable name → op:// reference" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: the session's)" })),
			timeout: Type.Optional(Type.Number({ description: `Seconds before the command is stopped (default ${RUN_TIMEOUT_DEFAULT_S}, at most ${RUN_TIMEOUT_MAX_S})` })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(_id, params, signal, _onUpdate, ctx) {
			const names = Object.keys(params.env ?? {});
			if (names.length === 0) throw new Error("env needs at least one variable with an op:// reference; without secrets use bash");
			for (const name of names) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a valid variable name`);
				const reference: unknown = params.env[name];
				if (typeof reference !== "string" || !reference.startsWith("op://")) throw new Error(`${name}: the value must be an op:// reference`);
			}
			const cwd = path.resolve(ctx.cwd, params.cwd ?? ".");
			const timeoutS = Math.min(Math.max(1, params.timeout ?? RUN_TIMEOUT_DEFAULT_S), RUN_TIMEOUT_MAX_S);
			// The command in a session of its own, without Pi's terminal; on macOS, which has no setsid, it keeps it.
			const inner = process.platform === "linux" && onPath("setsid") ? ["setsid", "bash", "-c", params.command] : ["bash", "-c", params.command];
			let output = "";
			const run = await runOp(["run", "--", ...inner], {
				cwd,
				env: { ...process.env, ...params.env },
				signal,
				timeoutMs: timeoutS * 1000,
				// The command's session goes with it; op itself is killed alone, as it shares Pi's process group.
				onKill: (pid) => {
					for (const child of childrenOf(pid)) {
						try {
							process.kill(-child, "SIGKILL");
						} catch {
							// Gone, or not a session of its own.
						}
					}
				},
			});
			output = run.stdout + (run.stderr ? (run.stdout && !run.stdout.endsWith("\n") ? "\n" : "") + run.stderr : "");
			const notes: string[] = [];
			if (signal?.aborted) notes.push("[cancelled]");
			else if (run.timedOut) notes.push(`[stopped after ${timeoutS} s]`);
			else if (run.code !== 0) notes.push(`[exit code ${run.code}]`);
			const text = [tail(output.trimEnd()) || "(no output)", ...notes].join("\n");
			if (run.code !== 0 && !output.trim() && !signal?.aborted && !run.timedOut) throw opError(run, signal);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "onepassword_write",
		label: "1Password write",
		description:
			'Create a 1Password item (action "create": title, vault, category, default Login) or change one (action "edit": item, ' +
			"and title to rename it). fields sets, adds, or removes fields by label (notes is the notes field; section picks or creates a " +
			"section): value for text, email, url, and the like; secret fields (concealed, otp) only with generate (a random password: " +
			"{length, digits, symbols}, default 32 characters with digits and symbols), command (its standard output), or file (its content), " +
			"never with value. A new field is concealed unless it has a value or a type. urls and tags replace the item's. Returns the fields " +
			"changed with their op:// references, never a value; 1Password keeps earlier values in the item's history.",
		promptSnippet: "Create or change a 1Password item; secret fields only generated or from a command or file",
		parameters: Type.Object({
			action: StringEnum(["create", "edit"] as const, { description: "create a new item or edit an existing one" }),
			item: Type.Optional(Type.String({ description: "edit: the item's id or title" })),
			vault: Type.Optional(Type.String({ description: "create: the vault (default: op's default vault); edit: where the title is not unique" })),
			title: Type.Optional(Type.String({ description: "create: the title (required); edit: a new title" })),
			category: Type.Optional(Type.String({ description: "create: the category, e.g. Login, Password, API Credential, Secure Note, Database, Server (default Login)" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Websites, replacing the item's; the first is the primary one" })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Tags, replacing the item's" })),
			fields: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ description: "Field label, e.g. username, password, notes, or a label of your own" }),
						section: Type.Optional(Type.String({ description: "Section label: picks the field among sections, or the section for a new field" })),
						type: Type.Optional(StringEnum(Object.keys(FIELD_TYPES) as (keyof typeof FIELD_TYPES)[], { description: "Field type (a new field: text with a value, else concealed)" })),
						value: Type.Optional(Type.String({ description: "The value of a field that is not secret" })),
						generate: Type.Optional(
							Type.Union([
								Type.Boolean(),
								Type.Object({
									length: Type.Optional(Type.Number({ description: "8 to 128, default 32" })),
									digits: Type.Optional(Type.Boolean({ description: "default true" })),
									symbols: Type.Optional(Type.Boolean({ description: "default true" })),
								}),
							], { description: "A random password as the value" }),
						),
						command: Type.Optional(Type.String({ description: "Shell command whose standard output becomes the value (without its last newline)" })),
						file: Type.Optional(Type.String({ description: "File whose content becomes the value (without its last newline)" })),
						delete: Type.Optional(Type.Boolean({ description: "Remove the field" })),
					}),
				),
			),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(_id, params, signal, _onUpdate, ctx) {
			const specs = (params.fields ?? []) as FieldSpec[];
			let item: Item;
			if (params.action === "create") {
				if (!params.title?.trim()) throw new Error("create needs a title");
				if (params.item) throw new Error("create takes no item; to change one use action edit");
				const category = params.category?.trim() || "Login";
				const template = await runOp(["item", "template", "get", category], { signal });
				if (template.code !== 0) throw opError(template, signal);
				item = JSON.parse(template.stdout) as Item;
				item.title = params.title.trim();
			} else {
				if (!params.item?.trim()) throw new Error("edit needs the item");
				if (params.category) throw new Error("edit cannot change the category");
				item = await opJson<Item>(["item", "get", params.item, ...vaultArgs(params.vault)], signal);
				if (params.title?.trim()) item.title = params.title.trim();
			}
			if (params.urls) item.urls = params.urls.map((href, index) => ({ href, primary: index === 0 }));
			if (params.tags) item.tags = params.tags;
			const { changed, notes } = await applyFields(item, specs, ctx.cwd, signal);
			if (params.action === "edit" && notes.length === 0 && !params.title && !params.urls && !params.tags) throw new Error("nothing to change");

			// op takes the item as JSON only from a file (it reads standard input only from a named pipe, not from the
			// socket Node gives a child): a private one, removed at once.
			const dir = mkdtempSync(path.join(os.tmpdir(), "pi-onepassword-"));
			let saved: Item;
			try {
				const file = path.join(dir, "item.json");
				writeFileSync(file, JSON.stringify(item), { mode: 0o600 });
				saved =
					params.action === "create"
						? await opJson<Item>(["item", "create", "--template", file, ...vaultArgs(params.vault)], signal)
						: await opJson<Item>(["item", "edit", item.id, "--template", file, ...vaultArgs(params.vault)], signal);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
			const head = `${params.action === "create" ? "Created" : "Changed"} ${saved.title ?? "(untitled)"} (id ${saved.id}) in vault ${saved.vault?.name ?? "?"}.`;
			const extra: string[] = [];
			if (params.urls) extra.push(`Websites: ${params.urls.map(host).join(", ") || "none"}`);
			if (params.tags) extra.push(`Tags: ${params.tags.join(", ") || "none"}`);
			const references = describeFields(saved, changed);
			const lines = [head, ...extra];
			if (notes.length) lines.push("Fields:", ...notes);
			if (references.length) lines.push("References:", ...references);
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
	});
}
