/**
 * The instances of a tool's config file and their tokens, shared by gitlab.ts (gitlab.json) and openproject.ts
 * (openproject.json).
 *
 * Pi does not load this file as an extension: it sits in a subdirectory without index.ts. Extensions import it.
 *
 * - The file holds a list [{"url": "https://…", "token": "…"}, …], the first instance being the default, or a single
 *   {"url": …, "token": …} without the list.
 * - token follows Pi's apiKey convention in models.json: a literal token, "$NAME" or "${NAME}" for an environment
 *   variable, or "!command" for the output of a shell command (a password manager); "$$" and "$!" are a literal $ and
 *   !. "tokenEnv": "NAME" is short for "token": "$NAME"; without either, the tool's default variable holds the token.
 * - Environment variables are read at every call. A command runs through /bin/sh at the first call and its token is
 *   kept for the session, until the instance rejects it (forgetToken).
 * - A literal token in a config file that others can read draws a warning.
 * - An instance is named by its host plus the path it is served under (git.example.com, example.com/gitlab): the
 *   value of the tools' host parameter.
 */

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";

/** A token command may wait this long for a password manager to be unlocked. */
const TOKEN_COMMAND_TIMEOUT_MS = 30_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type TokenPart = { type: "literal"; value: string } | { type: "env"; name: string };

/** Where a token comes from: the output of a shell command, or literal text and environment variables. */
export type TokenSource = { type: "command"; command: string } | { type: "template"; parts: TokenPart[] };

export interface ConfiguredInstance {
	/** The host plus the path the application is served under, e.g. git.example.com or example.com/gitlab. */
	name: string;
	origin: string;
	/** Origin plus the path the application is served under, without a trailing slash. */
	base: string;
	/** The path the application is served under, without a trailing slash; empty at the root. */
	basePath: string;
	token: TokenSource;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A token setting as Pi reads apiKey in models.json: "!command", or text with $NAME, ${NAME}, $$, and $!. */
function parseToken(value: string): TokenSource {
	if (value.startsWith("!")) {
		if (!value.slice(1).trim()) throw new Error("token: the command after ! is empty");
		return { type: "command", command: value.slice(1) };
	}
	const parts: TokenPart[] = [];
	const literal = (text: string) => {
		const last = parts[parts.length - 1];
		if (last?.type === "literal") last.value += text;
		else if (text) parts.push({ type: "literal", value: text });
	};
	let index = 0;
	while (index < value.length) {
		const dollar = value.indexOf("$", index);
		if (dollar < 0) {
			literal(value.slice(index));
			break;
		}
		literal(value.slice(index, dollar));
		const next = value[dollar + 1];
		if (next === "$" || next === "!") {
			literal(next);
			index = dollar + 2;
			continue;
		}
		if (next === "{") {
			const end = value.indexOf("}", dollar + 2);
			const name = end < 0 ? "" : value.slice(dollar + 2, end);
			if (ENV_NAME.test(name)) {
				parts.push({ type: "env", name });
				index = end + 1;
				continue;
			}
		}
		const name = value.slice(dollar + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
		if (name) {
			parts.push({ type: "env", name });
			index = dollar + 1 + name.length;
			continue;
		}
		literal("$");
		index = dollar + 1;
	}
	return { type: "template", parts };
}

/** One instance of the file; where names it in errors ([1]), empty for the single-instance form. */
function parseInstance(entry: unknown, where: string, defaultTokenEnv: string): ConfiguredInstance {
	const prefix = where ? `${where}: ` : "";
	if (!isObject(entry) || typeof entry.url !== "string" || !entry.url) {
		throw new Error(
			where
				? `${prefix}expected {"url": "https://…", "token": "…"}`
				: 'expected [{"url": "https://…", "token": "…"}, …] or a single {"url": "https://…", "token": "…"}',
		);
	}
	if (entry.token !== undefined && entry.tokenEnv !== undefined) throw new Error(`${prefix}give either token or tokenEnv, not both`);
	if (entry.token !== undefined && (typeof entry.token !== "string" || !entry.token.trim())) {
		throw new Error(`${prefix}token must be a token, "$NAME" for an environment variable, or "!command"`);
	}
	const tokenEnv = entry.tokenEnv ?? defaultTokenEnv;
	if (typeof tokenEnv !== "string" || !ENV_NAME.test(tokenEnv)) {
		throw new Error(`${prefix}tokenEnv must be the name of an environment variable`);
	}
	let token: TokenSource;
	try {
		token =
			typeof entry.token === "string"
				? parseToken(entry.token.trim())
				: { type: "template", parts: [{ type: "env", name: tokenEnv }] };
	} catch (error) {
		throw new Error(`${prefix}${error instanceof Error ? error.message : String(error)}`);
	}
	let url: URL;
	try {
		url = new URL(entry.url);
	} catch {
		throw new Error(`${prefix}${entry.url} is not a URL`);
	}
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`${prefix}the url must use https`);
	const basePath = url.pathname.replace(/\/+$/, "");
	return { name: url.host + basePath, origin: url.origin, base: url.origin + basePath, basePath, token };
}

/**
 * The instances of a config file, the default first, each with the paths extend adds, and a warning about the file;
 * undefined without the file.
 */
export function loadInstances<Paths extends object>(
	file: string,
	defaultTokenEnv: string,
	extend: (basePath: string) => Paths,
): { instances: Array<ConfiguredInstance & Paths>; warning?: string } | Error | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	try {
		const config = JSON.parse(text) as unknown;
		if (Array.isArray(config) && config.length === 0) throw new Error("the list of instances is empty");
		const instances = Array.isArray(config)
			? config.map((entry, index) => parseInstance(entry, `[${index}]`, defaultTokenEnv))
			: [parseInstance(config, "", defaultTokenEnv)];
		const names = new Set<string>();
		for (const instance of instances) {
			if (names.has(instance.name)) throw new Error(`${instance.name} is configured twice`);
			names.add(instance.name);
		}
		const literal = instances.filter(
			(instance) => instance.token.type === "template" && instance.token.parts.some((part) => part.type === "literal"),
		);
		let warning: string | undefined;
		if (literal.length > 0 && process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
			const which = literal.map((instance) => instance.name).join(", ");
			warning = `${file} holds the token of ${which} and others can read it: chmod 600 ${file}`;
		}
		return { instances: instances.map((instance) => ({ ...instance, ...extend(instance.basePath) })), warning };
	} catch (error) {
		return new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The schema of the host parameter: one of the instances' names; product names the application (GitLab). */
export function hostParameter(instances: ConfiguredInstance[], product: string) {
	return StringEnum(
		instances.map((instance) => instance.name),
		{ description: `The ${product} instance; default ${instances[0].name}. A full URL in path picks its instance by itself` },
	);
}

/**
 * The instance of a call: the one host names, else the one a full URL in path belongs to (owns says which), else the
 * default.
 */
export function pickInstance<T extends ConfiguredInstance>(
	instances: T[],
	host: string | undefined,
	target: string,
	owns: (instance: T, url: URL) => boolean,
	file: string,
): T {
	const names = instances.map((instance) => instance.name).join(", ");
	if (host?.trim()) {
		const wanted = host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
		const found = instances.find((instance) => instance.name.toLowerCase() === wanted);
		if (!found) throw new Error(`host ${host} is not configured in ${file} (configured: ${names})`);
		return found;
	}
	const trimmed = target.trim();
	if (instances.length > 1 && /^https?:\/\//i.test(trimmed)) {
		const url = new URL(trimmed);
		const found = instances.find((instance) => url.origin === instance.origin && owns(instance, url));
		if (!found) throw new Error(`${target} is outside the API of every configured instance (${names})`);
		return found;
	}
	return instances[0];
}

/** The tokens token commands printed, by command, kept for the session until an instance rejects one. */
const commandTokens = new Map<string, string>();

/** Runs a token command through /bin/sh, as Pi does for apiKey, and returns its trimmed output. */
function runTokenCommand(command: string, what: string, signal: AbortSignal | undefined): Promise<string> {
	return new Promise((resolve, reject) => {
		const fail = (why: string) => reject(new Error(`The token command of ${what} ${why}.`));
		const child = spawn("/bin/sh", ["-c", command], {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: TOKEN_COMMAND_TIMEOUT_MS,
			signal,
		});
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", (error) => (signal?.aborted ? reject(error) : fail(`cannot run (${error.message})`)));
		child.on("close", (code, killedBy) => {
			if (code !== 0) {
				return fail(
					killedBy ? `was stopped (${killedBy}; it may run ${TOKEN_COMMAND_TIMEOUT_MS / 1000} s)` : `exited with status ${code}`,
				);
			}
			const token = Buffer.concat(chunks).toString("utf8").trim();
			if (!token) fail("printed no token");
			else resolve(token);
		});
	});
}

/**
 * The token of an instance, from the environment, the config, or its command; throws with what to fix. howTo says
 * where to create a token, e.g. "Create an API token in https://… under My account → Access tokens".
 */
export async function resolveToken(
	instance: ConfiguredInstance,
	file: string,
	howTo: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const source = instance.token;
	let token: string;
	if (source.type === "command") {
		token = commandTokens.get(source.command) ?? (await runTokenCommand(source.command, `${instance.name} in ${file}`, signal));
		commandTokens.set(source.command, token);
	} else {
		const missing = source.parts.flatMap((part) => (part.type === "env" && !process.env[part.name] ? [part.name] : []));
		if (missing.length > 0) {
			throw new Error(
				`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set in Pi's environment, so ${instance.name} ` +
					`has no token. ${howTo}, export it as ${missing[0]}, and start Pi again — or set token in ${file} to the ` +
					`token itself or to a command that prints it ("!command").`,
			);
		}
		token = source.parts.map((part) => (part.type === "literal" ? part.value : process.env[part.name])).join("");
	}
	if (/[\r\n]/.test(token)) throw new Error(`The token of ${instance.name} contains a line break.`);
	return token;
}

/**
 * Drops the kept token of an instance that rejected it (401), so that its command runs again at the next call; says
 * whether there was a command.
 */
export function forgetToken(instance: ConfiguredInstance): boolean {
	if (instance.token.type !== "command") return false;
	commandTokens.delete(instance.token.command);
	return true;
}
