/**
 * GitLab: the gitlab tool, which calls the REST API v4 and the GraphQL API of one or more GitLab instances, each with
 * its own personal access token.
 *
 * - The instances come from ~/.pi/agent/gitlab.json, a map from each instance's URL to its settings like mcpServers in
 *   mcp.json: {"instances": {"https://gitlab.example.com": {"token": "$GITLAB_TOKEN"}, …}}, the first instance being the
 *   default. Without that file the tool is not registered. With several instances the tool takes host, the instance's host (with its
 *   path, if GitLab is served below one), and a full URL in path picks its instance by itself.
 * - token follows Pi's apiKey convention in models.json: a literal token, "$NAME" or "${NAME}" for an environment
 *   variable, or "!command" for the output of a shell command (a password manager); "$$" and "$!" are a literal $ and !.
 *   "tokenEnv": "NAME" is short for "token": "$NAME", and without either the token is $GITLAB_TOKEN. Environment
 *   variables are read at every call; a command runs at the first call and its token is kept for the session, until
 *   the instance rejects it. A literal token in a config file that others can read draws a warning at session start.
 * - openproject.ts reads openproject.json with a copy of the same code, so both files work alike.
 * - A token goes only to its instance: paths and links that lead elsewhere are refused, and a redirect to another host
 *   (object storage, another instance) is followed without it.
 * - Secrets stay out of results, raw ones included: the token itself, fields named token or *_token (runners_token,
 *   the value of a newly created access token), and the value of a CI/CD variable that is masked or hidden or whose
 *   key names a secret.
 * - REST JSON is folded unless raw is set: empty fields, avatar URLs, and the _links of list items are left out; a user
 *   in another resource or a list becomes "Name (@username, id N)"; an object of zeros only (time_stats) is dropped;
 *   and a description in a list is cut. The pagination headers become a line above the body. File contents and
 *   GraphQL answers are returned as they are, job logs without their colour codes (unless raw is set), and binary
 *   content (artifacts, archives) is saved to a temp file. A cut job log keeps its end.
 * - files uploads local files as multipart/form-data (a project avatar, a markdown upload); the fields of body go
 *   along as form fields. Files go, like the token, only to the instance of the call.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	getAgentDir,
	getShellConfig,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";

const CONFIG_FILE = path.join(getAgentDir(), "gitlab.json");
const DEFAULT_TOKEN_ENV = "GITLAB_TOKEN";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Content types of uploaded files by extension; anything else goes as application/octet-stream. */
const UPLOAD_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".json": "application/json",
	".zip": "application/zip",
	".gz": "application/gzip",
};
/** A description in a list item is cut to this many characters. */
const LIST_DESCRIPTION_CHARS = 400;
const USER_AGENT = "pi-gitlab/1.0 (+https://pi.dev)";
const ACCEPT = "application/json, */*;q=0.1";
const REDACTED = "[redacted]";
/** The keys of a user as GitLab nests it in another resource (author, assignees, merged_by, …). */
const USER_KEYS = new Set(["id", "username", "name", "state", "locked", "avatar_url", "web_url", "public_email", "bot"]);
/** A CI/CD variable key that names a secret. */
const SECRET_KEY = /pass|secret|token|private|credential|auth|api_?key|_key$|^key$/i;
/** The colour and cursor codes of a job log. */
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** A field that holds a token: token, runners_token, runnersToken. */
const TOKEN_FIELD = /^token$|_token$|[a-z0-9]Token$/;
/** Paths whose body is content (files, logs, artifacts, archives), never folded. */
const CONTENT_PATH = /\/(raw|trace|artifacts|archive)(\/|\.|$)/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** An instance of gitlab.json with the paths of its APIs. */
type Instance = ConfiguredInstance & {
	/** The path every REST URL starts with, e.g. /api/v4 or /gitlab/api/v4. */
	api: string;
	/** The path of the GraphQL endpoint, e.g. /api/graphql. */
	graphql: string;
};

const within = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Whether a URL lies in the REST or GraphQL API of an instance. */
const owns = (instance: Instance, url: URL) => within(url.pathname, instance.api) || url.pathname === instance.graphql;

/** Appends a query parameter the way GitLab reads it: arrays as key[]=…, objects as key[sub]=…. */
function appendParam(params: URLSearchParams, key: string, value: unknown): void {
	if (value === undefined || value === null) return;
	if (Array.isArray(value)) {
		for (const item of value) appendParam(params, `${key}[]`, item);
	} else if (typeof value === "object") {
		for (const [sub, item] of Object.entries(value)) appendParam(params, `${key}[${sub}]`, item);
	} else {
		params.append(key, String(value));
	}
}

/** The URL for a path below /api/v4, /api/graphql, an href from a response, or a full URL; anything else is refused. */
function requestUrl(instance: Instance, target: string, query: Record<string, unknown> | undefined): URL {
	let url: URL;
	const trimmed = target.trim();
	if (/^https?:\/\//i.test(trimmed)) {
		url = new URL(trimmed);
	} else {
		let p = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
		const pathname = p.replace(/[?#].*$/, "");
		if (!within(pathname, instance.api) && pathname !== instance.graphql) {
			if (/^\/api\/graphql$/.test(pathname)) p = instance.graphql + p.slice("/api/graphql".length);
			else p = instance.api + (/^\/api\/v4(?=$|[/?])/.test(p) ? p.slice("/api/v4".length) : p);
		}
		url = new URL(p, instance.origin);
	}
	if (url.origin !== instance.origin || (!within(url.pathname, instance.api) && url.pathname !== instance.graphql)) {
		throw new Error(`${target} is outside the API of ${instance.base} (${instance.api}, ${instance.graphql})`);
	}
	for (const [key, value] of Object.entries(query ?? {})) {
		url.searchParams.delete(key);
		url.searchParams.delete(`${key}[]`);
		appendParam(url.searchParams, key, value);
	}
	return url;
}

/** A request body and its content type. */
interface Payload {
	contentType: string;
	data: string | Uint8Array;
}

/** Appends a form field the way GitLab reads it, like appendParam: arrays as key[], objects as key[sub]. */
function formFields(key: string, value: unknown, out: Array<[string, string]>): void {
	if (value === undefined || value === null) return;
	if (Array.isArray(value)) {
		for (const item of value) formFields(`${key}[]`, item, out);
	} else if (typeof value === "object") {
		for (const [sub, item] of Object.entries(value)) formFields(`${key}[${sub}]`, item, out);
	} else {
		out.push([key, String(value)]);
	}
}

/** A local path with ~ expanded, resolved against the working directory. */
function localPath(file: string): string {
	const trimmed = file.trim();
	if (trimmed === "~" || trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(1));
	return path.resolve(trimmed);
}

/** A multipart/form-data body with the fields of body and the given files (form field name → local path). */
function multipart(fields: Record<string, unknown> | undefined, files: Record<string, string>): Payload {
	const boundary = `pi-gitlab-${randomBytes(16).toString("hex")}`;
	const quoted = (text: string) => text.replace(/["\r\n]/g, (c) => encodeURIComponent(c));
	const parts: Uint8Array[] = [];
	const pairs: Array<[string, string]> = [];
	for (const [key, value] of Object.entries(fields ?? {})) formFields(key, value, pairs);
	for (const [name, value] of pairs) {
		parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"\r\n\r\n${value}\r\n`));
	}
	let total = 0;
	for (const [name, file] of Object.entries(files)) {
		const resolved = localPath(file);
		let size: number;
		try {
			const stat = statSync(resolved);
			if (!stat.isFile()) throw new Error("not a regular file");
			size = stat.size;
		} catch (error) {
			throw new Error(`files.${name}: ${resolved} cannot be read (${error instanceof Error ? error.message : String(error)})`);
		}
		total += size;
		if (total > MAX_UPLOAD_BYTES) throw new Error(`files: more than ${formatSize(MAX_UPLOAD_BYTES)} to upload`);
		const fileName = path.basename(resolved);
		const type = UPLOAD_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
		parts.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"; filename="${quoted(fileName)}"\r\nContent-Type: ${type}\r\n\r\n`,
			),
			readFileSync(resolved),
			Buffer.from("\r\n"),
		);
	}
	parts.push(Buffer.from(`--${boundary}--\r\n`));
	return { contentType: `multipart/form-data; boundary=${boundary}`, data: Buffer.concat(parts) };
}

/**
 * One HTTP request through node:http(s), as a Response. Not fetch: it adds Sec-Fetch-Mode: cors to every request, and
 * GitLab answers that with 406 on downloads such as repository archives.
 */
function request(
	url: URL,
	method: string,
	headers: Record<string, string>,
	body: string | Uint8Array | undefined,
	signal: AbortSignal,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const all = body === undefined ? headers : { ...headers, "Content-Length": String(Buffer.byteLength(body)) };
		const req = send(url, { method, headers: all, signal }, (res) => {
			const received = new Headers();
			for (const [name, value] of Object.entries(res.headers)) {
				for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) received.append(name, item);
			}
			const status = res.statusCode ?? 502;
			const empty = [204, 205, 304].includes(status) || method === "HEAD";
			if (empty) res.resume();
			const stream = empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
			resolve(new Response(stream, { status, statusText: res.statusMessage, headers: received }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

/** Sends the request; a GET follows redirects, carrying the token only within the instance. */
async function send(
	instance: Instance,
	token: string,
	method: string,
	url: URL,
	payload: Payload | undefined,
	signal: AbortSignal | undefined,
): Promise<{ response: Response; url: URL }> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let current = url;
	for (let hop = 0; ; hop++) {
		const headers: Record<string, string> = { Accept: ACCEPT, "User-Agent": USER_AGENT };
		if (current.origin === instance.origin) {
			// GraphQL takes the token as a bearer token; git.drupalcode.org ignores PRIVATE-TOKEN there and answers anonymously.
			if (current.pathname === instance.graphql) headers.Authorization = `Bearer ${token}`;
			else headers["PRIVATE-TOKEN"] = token;
		}
		if (payload !== undefined) headers["Content-Type"] = payload.contentType;
		let response: Response;
		try {
			response = await request(current, method, headers, payload?.data, abort);
		} catch (error) {
			if (abort.aborted) throw error;
			throw new Error(`${current.origin} is unreachable: ${error instanceof Error ? error.message : String(error)}`);
		}
		const location = response.headers.get("location");
		if (method === "GET" && location && response.status >= 300 && response.status < 400 && hop < MAX_REDIRECTS) {
			await response.body?.cancel().catch(() => {});
			current = new URL(location, current);
			continue;
		}
		return { response, url: current };
	}
}

async function readLimited(response: Response): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > MAX_DOWNLOAD_BYTES) {
			await reader.cancel().catch(() => {});
			throw new Error(`the response is larger than ${formatSize(MAX_DOWNLOAD_BYTES)}`);
		}
		chunks.push(value);
	}
	const data = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.length;
	}
	return data;
}

function tempFile(name: string, data: string | Uint8Array): string {
	const file = path.join(mkdtempSync(path.join(os.tmpdir(), "pi-gitlab-")), name);
	writeFileSync(file, data, { mode: 0o600 });
	return file;
}

function downloadName(response: Response, url: URL): string {
	const disposition = response.headers.get("content-disposition") ?? "";
	const encoded = disposition.match(/filename\*\s*=\s*[^']*''([^;]+)/i)?.[1];
	let name = disposition.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1] ?? url.pathname.split("/").pop() ?? "";
	if (encoded) {
		try {
			name = decodeURIComponent(encoded);
		} catch {
			// keep the plain filename
		}
	}
	return name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "download";
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replaces token fields and secret CI/CD variable values, in REST (snake_case) and GraphQL (camelCase) answers alike. */
function redact(value: Json): Json {
	if (Array.isArray(value)) return value.map(redact);
	if (!isObject(value)) return value;
	const variable = typeof (value.variable_type ?? value.variableType) === "string" && typeof value.key === "string";
	const secretVariable = variable && (value.masked === true || value.hidden === true || SECRET_KEY.test(value.key as string));
	const out: JsonObject = {};
	for (const [key, item] of Object.entries(value)) {
		const tokenField = TOKEN_FIELD.test(key) && typeof item === "string" && item !== "";
		out[key] = tokenField || (secretVariable && key === "value" && typeof item === "string") ? REDACTED : redact(item);
	}
	return out;
}

/** A nested user as "Name (@username, id N)", with its state when it is not active and a bot mark. */
function userText(value: JsonObject): string | undefined {
	if (typeof value.username !== "string" || typeof value.id !== "number") return undefined;
	if (!Object.keys(value).every((key) => USER_KEYS.has(key))) return undefined;
	const marks = [`@${value.username}`, `id ${value.id}`];
	if (typeof value.state === "string" && value.state !== "active") marks.push(value.state);
	if (value.bot === true) marks.push("bot");
	return typeof value.name === "string" && value.name ? `${value.name} (${marks.join(", ")})` : marks.join(", ");
}

/** Where an object sits: the response itself, an item of a top-level list, or anywhere else. */
type Place = "top" | "element" | "inner";

/** Folds a REST response into what the model needs; undefined means the value is left out. */
function fold(value: Json, place: Place): Json | undefined {
	if (value === null || value === "") return undefined;
	if (Array.isArray(value)) {
		const itemPlace = place === "top" ? "element" : "inner";
		const items = value.map((item) => fold(item, itemPlace)).filter((item): item is Json => item !== undefined);
		return items.length > 0 || place === "top" ? items : undefined;
	}
	if (!isObject(value)) return value;
	if (place !== "top") {
		const user = userText(value);
		if (user !== undefined) return user;
	}
	const out: JsonObject = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === "avatar_url" || (key === "_links" && place === "element")) continue;
		if (key === "description" && place === "element" && typeof item === "string" && item.length > LIST_DESCRIPTION_CHARS) {
			out[key] = `${item.slice(0, LIST_DESCRIPTION_CHARS)} … [${item.length - LIST_DESCRIPTION_CHARS} more characters]`;
			continue;
		}
		const folded = fold(item, "inner");
		if (folded !== undefined) out[key] = folded;
	}
	if (place === "inner" && Object.values(out).every((item) => item === 0)) return undefined;
	return out;
}

/**
 * The pagination headers as one line, with the href of the next page; undefined for an unpaginated response. The href
 * is a path, or with absolute the full URL, which leads back to its instance without host.
 */
function pagination(response: Response, absolute: boolean): string | undefined {
	const header = (name: string) => response.headers.get(name)?.trim() || undefined;
	const page = header("x-page");
	const pages = header("x-total-pages");
	const perPage = header("x-per-page");
	const total = header("x-total");
	const next = header("link")
		?.split(",")
		.map((part) => part.match(/<([^>]+)>\s*;\s*rel="?next"?/)?.[1])
		.find((href) => href !== undefined);
	if (!page && !next) return undefined;
	const parts: string[] = [];
	if (page) parts.push(pages ? `page ${page} of ${pages}` : `page ${page}`);
	if (perPage) parts.push(`${perPage} per page`);
	if (total) parts.push(`${total} in total`);
	let line = `Pagination: ${parts.join(", ") || "keyset"}`;
	if (next) {
		let href = next;
		try {
			const url = new URL(next);
			href = absolute ? url.href : url.pathname + url.search;
		} catch {
			// keep the header's value
		}
		line += `; next page: ${href}`;
	} else {
		line += "; last page";
	}
	return line;
}

/** The head lines and the body within the output limits; a cut body is saved whole, and keepEnd keeps its end. */
function limited(head: string, body: string, keepEnd: boolean): string {
	const text = body ? `${head}\n${body}` : head;
	const options = { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };
	const t = keepEnd ? truncateTail(body, options) : truncateHead(text, options);
	if (!t.truncated) return text;
	const file = tempFile(keepEnd ? "log.txt" : "response.txt", text);
	const size = `${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}`;
	return keepEnd
		? `${head}\n[Output truncated to the last ${t.outputLines} of ${t.totalLines} lines (${size}). Full response saved to: ${file}]\n\n${t.content}`
		: `${t.content}\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines (${size}). Full response saved to: ${file}]`;
}

const STATUS_HINTS: Record<number, string> = {
	401: "The token was rejected: it expired or was revoked.",
	403: "The token lacks the scope (api to write, read_api to read) or its user lacks the permission for this.",
	404: "Not found, or not visible to the token's user. A project, group, or file path in a URL must be URL-encoded (group%2Fproject); issues and merge requests are addressed by their iid.",
	409: "Conflict: the resource exists already or changed in the meantime.",
	422: "The request was not accepted; the body names the offending fields.",
	429: "Rate limited: wait before the next request.",
};

const BaseParams = {
	method: Type.Optional(StringEnum(["GET", "POST", "PUT", "DELETE"] as const, { description: "HTTP method; default GET" })),
	path: Type.String({
		description:
			"Path below /api/v4, e.g. /projects/42/issues/7, an href from an earlier response, or /api/graphql; may carry a query string",
	}),
	query: Type.Optional(
		Type.Object({}, {
			additionalProperties: true,
			description: "Query parameters; arrays are sent as key[]=…, objects as key[sub]=…",
		}),
	),
	body: Type.Optional(
		Type.Object({}, {
			additionalProperties: true,
			description: "JSON body for POST and PUT; for /api/graphql {\"query\": \"…\", \"variables\": {…}}; with files, its fields go as form fields",
		}),
	),
	files: Type.Optional(
		Type.Object({}, {
			additionalProperties: Type.String(),
			description:
				"Local files to upload with POST or PUT as multipart/form-data, form field name → path, e.g. {\"avatar\": \"~/logo.png\"} for PUT /projects/{id} or {\"file\": \"./diagram.png\"} for POST /projects/{id}/uploads",
		}),
	),
	raw: Type.Optional(
		Type.Boolean({ description: "Return REST JSON unfolded and job logs with colour codes; secrets stay masked; default false" }),
	),
};

/** The parameters; host only with several instances, as one of their names. */
function parameters(instances: Instance[]) {
	const all = Type.Object({ host: Type.Optional(hostParameter(instances, "GitLab")), ...BaseParams });
	return instances.length > 1 ? all : (Type.Object(BaseParams) as unknown as typeof all);
}

/**
 * The instances of a tool's config file and their tokens, shared by gitlab.ts (gitlab.json) and openproject.ts
 * (openproject.json).
 *
 * - The file holds {"instances": {"https://…": {"token": "…"}, …}}, a map from each instance's URL to its settings,
 *   like mcpServers in Pi's mcp.json; the first instance is the default. Older forms are read as well: a list
 *   [{"url": …, "token": …}, …] and a single {"url": …, "token": …}.
 * - token follows Pi's apiKey convention in models.json: a literal token, "$NAME" or "${NAME}" for an environment
 *   variable, or "!command" for the output of a shell command (a password manager); "$$" and "$!" are a literal $ and
 *   !. "tokenEnv": "NAME" is short for "token": "$NAME"; without either, the tool's default variable holds the token.
 * - Environment variables are read at every call. A command runs in Pi's shell (/bin/sh, Git Bash on Windows) at the
 *   first call and its token is kept for the session, until the instance rejects it (forgetToken).
 * - A literal token in a config file that others can read draws a warning.
 * - An instance is named by its host plus the path it is served under (git.example.com, example.com/gitlab): the
 *   value of the tools' host parameter.
 *
 * openproject.ts carries a copy of this block, or of a part of it: change them alike.
 */
/** A token command may wait this long for a password manager to be unlocked. */
const TOKEN_COMMAND_TIMEOUT_MS = 30_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type TokenPart = { type: "literal"; value: string } | { type: "env"; name: string };

/** Where a token comes from: the output of a shell command, or literal text and environment variables. */
type TokenSource = { type: "command"; command: string } | { type: "template"; parts: TokenPart[] };

interface ConfiguredInstance {
	/** The host plus the path the application is served under, e.g. git.example.com or example.com/gitlab. */
	name: string;
	origin: string;
	/** Origin plus the path the application is served under, without a trailing slash. */
	base: string;
	/** The path the application is served under, without a trailing slash; empty at the root. */
	basePath: string;
	token: TokenSource;
}

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

const FORMAT = '{"instances": {"https://…": {"token": "…"}, …}}';

/** One instance: its URL and its settings; where names it in errors (the URL, [1]), empty for a single instance. */
function parseInstance(address: unknown, entry: Record<string, unknown>, where: string, defaultTokenEnv: string): ConfiguredInstance {
	const prefix = where ? `${where}: ` : "";
	if (typeof address !== "string" || !address) throw new Error(`${prefix}expected the URL of the instance`);
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
		url = new URL(address);
	} catch {
		throw new Error(`${prefix}${address} is not a URL`);
	}
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`${prefix}the url must use https`);
	const basePath = url.pathname.replace(/\/+$/, "");
	return { name: url.host + basePath, origin: url.origin, base: url.origin + basePath, basePath, token };
}

/** The instances of a parsed config file in the order they are written: the map, or one of the older forms. */
function parseConfig(config: unknown, defaultTokenEnv: string): ConfiguredInstance[] {
	if (isObject(config) && config.instances !== undefined) {
		if (!isObject(config.instances)) throw new Error(`instances must be a map from URL to settings: ${FORMAT}`);
		const entries = Object.entries(config.instances);
		if (entries.length === 0) throw new Error("instances is empty");
		return entries.map(([address, entry]) => {
			if (!isObject(entry)) throw new Error(`${address}: expected the settings of the instance, {"token": "…"}`);
			if (entry.url !== undefined) throw new Error(`${address}: the URL is the key; leave url out`);
			return parseInstance(address, entry, address, defaultTokenEnv);
		});
	}
	if (Array.isArray(config)) {
		if (config.length === 0) throw new Error("the list of instances is empty");
		return config.map((entry, index) => {
			if (!isObject(entry)) throw new Error(`[${index}]: expected {"url": "https://…", "token": "…"}`);
			return parseInstance(entry.url, entry, `[${index}]`, defaultTokenEnv);
		});
	}
	if (isObject(config) && config.url !== undefined) return [parseInstance(config.url, config, "", defaultTokenEnv)];
	throw new Error(`expected ${FORMAT}`);
}

/**
 * The instances of a config file, the default first, each with the paths extend adds, and a warning about the file;
 * undefined without the file.
 */
function loadInstances<Paths extends object>(
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
		const instances = parseConfig(JSON.parse(text) as unknown, defaultTokenEnv);
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
function hostParameter(instances: ConfiguredInstance[], product: string) {
	return StringEnum(
		instances.map((instance) => instance.name),
		{ description: `The ${product} instance; default ${instances[0].name}. A full URL in path picks its instance by itself` },
	);
}

/**
 * The instance of a call: the one host names, else the one a full URL in path belongs to (owns says which), else the
 * default.
 */
function pickInstance<T extends ConfiguredInstance>(
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

/**
 * Runs a token command in the shell Pi runs apiKey commands in, /bin/sh, on Windows the bash of getShellConfig()
 * (Git Bash), and returns its trimmed output.
 */
function runTokenCommand(command: string, what: string, signal: AbortSignal | undefined): Promise<string> {
	return new Promise((resolve, reject) => {
		const fail = (why: string) => reject(new Error(`The token command of ${what} ${why}.`));
		let file = "/bin/sh";
		let args = ["-c", command];
		let viaStdin = false;
		if (process.platform === "win32") {
			try {
				const shell = getShellConfig();
				viaStdin = shell.commandTransport === "stdin";
				file = shell.shell;
				args = viaStdin ? shell.args : [...shell.args, command];
			} catch (error) {
				fail(`cannot run (${error instanceof Error ? error.message : String(error)})`);
				return;
			}
		}
		const child = spawn(file, args, {
			stdio: [viaStdin ? "pipe" : "ignore", "pipe", "ignore"],
			timeout: TOKEN_COMMAND_TIMEOUT_MS,
			signal,
			windowsHide: true,
		});
		if (viaStdin) child.stdin?.end(command);
		const chunks: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
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
async function resolveToken(
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
function forgetToken(instance: ConfiguredInstance): boolean {
	if (instance.token.type !== "command") return false;
	commandTokens.delete(instance.token.command);
	return true;
}

export default function (pi: ExtensionAPI) {
	const loaded = loadInstances(CONFIG_FILE, DEFAULT_TOKEN_ENV, (basePath) => ({
		api: `${basePath}/api/v4`,
		graphql: `${basePath}/api/graphql`,
	}));
	if (loaded instanceof Error) {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(`gitlab: ${loaded.message}`, "error");
		});
		return;
	}
	if (!loaded) return;
	const { instances, warning } = loaded;
	if (warning) {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(`gitlab: ${warning}`, "warning");
		});
	}
	const several = instances.length > 1;
	const names = instances.map((instance) => instance.name);
	const others = names.slice(1).join(", ");

	pi.registerTool({
		name: "gitlab",
		label: "GitLab",
		description:
			(several
				? `Call the GitLab REST API v4 or the GraphQL API of ${instances.map((instance) => instance.base).join(" or ")} ` +
					`as the owner of that instance's access token. host picks the instance (default ${names[0]}), and a full ` +
					"URL in path picks its own; ids, iids, and paths belong to one instance. "
				: `Call the GitLab REST API v4 or the GraphQL API of ${instances[0].base} as the owner of the access token. `) +
			"GET reads, POST creates, PUT updates, DELETE removes. A project or group is named by its id or its URL-encoded " +
			"full path (/projects/group%2Fsubgroup%2Fproject), an issue or merge request by its iid within the project. " +
			"Common paths: /projects (query: membership, search, simple=true), /projects/{id}, /projects/{id}/issues " +
			"(query: state, labels, assignee_username, search), /projects/{id}/issues/{iid}, /projects/{id}/issues/{iid}/" +
			"notes (POST {\"body\": \"…\"} adds a comment), /projects/{id}/merge_requests/{iid} (/diffs, /notes, " +
			"/approvals, /pipelines), /projects/{id}/pipelines, /projects/{id}/pipelines/{id}/jobs, /projects/{id}/jobs/" +
			"{job_id}/trace (the job log), /projects/{id}/repository/tree, /projects/{id}/repository/files/{URL-encoded " +
			"file path}/raw?ref=…, /projects/{id}/repository/branches, /projects/{id}/repository/compare, /groups/{id}/" +
			"issues, /search, /user. Lists take per_page (up to 100) and page; a line above the body gives the page, " +
			"the total, and the href of the next page. /api/graphql takes POST {\"query\": …, \"variables\": …}, for what " +
			"REST lacks, such as setting an issue's iteration (issueSetIteration). REST JSON is folded: empty fields, " +
			"avatar URLs, and the _links of list items are left out, a user inside another resource or a list reads " +
			"\"Name (@username, id N)\", and a description in a list is cut; raw: true returns it unfolded. Tokens and " +
			"secret CI/CD variable values are always masked. File contents come as they are, job logs without colour " +
			"codes; binary content such as artifacts is saved to a temp file. files uploads local files as multipart/form-data, " +
			"e.g. a project avatar (PUT /projects/{id}, files {\"avatar\": path}) or an image for markdown (POST " +
			"/projects/{id}/uploads, files {\"file\": path}). Output over " +
			`${formatSize(DEFAULT_MAX_BYTES)} is truncated (a job log keeps its end) and the full response saved to a ` +
			"temp file.",
		promptSnippet:
			"Read and change GitLab issues, merge requests, pipelines, jobs, and repositories (REST v4, GraphQL)" +
			(several ? ` on ${names.join(", ")}` : ""),
		promptGuidelines: [
			"Use gitlab for the GitLab API (issues, merge requests, pipelines, job logs, repository files, projects, groups) instead of curl; it adds the access token itself. Git operations such as clone, fetch, and push stay with git.",
			...(several
				? [
						`gitlab: set host for every call to ${others}; without it, a call goes to ${names[0]}. Ids, iids, and paths of one instance mean nothing on another.`,
					]
				: []),
			"gitlab: name a project or group by its id or its URL-encoded full path (group%2Fproject), and an issue or merge request by its iid within the project.",
			"gitlab: list projects with simple=true unless their settings matter; a full project list exceeds the output limit after about twenty projects.",
			"gitlab: a description in a list is cut; GET the single issue or merge request before quoting or changing its description.",
			"gitlab: send POST, PUT, or DELETE only for changes the user asked for.",
			"gitlab: upload a local file with files, e.g. a project avatar as PUT /projects/{id} with files {\"avatar\": \"/path/logo.png\"}; upload only files the user named for that purpose.",
		],
		parameters: parameters(instances),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },

		async execute(_id, params, signal) {
			const instance = pickInstance(instances, params.host as string | undefined, params.path, owns, CONFIG_FILE);
			const method = (params.method ?? "GET") as "GET" | "POST" | "PUT" | "DELETE";
			if (params.body !== undefined && (method === "GET" || method === "DELETE")) {
				throw new Error(`a ${method} request takes no body; send its parameters as query`);
			}
			const files = params.files as Record<string, string> | undefined;
			if (files !== undefined && method !== "POST" && method !== "PUT") throw new Error("files are uploaded with POST or PUT");
			const target = requestUrl(instance, params.path, params.query as Record<string, unknown> | undefined);
			if (files !== undefined && target.pathname === instance.graphql) throw new Error("files cannot go to /api/graphql");
			const payload: Payload | undefined =
				files !== undefined && Object.keys(files).length > 0
					? multipart(params.body as Record<string, unknown> | undefined, files)
					: params.body !== undefined
						? { contentType: "application/json", data: JSON.stringify(params.body) }
						: undefined;
			const token = await resolveToken(
				instance,
				CONFIG_FILE,
				`Create a personal access token in ${instance.base} under User settings → Personal access tokens (scope api, or read_api to read only)`,
				signal,
			);
			const { response, url } = await send(instance, token, method, target, payload, signal);
			const mask = (text: string) => text.split(token).join(REDACTED);
			const rerun = response.status === 401 && forgetToken(instance);

			const graphql = target.pathname === instance.graphql;
			const content = !graphql && CONTENT_PATH.test(target.pathname);
			const log = /\/jobs\/\d+\/trace$/.test(target.pathname);
			const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
			let hint = STATUS_HINTS[response.status];
			const retryAfter = response.headers.get("retry-after");
			if (response.status === 429 && retryAfter) hint += ` Retry after ${retryAfter} seconds.`;
			if (rerun) hint += " Its token command runs again at the next call.";
			const page = pagination(response, instance !== instances[0]);
			const head = [status, hint, page].filter(Boolean).join("\n");
			const details = {
				host: instance.name,
				method,
				path: target.pathname + target.search,
				status: response.status,
				file: undefined as string | undefined,
			};
			let isError = response.status >= 400;
			const contentType = response.headers.get("content-type") ?? "";

			let body: string;
			if (/json/i.test(contentType) && !content) {
				const received = await response.text();
				let parsed: Json | undefined;
				try {
					parsed = redact(JSON.parse(received) as Json);
				} catch {
					parsed = undefined;
				}
				if (graphql && isObject(parsed) && Array.isArray(parsed.errors) && parsed.errors.length > 0) isError = true;
				body =
					parsed === undefined
						? received
						: JSON.stringify(params.raw || graphql ? parsed : (fold(parsed, "top") ?? null), null, 1);
			} else if (isError || !contentType || /^text\/|json|xml|csv|yaml|markdown|javascript/i.test(contentType)) {
				body = (await response.text()).trimEnd();
				if (log && !params.raw) body = body.replace(ANSI_ESCAPE, "");
			} else {
				const data = await readLimited(response);
				details.file = tempFile(downloadName(response, url), data);
				body = `${contentType.split(";")[0]}, ${formatSize(data.length)}, saved to: ${details.file}`;
			}
			const keepEnd = log && !isError;
			return { content: [{ type: "text", text: limited(mask(head), mask(body), keepEnd) }], details, isError };
		},

		renderCall(args, theme) {
			const host = args.host as string | undefined;
			return new Text(
				theme.fg("toolTitle", theme.bold("gitlab ")) +
					(host ? theme.fg("muted", `${host} `) : "") +
					theme.fg("muted", `${args.method ?? "GET"} `) +
					theme.fg("accent", args.path ?? ""),
				0,
				0,
			);
		},
	});
}
