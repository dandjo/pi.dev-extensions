/**
 * HashiCorp Vault: tools that list, read, write, and delete secrets in KV version 2 secrets engines, run commands with
 * secrets, and log in, through Vault's HTTP API, so that no secret value reaches the model.
 *
 * - The address comes from VAULT_ADDR (without it the extension adds no tools), the token from VAULT_TOKEN or
 *   ~/.vault-token, as the vault CLI keeps it after `vault login`; VAULT_NAMESPACE where set. Both are read anew for
 *   every call, so a new login holds at once.
 * - Paths are written as for the vault CLI, with the mount first: secret/app/database. A field of a secret
 *   is path#field.
 * - vault_list lists the folders and secrets under a path, or the KV version 2 mounts. vault_secret shows a secret's
 *   versions and its fields by name, whether each is set, and its path#field reference; never a value, and of the
 *   custom metadata only the keys.
 * - vault_run runs a shell command with secrets in environment variables given as path#field references. The values
 *   go to the command alone and are masked in its output (a safety net). The command runs in a session of its own
 *   without a terminal, as the bash tool's do.
 * - vault_write sets or removes fields of a secret, read and written back in one step with check-and-set, so the
 *   secret's other fields stay and a change made meanwhile is not overwritten. A secret value only comes from a
 *   generated password, a command's output, a file, or another secret's field; value is for what is not secret.
 *   Creating a secret needs create, so a typing error makes no new path. Action delete removes a secret's current
 *   version (soft delete): Vault keeps the earlier versions, and the deleted one can be undeleted by whoever may.
 * - vault_login logs in with OIDC through the vault CLI: the browser opens the identity provider's page, and the new
 *   token goes to ~/.vault-token. Without the vault CLI on the PATH the extension adds no vault_login.
 * - A renewable token is renewed on use: before a vault_* call, when less than half its TTL (at most 30 minutes) is
 *   left. A token nobody uses expires as Vault set it. Once Vault renews no further (its maximum TTL), the call's
 *   result says until when the token holds.
 */

import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REQUEST_TIMEOUT_MS = 30_000;
/** How long vault_login waits for the user to log in in the browser. */
const LOGIN_TIMEOUT_MS = 180_000;
/** Renew the token when less than this, or half its TTL, is left. */
const RENEW_BELOW_S = 30 * 60;
/** How long a command that gives a field its value may take. */
const COMMAND_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_DEFAULT_S = 300;
const RUN_TIMEOUT_MAX_S = 3600;
/** The output vault_run returns: its end, at most this many lines and bytes, as the bash tool does. */
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
/** The command output vault_run keeps before masking: its end; far more than it returns. */
const MAX_RAW_BYTES = 4 * 1024 * 1024;
const LIST_LIMIT_DEFAULT = 200;
const MASK = "<concealed by Vault>";
const SYMBOLS = "-_.!@*";
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";

type Answer = { status: number; json: any };
type Location = { mount: string; rest: string; display: string };
type VersionMeta = { version?: number; created_time?: string; deletion_time?: string; destroyed?: boolean; custom_metadata?: Record<string, string> | null };
type Secret = { data: Record<string, unknown> | null; metadata: VersionMeta };
type Metadata = {
	current_version: number;
	oldest_version: number;
	created_time?: string;
	updated_time?: string;
	custom_metadata?: Record<string, string> | null;
	versions?: Record<string, { created_time?: string; deletion_time?: string; destroyed?: boolean }>;
};

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

const hasLogin = () => onPath("vault");
const loginHint = () => (hasLogin() ? "log in with vault_login" : "log in with `vault login -method=oidc`");

function address(): string {
	const addr = process.env.VAULT_ADDR?.trim();
	if (!addr) throw new Error("VAULT_ADDR is not set.");
	return addr.replace(/\/+$/, "");
}

function token(): string | undefined {
	const fromEnv = process.env.VAULT_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	try {
		return readFileSync(path.join(os.homedir(), ".vault-token"), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

const encodePath = (value: string) => value.split("/").map(encodeURIComponent).join("/");

async function call(method: string, apiPath: string, signal?: AbortSignal, body?: unknown): Promise<Answer> {
	const secret = token();
	if (!secret) throw new Error(`There is no Vault token: ${loginHint()}.`);
	const headers: Record<string, string> = { "X-Vault-Token": secret, "X-Vault-Request": "true" };
	if (process.env.VAULT_NAMESPACE?.trim()) headers["X-Vault-Namespace"] = process.env.VAULT_NAMESPACE.trim();
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])];
	let response: Response;
	try {
		response = await fetch(`${address()}/v1/${apiPath}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.any(signals),
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Cancelled.");
		const cause = (error as { cause?: { code?: string; message?: string } }).cause;
		throw new Error(`Vault at ${address()} did not answer: ${cause?.code ?? cause?.message ?? (error as Error).message}`);
	}
	const text = await response.text();
	let json: any;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = undefined;
	}
	return { status: response.status, json };
}

type Token = {
	display_name?: string;
	expire_time?: string | null;
	policies?: string[];
	identity_policies?: string[];
	ttl?: number;
	creation_ttl?: number;
	renewable?: boolean;
};

/**
 * The token's details, or undefined when there is no token or Vault rejects it (401/403). Anything else, Vault not
 * answering or answering with another error, throws: it says nothing about the token.
 */
async function lookupSelf(signal?: AbortSignal): Promise<Token | undefined> {
	if (!token()) return undefined;
	const answer = await call("GET", "auth/token/lookup-self", signal);
	if (answer.status === 200) return answer.json?.data as Token;
	if (answer.status === 401 || answer.status === 403) return undefined;
	const errors = ((answer.json?.errors ?? []) as unknown[]).map(String).filter(Boolean).join("; ");
	throw new Error(`Vault could not check the token: ${errors || `it answered ${answer.status}`}`);
}

/** Until when the token needs no look: it is far from expiry, or cannot be renewed. Kept per token. */
let renewal: { token: string; checkAfter: number } | undefined;

/**
 * Renews the token when little of its TTL is left. Returns a note for the call's result once Vault renews no further;
 * every failure is left to the call itself.
 */
async function keepAlive(signal?: AbortSignal): Promise<string | undefined> {
	try {
		const secret = token();
		if (!secret || (renewal?.token === secret && Date.now() < renewal.checkAfter)) return undefined;
		const self = await lookupSelf(signal);
		if (!self) return undefined;
		const ttl = Number(self.ttl ?? 0);
		if (!self.renewable || ttl <= 0) {
			renewal = { token: secret, checkAfter: Number.POSITIVE_INFINITY };
			return undefined;
		}
		// A renewal sets the TTL anew from now: only when less than half the original one is left, so it never shortens it.
		const below = Math.min(RENEW_BELOW_S, Number(self.creation_ttl ?? 0) / 2 || RENEW_BELOW_S);
		if (ttl >= below) {
			renewal = { token: secret, checkAfter: Date.now() + (ttl - below) * 1000 };
			return undefined;
		}
		const answer = await call("POST", "auth/token/renew-self", signal, {});
		if (answer.status !== 200) {
			renewal = { token: secret, checkAfter: Date.now() + 60_000 };
			return undefined;
		}
		const left = Number(answer.json?.auth?.lease_duration ?? 0);
		if (left >= below) {
			renewal = { token: secret, checkAfter: Date.now() + (left - below) * 1000 };
			return undefined;
		}
		const until = new Date(Date.now() + left * 1000).toISOString().replace(/\.\d+Z$/, "Z");
		return `The Vault token expires in ${Math.max(0, Math.round(left / 60))} minutes (${until}) and Vault renews it no further: ${loginHint()} then.`;
	} catch {
		return undefined;
	}
}

const describeToken = (self: Token) =>
	`${self.display_name ?? "?"}, valid until ${self.expire_time ?? "it is revoked"}, policies: ${[...(self.policies ?? []), ...(self.identity_policies ?? [])].join(", ") || "none"}`;

/** Vault's error for a request; a 403 tells an expired token from a missing permission. */
async function failure(answer: Answer, what: string, signal?: AbortSignal): Promise<Error> {
	const errors = ((answer.json?.errors ?? []) as unknown[]).map(String).filter(Boolean).join("; ");
	if (answer.status === 401 || answer.status === 403) {
		// An expired token gets a 403 as well: ask Vault whether the token still holds.
		const self = await lookupSelf(signal);
		if (!self) return new Error(`${what}: the Vault token is missing or expired; ${loginHint()}.`);
		return new Error(`${what}: permission denied (token ${describeToken(self)}).`);
	}
	return new Error(`${what}: ${errors || `Vault answered ${answer.status}`}`);
}

/** Splits a CLI-style path into its mount and the path within it; only KV version 2 mounts. */
async function locate(input: string, signal?: AbortSignal): Promise<Location> {
	const clean = input.trim().replace(/^\/+|\/+$/g, "");
	if (!clean) throw new Error("the path is empty");
	if (clean.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error(`"${input}" is not a valid path`);
	const answer = await call("GET", `sys/internal/ui/mounts/${encodePath(clean)}`, signal);
	if (answer.status !== 200) {
		if (answer.status === 403 && (await lookupSelf(signal))) throw new Error(`${clean}: no secrets engine is mounted there, or you may not see it`);
		throw await failure(answer, clean, signal);
	}
	const mount = String(answer.json?.data?.path ?? "");
	const type = String(answer.json?.data?.type ?? "?");
	const version = answer.json?.data?.options?.version;
	if (type !== "kv" || String(version) !== "2") {
		throw new Error(`${clean} is in ${mount || "?"}, a ${type}${version ? ` version ${version}` : ""} secrets engine; these tools handle KV version 2 only`);
	}
	const withSlash = `${clean}/`;
	const rest = withSlash.startsWith(mount) ? withSlash.slice(mount.length).replace(/\/$/, "") : clean;
	return { mount, rest, display: mount + rest };
}

/** The secret's latest version, or the given one; a deleted or destroyed version comes back with data null. */
async function readSecret(location: Location, signal?: AbortSignal, version?: number): Promise<Secret | undefined> {
	const query = version ? `?version=${version}` : "";
	const answer = await call("GET", `${location.mount}data/${encodePath(location.rest)}${query}`, signal);
	if (answer.status === 404) return answer.json?.data?.metadata ? { data: null, metadata: answer.json.data.metadata } : undefined;
	if (answer.status !== 200) throw await failure(answer, location.display, signal);
	return answer.json.data as Secret;
}

async function readMetadata(location: Location, signal?: AbortSignal): Promise<Metadata | undefined> {
	if (!location.rest) return undefined;
	const answer = await call("GET", `${location.mount}metadata/${encodePath(location.rest)}`, signal);
	if (answer.status === 404) return undefined;
	if (answer.status !== 200) throw await failure(answer, location.display, signal);
	return answer.json.data as Metadata;
}

/** A path#field reference: the field after the last #. */
function parseReference(reference: string): { secretPath: string; field: string } {
	const at = reference.lastIndexOf("#");
	const secretPath = at > 0 ? reference.slice(0, at).trim() : "";
	const field = at > 0 ? reference.slice(at + 1).trim() : "";
	if (!secretPath || !field) throw new Error(`"${reference}" is not a reference: write path#field, e.g. secret/app/database#password`);
	return { secretPath, field };
}

const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
const isSet = (value: unknown) => (typeof value === "string" ? value.length > 0 : value !== undefined && value !== null);

/** The value of a path#field reference, for a command or another secret; never returned to the model. */
async function resolve(reference: string, signal?: AbortSignal, cache?: Map<string, Secret | undefined>): Promise<string> {
	const { secretPath, field } = parseReference(reference);
	const location = await locate(secretPath, signal);
	let secret = cache?.get(location.display);
	if (!cache?.has(location.display)) {
		secret = await readSecret(location, signal);
		cache?.set(location.display, secret);
	}
	if (!secret) throw new Error(`${reference}: there is no secret at ${location.display}`);
	if (!secret.data) throw new Error(`${reference}: the current version of ${location.display} is deleted`);
	if (!(field in secret.data)) throw new Error(`${reference}: ${location.display} has no field "${field}" (vault_secret lists its fields)`);
	return asText(secret.data[field]);
}

function fieldLines(location: Location, data: Record<string, unknown>, only?: Set<string>): string[] {
	return Object.keys(data)
		.filter((name) => !only || only.has(name))
		.sort((a, b) => a.localeCompare(b))
		.map((name) => {
			const value = data[name];
			const state = !isSet(value) ? "empty" : typeof value === "string" ? "set" : `set (JSON ${Array.isArray(value) ? "array" : typeof value})`;
			return `- ${name}: ${state} → ${location.display}#${name}`;
		});
}

function generatePassword(spec: { length?: number; digits?: boolean; symbols?: boolean }): string {
	const length = Math.round(spec.length ?? 32);
	if (!(length >= 8 && length <= 128)) throw new Error("generate.length must be between 8 and 128");
	const sets = [LETTERS, ...(spec.digits === false ? [] : [DIGITS]), ...(spec.symbols === true ? [SYMBOLS] : [])];
	const all = sets.join("");
	for (;;) {
		let password = "";
		for (let i = 0; i < length; i++) password += all[randomInt(all.length)];
		// Each chosen kind of character at least once.
		if (sets.every((set) => [...password].some((char) => set.includes(char)))) return password;
	}
}

/** A command's standard output, for a field: the command runs without a terminal and nothing of it comes back. */
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

/** Replaces every secret value in a text, and each longer line of a value of several lines. */
function masker(values: string[]): (text: string) => string {
	const needles = new Set<string>();
	for (const value of values) {
		if (value) needles.add(value);
		if (value.trim()) needles.add(value.trim());
		if (value.includes("\n")) for (const line of value.split(/\r?\n/)) if (line.trim().length >= 8) needles.add(line.trim());
	}
	const sorted = [...needles].sort((a, b) => b.length - a.length);
	return (text) => sorted.reduce((masked, needle) => masked.split(needle).join(MASK), text);
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
	name: string;
	value?: string;
	generate?: boolean | { length?: number; digits?: boolean; symbols?: boolean };
	command?: string;
	file?: string;
	from?: string;
	delete?: boolean;
};

export default function (pi: ExtensionAPI) {
	if (!process.env.VAULT_ADDR?.trim()) return;

	const renewed = new Set(["vault_list", "vault_secret", "vault_run", "vault_write"]);
	const notes = new Map<string, string>();
	pi.on("tool_call", async (event, ctx) => {
		if (!renewed.has(event.toolName)) return;
		const note = await keepAlive(ctx.signal);
		if (note) notes.set(event.toolCallId, note);
	});
	pi.on("tool_result", (event) => {
		const note = notes.get(event.toolCallId);
		if (!note) return;
		notes.delete(event.toolCallId);
		return { content: [...event.content, { type: "text", text: note }] };
	});

	pi.registerTool({
		name: "vault_list",
		label: "Vault list",
		description:
			"List the folders (ending in /) and secrets under a path in HashiCorp Vault, written as for the vault CLI with the mount " +
			"first (e.g. secret/app); without a path, the KV version 2 mounts. filter keeps the names containing it. Shows no values.",
		promptSnippet: "List HashiCorp Vault folders and secrets, without values",
		promptGuidelines: [
			"vault_*: for HashiCorp Vault use these tools instead of the vault CLI or curl in bash: they never return a value. Hand a secret to a command as a path#field reference in vault_run's env instead of reading it with vault kv get.",
			"vault_*: never print a secret; in vault_write a secret comes from generate, command, file, or from (another secret's field), and value only for what is not secret, such as a user name or a host. vault_write's action delete only for a secret the user named.",
			"vault_*: when a call reports the Vault token missing or expired, call vault_login, which asks the user to log in in the browser.",
		],
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Path with the mount first, e.g. secret/app; empty for the mounts" })),
			filter: Type.Optional(Type.String({ description: "Only names containing this, case-insensitive" })),
			limit: Type.Optional(Type.Number({ description: `At most this many entries (default ${LIST_LIMIT_DEFAULT})` })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async execute(_id, params, signal) {
			const limit = Math.max(1, Math.round(params.limit ?? LIST_LIMIT_DEFAULT));
			const filter = params.filter?.trim().toLowerCase();
			let head: string;
			let names: string[];
			if (!params.path?.trim().replace(/^\/+|\/+$/g, "")) {
				const answer = await call("GET", "sys/mounts", signal);
				if (answer.status !== 200) throw await failure(answer, "the list of mounts", signal);
				const mounts = (answer.json?.data ?? answer.json ?? {}) as Record<string, { type?: string; options?: { version?: string } | null }>;
				names = Object.entries(mounts)
					.filter(([, mount]) => mount?.type === "kv" && String(mount.options?.version) === "2")
					.map(([name]) => name);
				head = "KV version 2 mounts";
			} else {
				const location = await locate(params.path, signal);
				const folder = location.rest ? `${encodePath(location.rest)}/` : "";
				const answer = await call("GET", `${location.mount}metadata/${folder}?list=true`, signal);
				if (answer.status === 404) {
					const secret = location.rest ? await readMetadata(location, signal) : undefined;
					const text = secret ? `${location.display} is a secret, not a folder: vault_secret shows it.` : `Nothing under ${location.display}/.`;
					return { content: [{ type: "text", text }], details: undefined };
				}
				if (answer.status !== 200) throw await failure(answer, location.display, signal);
				names = (answer.json?.data?.keys ?? []) as string[];
				head = `${location.display}${location.rest ? "/" : ""}`;
			}
			const hits = names.filter((name) => !filter || name.toLowerCase().includes(filter)).sort((a, b) => a.localeCompare(b));
			const folders = hits.filter((name) => name.endsWith("/")).length;
			const count = `${folders} folder${folders === 1 ? "" : "s"}, ${hits.length - folders} secret${hits.length - folders === 1 ? "" : "s"}`;
			const lines = [`${head}: ${hits.length ? count : "nothing"}${filter ? ` matching "${params.filter?.trim()}"` : ""}${hits.length > limit ? `, the first ${limit}` : ""}`];
			lines.push(...hits.slice(0, limit));
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "vault_secret",
		label: "Vault secret",
		description:
			"Show a HashiCorp Vault secret (KV version 2): its versions, the keys of its custom metadata, and its fields by name, whether " +
			"each is set, and its path#field reference for vault_run and vault_write's from. Never shows a value.",
		promptSnippet: "Show a HashiCorp Vault secret's fields and path#field references, without values",
		parameters: Type.Object({
			path: Type.String({ description: "The secret's path with the mount first, e.g. secret/app/database" }),
			version: Type.Optional(Type.Number({ description: "A version to show instead of the current one" })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async execute(_id, params, signal) {
			const location = await locate(params.path, signal);
			const metadata = await readMetadata(location, signal);
			if (!metadata) throw new Error(`There is no secret at ${location.display}; vault_list shows what is there.`);
			const secret = await readSecret(location, signal, params.version);
			const version = secret?.metadata?.version ?? params.version ?? metadata.current_version;
			const lines = [`${location.display} (KV version 2 at ${location.mount})`];
			lines.push(
				`Version ${version}${version === metadata.current_version ? " (current)" : ` (current: ${metadata.current_version})`}` +
					`${secret?.metadata?.created_time ? `, written ${secret.metadata.created_time}` : ""}; secret created ${metadata.created_time ?? "?"}`,
			);
			const history = Object.entries(metadata.versions ?? {})
				.map(([number, entry]) => ({ number: Number(number), ...entry }))
				.sort((a, b) => b.number - a.number)
				.slice(0, 5)
				.map((entry) => `${entry.number}${entry.destroyed ? " destroyed" : entry.deletion_time ? " deleted" : ""} (${entry.created_time?.slice(0, 19) ?? "?"})`);
			if (history.length > 1) lines.push(`Versions, newest first: ${history.join(", ")}${Object.keys(metadata.versions ?? {}).length > 5 ? ", …" : ""}`);
			const custom = Object.keys(metadata.custom_metadata ?? {});
			if (custom.length) lines.push(`Custom metadata keys: ${custom.sort().join(", ")}`);
			if (!secret?.data) {
				const state = secret?.metadata?.destroyed ? "destroyed" : `deleted${secret?.metadata?.deletion_time ? ` (${secret.metadata.deletion_time})` : ""}`;
				lines.push(`This version is ${state}: its fields cannot be read.`);
			} else {
				const fields = fieldLines(location, secret.data);
				lines.push(fields.length ? `Fields (${fields.length}):` : "Fields: none", ...fields);
				if (version !== metadata.current_version) lines.push("References always read the current version.");
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "vault_run",
		label: "Vault run",
		description:
			"Run a shell command (bash) with secrets from HashiCorp Vault in environment variables: env maps each variable to a path#field " +
			'reference (from vault_secret), e.g. {command: "printenv TOKEN | docker login -u ci --password-stdin registry.example.com", ' +
			'env: {TOKEN: "secret/ci/registry#token"}}. The values reach the command alone and are masked in its output (a safety net: ' +
			"never print them). The command runs without a terminal; returns its output (the last 2000 lines or 50 KB) and exit code.",
		promptSnippet: "Run a command with HashiCorp Vault secrets as environment variables, output masked",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command, run by bash" }),
			env: Type.Record(Type.String(), Type.String(), { description: "Environment variable name → path#field reference" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: the session's)" })),
			timeout: Type.Optional(Type.Number({ description: `Seconds before the command is stopped (default ${RUN_TIMEOUT_DEFAULT_S}, at most ${RUN_TIMEOUT_MAX_S})` })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(_id, params, signal, _onUpdate, ctx) {
			const names = Object.keys(params.env ?? {});
			if (names.length === 0) throw new Error("env needs at least one variable with a path#field reference; without secrets use bash");
			const secrets: Record<string, string> = {};
			const cache = new Map<string, Secret | undefined>();
			for (const name of names) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a valid variable name`);
				const reference: unknown = params.env[name];
				if (typeof reference !== "string") throw new Error(`${name}: the value must be a path#field reference`);
				secrets[name] = await resolve(reference, signal, cache);
			}
			const mask = masker(Object.values(secrets));
			const cwd = path.resolve(ctx.cwd, params.cwd ?? ".");
			const timeoutS = Math.min(Math.max(1, params.timeout ?? RUN_TIMEOUT_DEFAULT_S), RUN_TIMEOUT_MAX_S);
			const result = await new Promise<{ code: number | null; output: string; timedOut: boolean }>((resolveRun, rejectRun) => {
				// A session of its own, without Pi's terminal; killed as a whole.
				const child = spawn("bash", ["-c", params.command], { cwd, env: { ...process.env, ...secrets }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
				let output = "";
				let timedOut = false;
				const add = (chunk: Buffer) => {
					output += chunk.toString("utf8");
					if (output.length > MAX_RAW_BYTES) output = output.slice(-MAX_RAW_BYTES);
				};
				child.stdout?.on("data", add);
				child.stderr?.on("data", add);
				const kill = () => {
					try {
						if (child.pid) process.kill(-child.pid, "SIGKILL");
					} catch {
						// Already gone.
					}
				};
				const timer = setTimeout(() => {
					timedOut = true;
					kill();
				}, timeoutS * 1000);
				signal?.addEventListener("abort", kill, { once: true });
				child.on("error", (error) => {
					clearTimeout(timer);
					rejectRun(error);
				});
				child.on("close", (code) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", kill);
					resolveRun({ code, output, timedOut });
				});
			});
			const notes: string[] = [];
			if (signal?.aborted) notes.push("[cancelled]");
			else if (result.timedOut) notes.push(`[stopped after ${timeoutS} s]`);
			else if (result.code !== 0) notes.push(`[exit code ${result.code}]`);
			// Masked before it is cut, so that no cut leaves part of a value.
			const text = [tail(mask(result.output).trimEnd()) || "(no output)", ...notes].join("\n");
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "vault_write",
		label: "Vault write",
		description:
			'Change a HashiCorp Vault secret (KV version 2). Action "write" (default) sets or removes the fields given and keeps the others: ' +
			"each field takes exactly one of value (only for what is not secret, e.g. a user name or host), generate (a random password: " +
			"{length, digits, symbols}, default 32 letters and digits), command (its standard output), file (its content), from (another " +
			"secret's path#field), or delete. It writes a new version with check-and-set, so a change made meanwhile is not overwritten; a new " +
			'secret needs create: true. Action "delete" deletes the secret\'s current version (soft delete; earlier versions stay readable). ' +
			"Returns what changed and the references, never a value.",
		promptSnippet: "Set or remove fields of a HashiCorp Vault secret, or delete it; secrets only generated or from a command, file, or secret",
		parameters: Type.Object({
			path: Type.String({ description: "The secret's path with the mount first, e.g. secret/app/database" }),
			action: Type.Optional(StringEnum(["write", "delete"] as const, { description: "write (default): set or remove fields; delete: delete the current version" })),
			create: Type.Optional(Type.Boolean({ description: "write: create the secret if there is none (else a missing secret is an error)" })),
			fields: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "Field name, e.g. MARIADB_PASSWORD" }),
						value: Type.Optional(Type.String({ description: "The value of a field that is not secret" })),
						generate: Type.Optional(
							Type.Union(
								[
									Type.Boolean(),
									Type.Object({
										length: Type.Optional(Type.Number({ description: "8 to 128, default 32" })),
										digits: Type.Optional(Type.Boolean({ description: "default true" })),
										symbols: Type.Optional(Type.Boolean({ description: `default false; true adds ${SYMBOLS}` })),
									}),
								],
								{ description: "A random password as the value" },
							),
						),
						command: Type.Optional(Type.String({ description: "Shell command whose standard output becomes the value (without its last newline)" })),
						file: Type.Optional(Type.String({ description: "File whose content becomes the value (without its last newline)" })),
						from: Type.Optional(Type.String({ description: "Another secret's field as path#field, copied" })),
						delete: Type.Optional(Type.Boolean({ description: "Remove the field" })),
					}),
				),
			),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(_id, params, signal, _onUpdate, ctx) {
			const location = await locate(params.path, signal);
			if (!location.rest) throw new Error("the path names a mount, not a secret");
			const specs = (params.fields ?? []) as FieldSpec[];

			if (params.action === "delete") {
				if (specs.length || params.create) throw new Error("delete takes no fields and no create; to remove fields use action write");
				const metadata = await readMetadata(location, signal);
				if (!metadata) throw new Error(`There is no secret at ${location.display}.`);
				const current = metadata.versions?.[String(metadata.current_version)];
				if (current?.deletion_time || current?.destroyed) {
					return { content: [{ type: "text", text: `The current version ${metadata.current_version} of ${location.display} is already ${current.destroyed ? "destroyed" : "deleted"}.` }], details: undefined };
				}
				const answer = await call("DELETE", `${location.mount}data/${encodePath(location.rest)}`, signal);
				if (answer.status !== 204 && answer.status !== 200) throw await failure(answer, location.display, signal);
				const readable = Object.entries(metadata.versions ?? {}).filter(
					([number, entry]) => Number(number) !== metadata.current_version && !entry.deletion_time && !entry.destroyed,
				).length;
				const earlier = readable ? `; ${readable} earlier version${readable === 1 ? " stays" : "s stay"} readable` : "";
				return {
					content: [{ type: "text", text: `Deleted version ${metadata.current_version} of ${location.display} (soft delete: it can be undeleted${earlier}).` }],
					details: undefined,
				};
			}

			if (specs.length === 0) throw new Error("write needs fields");
			const existing = await readSecret(location, signal);
			if (!existing?.data && !params.create) {
				throw new Error(
					existing
						? `The current version ${existing.metadata.version} of ${location.display} is deleted; set create: true to write a new version from scratch.`
						: `There is no secret at ${location.display}; set create: true to create it.`,
				);
			}
			const data: Record<string, unknown> = { ...(existing?.data ?? {}) };
			const changed = new Set<string>();
			const notes: string[] = [];
			const cache = new Map<string, Secret | undefined>();
			for (const spec of specs) {
				const name = spec.name?.trim();
				if (!name) throw new Error("every field needs a name");
				if (spec.delete) {
					if (!(name in data)) throw new Error(`there is no field "${name}" to remove`);
					delete data[name];
					changed.delete(name);
					notes.push(`- ${name}: removed`);
					continue;
				}
				const generate = spec.generate === true ? {} : spec.generate === false ? undefined : spec.generate;
				const sources = [spec.value !== undefined, generate !== undefined, spec.command !== undefined, spec.file !== undefined, spec.from !== undefined].filter(Boolean).length;
				if (sources !== 1) throw new Error(`field "${name}": give exactly one of value, generate, command, file, from, or delete`);
				let value: string;
				let how: string;
				if (spec.value !== undefined) {
					value = spec.value;
					how = "set to the given text";
				} else if (generate) {
					value = generatePassword(generate);
					how = `generated, ${value.length} characters`;
				} else if (spec.command !== undefined) {
					value = await commandOutput(spec.command, ctx.cwd, signal);
					how = "set from the command's output";
				} else if (spec.file !== undefined) {
					value = readFileSync(path.resolve(ctx.cwd, spec.file), "utf8").replace(/\r?\n$/, "");
					how = "set from the file";
				} else {
					value = await resolve(spec.from as string, signal, cache);
					how = `copied from ${spec.from}`;
				}
				if (!value) throw new Error(`field "${name}" would be empty`);
				notes.push(`- ${name}: ${name in data ? "" : "new, "}${how}`);
				data[name] = value;
				changed.add(name);
			}
			const cas = existing ? (existing.metadata.version ?? 0) : 0;
			const answer = await call("POST", `${location.mount}data/${encodePath(location.rest)}`, signal, { options: { cas }, data });
			if (answer.status !== 200 && answer.status !== 204) {
				const errors = ((answer.json?.errors ?? []) as unknown[]).map(String).join("; ");
				if (/check-and-set/i.test(errors)) throw new Error(`${location.display} was changed meanwhile; nothing was written. Look at it again and repeat.`);
				throw await failure(answer, location.display, signal);
			}
			const version = answer.json?.data?.version;
			const head = existing?.data
				? `Changed ${location.display}: version ${version ?? "?"} (was ${cas}).`
				: `Created ${location.display}: version ${version ?? "?"}.`;
			const references = fieldLines(location, data, changed);
			const lines = [head, "Fields:", ...notes];
			if (references.length) lines.push("References:", ...references);
			lines.push(`The secret now has ${Object.keys(data).length} field${Object.keys(data).length === 1 ? "" : "s"}.`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
	});

	if (!hasLogin()) return;

	pi.registerTool({
		name: "vault_login",
		label: "Vault login",
		description:
			"Log in to HashiCorp Vault with OIDC through the vault CLI: the user's browser opens the identity provider's page, the user " +
			"logs in there, and the new token goes to ~/.vault-token. Only when the token is missing or expired (the other vault_* tools say " +
			"so), or with force; returns who is logged in until when, never the token.",
		promptSnippet: "Log in to HashiCorp Vault with OIDC in the user's browser",
		parameters: Type.Object({
			role: Type.Optional(Type.String({ description: "OIDC role (default: the mount's default role)" })),
			force: Type.Optional(Type.Boolean({ description: "Log in even if the token is still valid" })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async execute(_id, params, signal, onUpdate) {
			if (!params.force) {
				const self = await lookupSelf(signal);
				if (self) return { content: [{ type: "text", text: `Already logged in: ${describeToken(self)}.` }], details: undefined };
			}
			onUpdate?.({ content: [{ type: "text", text: `Waiting for the login in the browser (up to ${LOGIN_TIMEOUT_MS / 60_000} minutes) …` }], details: undefined });
			const args = ["login", "-method=oidc", "-no-print", ...(params.role?.trim() ? [`role=${params.role.trim()}`] : [])];
			const run = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolveRun, rejectRun) => {
				// No VAULT_TOKEN for the login, so the CLI keeps the new token in ~/.vault-token.
				const env = { ...process.env };
				delete env.VAULT_TOKEN;
				const child = spawn("vault", args, { env, stdio: ["ignore", "ignore", "pipe"] });
				let stderr = "";
				let timedOut = false;
				child.stderr?.on("data", (chunk: Buffer) => {
					stderr = (stderr + chunk.toString("utf8")).slice(-4000);
				});
				const kill = () => child.kill("SIGTERM");
				const timer = setTimeout(() => {
					timedOut = true;
					kill();
				}, LOGIN_TIMEOUT_MS);
				signal?.addEventListener("abort", kill, { once: true });
				child.on("error", (error) => {
					clearTimeout(timer);
					rejectRun(error);
				});
				child.on("close", (code) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", kill);
					resolveRun({ code, stderr, timedOut });
				});
			});
			if (signal?.aborted) throw new Error("Cancelled.");
			if (run.timedOut) {
				const ui = `${(process.env.VAULT_ADDR ?? "").trim().replace(/\/+$/, "")}/ui/`;
				throw new Error(
					`No login within ${LOGIN_TIMEOUT_MS / 60_000} minutes. Did the browser open? If the identity provider showed ` +
						`"Invalid parameter: redirect_uri" or a similar error, its client does not allow the CLI's redirect URI ` +
						`http://localhost:8250/oidc/callback, and only its admin can add it. Until then the user can log in on ${ui} ` +
						`in the browser, copy the token there (user menu, "Copy token"), and run \`vault login\` in a terminal, which ` +
						`asks for the token without showing it.`,
				);
			}
			if (run.code !== 0) {
				const lines = run.stderr.split("\n").map((line) => line.trim()).filter((line) => line && !/^https?:\/\//.test(line));
				throw new Error(`vault login failed: ${lines.slice(-3).join(" ") || `exit code ${run.code}`}`);
			}
			const self = await lookupSelf(signal).catch(() => undefined);
			const note = process.env.VAULT_TOKEN?.trim() ? " VAULT_TOKEN is set in Pi's environment and wins over ~/.vault-token: unset it, or the tools keep the old token." : "";
			return { content: [{ type: "text", text: `Logged in: ${self ? describeToken(self) : "the token could not be checked"}.${note}` }], details: undefined };
		},
	});
}
