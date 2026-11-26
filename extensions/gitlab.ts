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
 *   content (artifacts, archives) is saved to a temp file, removed when the session ends. A cut job log keeps its end.
 * - files uploads local files as multipart/form-data (a project avatar, a markdown upload); the fields of body go
 *   along as form fields. Files go, like the token, only to the instance of the call.
 * - fieldFiles sets body fields from local files, field name → path: the content of each file (up to 64 KB, UTF-8, one
 *   trailing newline stripped) becomes the string value of that field, so a secret, such as the value of a CI/CD
 *   variable, never appears in the call, the result, or the transcript. Every such value is masked in the result,
 *   whatever the field or the status, and only the paths are shown of the call.
 * - Requests go through the proxy Pi uses for its own HTTP (its httpProxy setting, applied as HTTPS_PROXY and
 *   HTTP_PROXY, and NO_PROXY): https through a CONNECT tunnel, as curl and undici do.
 * - path also takes a web URL of an instance (a project, merge request, issue, pipeline, job, commit, file, or tree
 *   page), read as its API path (webApiPath). overview: true with a GET of one merge request returns, in one result, the
 *   merge request, its approvals, latest pipelines, open discussions, and changed files without diffs (mrOverview).
 * - A second tool, gitlab_pipeline, shows, waits for, and drives CI pipelines and jobs in a few lines, a rollout's jobs
 *   and the checks of its site in one call (chain), with the same instances, tokens, and rules; "pipelines": false in
 *   gitlab.json leaves it out. Its section below says more.
 * - A third tool, gitlab_work, does in one call what takes several gitlab calls otherwise: issue templates, creating,
 *   updating, and reading issues (their iteration set with GraphQL), creating and merging merge requests, and what is
 *   deployed where, with the same instances, tokens, and rules; "work": false in gitlab.json leaves it out. Its section
 *   below says more.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type ClientRequest, type IncomingMessage, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import os from "node:os";
import path from "node:path";
import { type Duplex, Readable } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	getAgentDir,
	getMarkdownTheme,
	getShellConfig,
	type Theme,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, MouseRegion, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";

const CONFIG_FILE = path.join(getAgentDir(), "gitlab.json");
const DEFAULT_TOKEN_ENV = "GITLAB_TOKEN";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** A file named by fieldFiles is a value, not an upload: this large at most. */
const MAX_FIELD_FILE_BYTES = 64 * 1024;
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

/**
 * Whether a path names the GraphQL endpoint the way a REST path would, as /graphql or /api/v<n>/graphql of any version,
 * with or without the base path. GitLab has no REST route of that name, so it can only mean the GraphQL endpoint.
 */
function graphqlAlias(instance: Instance, pathname: string): boolean {
	const base = instance.graphql.slice(0, -"/api/graphql".length);
	return /^(\/api\/v\d+)?\/graphql$/.test(base && within(pathname, base) ? pathname.slice(base.length) : pathname);
}

/** Whether a URL lies in the REST or GraphQL API of an instance. */
const owns = (instance: Instance, url: URL) =>
	within(url.pathname, instance.api) || url.pathname === instance.graphql || graphqlAlias(instance, url.pathname);

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
		if (url.origin === instance.origin && graphqlAlias(instance, url.pathname)) url.pathname = instance.graphql;
	} else {
		let p = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
		const pathname = p.replace(/[?#].*$/, "");
		if (graphqlAlias(instance, pathname)) {
			p = instance.graphql + p.slice(pathname.length);
		} else if (!within(pathname, instance.api) && pathname !== instance.graphql) {
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

/**
 * The project's full path and the page below it (what follows /-/, e.g. merge_requests/12/diffs) of a web URL of an
 * instance, both without slashes at their ends and decoded, the project without .git.
 */
function webPage(instance: Instance, url: URL): { project: string; page: string } {
	const rest = decodeURIComponent(url.pathname.slice(instance.basePath.length)).replace(/^\/+|\/+$/g, "");
	// Where /-/ starts in /rest/, one ahead of rest: a page of the instance itself (/-/profile) has no project.
	const cut = `/${rest}/`.indexOf("/-/");
	const project = (cut < 0 ? rest : rest.slice(0, Math.max(0, cut - 1))).replace(/\.git$/, "");
	return { project, page: cut < 0 ? "" : rest.slice(cut + 2).replace(/^\/+/, "") };
}

/** The web pages webApiPath translates, for its error. */
const WEB_FORMS =
	"the project (https://host/group/project) and below it /-/merge_requests/<iid>, /-/issues/<iid>, " +
	"/-/work_items/<iid>, /-/pipelines/<id>, /-/jobs/<id>, /-/commit/<sha>, /-/blob/<ref>/<file>, /-/raw/<ref>/<file>, " +
	"and /-/tree/<ref>[/<directory>]";

/**
 * The instance and the API path of a web URL of a configured instance, for path of the gitlab tool: a project, a merge
 * request, an issue or work item, a pipeline, a job, a commit, a file (blob, raw), or a tree; what follows the number
 * (/diffs), the query, and the fragment are dropped. undefined for anything else: a path, an API URL, a URL of another
 * host. A web URL of an instance that names no such page throws with the forms known. The ref of blob, raw, and tree
 * is the segment after them: a ref with a slash in it (feature/x) is cut there, and the rest goes to the file path.
 */
function webApiPath(instances: Instance[], target: string): { instance: Instance; path: string } | undefined {
	const trimmed = target.trim();
	if (!/^https?:\/\//i.test(trimmed)) return undefined;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return undefined;
	}
	const instance = instances.find((candidate) => url.origin === candidate.origin && within(url.pathname, candidate.basePath));
	if (!instance || owns(instance, url)) return undefined;
	const unsupported = () =>
		new Error(
			`${trimmed} is a web page of ${instance.name} without an API path known here; give an API path, or one of ` +
				`the web URLs ${WEB_FORMS}`,
		);
	const { project, page } = webPage(instance, url);
	// A project lies in a group or a user's namespace: one segment alone is a group, a user, or a page of the instance.
	if (!project.includes("/")) throw unsupported();
	const P = `/projects/${encodeURIComponent(project)}`;
	if (!page) return { instance, path: P };
	const [kind, first = "", ...rest] = page.split("/");
	const file = rest.join("/");
	const ref = encodeURIComponent(first);
	if (/^\d+$/.test(first)) {
		if (kind === "merge_requests" || kind === "issues" || kind === "pipelines" || kind === "jobs") {
			return { instance, path: `${P}/${kind}/${first}` };
		}
		if (kind === "work_items") return { instance, path: `${P}/issues/${first}` };
	}
	if (kind === "commit" && /^[0-9a-f]{7,64}$/i.test(first)) return { instance, path: `${P}/repository/commits/${first}` };
	if ((kind === "blob" || kind === "raw") && first && file) {
		return { instance, path: `${P}/repository/files/${encodeURIComponent(file)}/raw?ref=${ref}` };
	}
	if (kind === "tree" && first) {
		return { instance, path: `${P}/repository/tree?ref=${ref}${file ? `&path=${encodeURIComponent(file)}` : ""}` };
	}
	throw unsupported();
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
 * The values of body fields read from local files (field name → path): a regular UTF-8 file of up to 64 KB, minus one
 * trailing newline. A message names the path and the reason, never the content.
 */
function readFieldFiles(fieldFiles: Record<string, string>): Record<string, string> {
	const values: Record<string, string> = {};
	for (const [name, file] of Object.entries(fieldFiles)) {
		if (name === "") throw new Error("fieldFiles: a field name is empty");
		if (typeof file !== "string") throw new Error(`fieldFiles.${name}: the path is not a string`);
		const resolved = localPath(file);
		let data: Buffer;
		try {
			const stat = statSync(resolved);
			if (!stat.isFile()) throw new Error("not a regular file");
			if (stat.size > MAX_FIELD_FILE_BYTES) throw new Error(`larger than ${formatSize(MAX_FIELD_FILE_BYTES)}`);
			data = readFileSync(resolved);
			if (data.length > MAX_FIELD_FILE_BYTES) throw new Error(`larger than ${formatSize(MAX_FIELD_FILE_BYTES)}`);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			throw new Error(`fieldFiles.${name}: ${resolved} cannot be read (${code ?? (error instanceof Error ? error.message : "error")})`);
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(data);
		} catch {
			throw new Error(`fieldFiles.${name}: ${resolved} is not UTF-8 text`);
		}
		values[name] = text.replace(/\r?\n$/, "");
	}
	return values;
}

/** Masks the values in a text, as they stand and as JSON writes them, the longest first so none is left in part. */
function masker(values: string[]): (text: string) => string {
	const forms = new Set<string>();
	for (const value of values) {
		if (value === "") continue;
		forms.add(value);
		forms.add(JSON.stringify(value).slice(1, -1));
	}
	const sorted = [...forms].sort((a, b) => b.length - a.length);
	return (text) => sorted.reduce((rest, form) => rest.split(form).join(REDACTED), text);
}

/**
 * The proxy for a URL as undici's EnvHttpProxyAgent picks it, which Pi installs for fetch: https_proxy or HTTPS_PROXY
 * (else the http proxy) for https, http_proxy or HTTP_PROXY for http, none when no_proxy or NO_PROXY names the host
 * (a host, a domain with or without a leading dot or *., host:port, or *).
 */
function proxyFor(url: URL): URL | undefined {
	const env = (name: string) => process.env[name.toLowerCase()] || process.env[name] || undefined;
	const raw = url.protocol === "https:" ? (env("HTTPS_PROXY") ?? env("HTTP_PROXY")) : env("HTTP_PROXY");
	if (!raw) return undefined;
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	for (const entry of (env("NO_PROXY") ?? "").split(/[\s,]+/)) {
		if (!entry) continue;
		if (entry === "*") return undefined;
		const [name, onlyPort] = entry.toLowerCase().replace(/^\*?\./, ".").split(/:(?=\d+$)/);
		if (onlyPort && onlyPort !== port) continue;
		const domain = name.replace(/^\./, "");
		if (host === domain || host.endsWith(`.${domain}`)) return undefined;
	}
	try {
		return new URL(raw.includes("://") ? raw : `http://${raw}`);
	} catch {
		return undefined;
	}
}

/** The Proxy-Authorization header for a proxy URL with a user. */
function proxyAuthorization(proxy: URL): Record<string, string> {
	if (!proxy.username) return {};
	const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
	return { "Proxy-Authorization": `Basic ${Buffer.from(credentials).toString("base64")}` };
}

/** An https.Agent that reaches the host through a CONNECT tunnel of the proxy, then speaks TLS to the host itself. */
class TunnelAgent extends HttpsAgent {
	constructor(private readonly proxy: URL) {
		super({ keepAlive: false });
	}

	// http.Agent takes the socket through the callback when createConnection returns nothing.
	override createConnection(options: any, callback: any): any {
		const target = `${options.host}:${options.port}`;
		const tunnel: ClientRequest = (this.proxy.protocol === "https:" ? httpsRequest : httpRequest)({
			hostname: this.proxy.hostname,
			port: this.proxy.port || (this.proxy.protocol === "https:" ? 443 : 80),
			method: "CONNECT",
			path: target,
			headers: { Host: target, ...proxyAuthorization(this.proxy) },
		});
		tunnel.once("connect", (res: IncomingMessage, socket: Duplex) => {
			if (res.statusCode !== 200) {
				socket.destroy();
				callback(new Error(`the proxy ${this.proxy.host} answered CONNECT ${target} with ${res.statusCode}`));
				return;
			}
			callback(null, tlsConnect({ socket, servername: options.servername || options.host }));
		});
		tunnel.once("error", (error: Error) => callback(new Error(`the proxy ${this.proxy.host} is unreachable: ${error.message}`)));
		tunnel.end();
		return undefined;
	}
}

/**
 * One HTTP request through node:http(s), as a Response, through the proxy proxyFor names. Not fetch: it adds
 * Sec-Fetch-Mode: cors to every request, and GitLab answers that with 406 on downloads such as repository archives.
 */
/** Node's codes for a certificate chain that does not end in a CA it trusts. */
const UNKNOWN_CA_CODES = new Set([
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"CERT_UNTRUSTED",
]);

/** Node's codes for a certificate it refuses for other reasons: run out, not yet valid, or for another host. */
const BAD_CERTIFICATE_CODES = new Set([
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
	"CERT_REVOKED",
	"CERT_SIGNATURE_FAILURE",
	"ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Why a request failed when the server's certificate could not be verified, else undefined: the error or one of its
 * causes carries Node's code. A chain that ends in a CA Node does not know (a company proxy's) gets the remedy, as
 * Node reads NODE_EXTRA_CA_CERTS only at start.
 * gitlab.ts and openproject.ts carry a copy of this block: change them alike.
 */
function certificateProblem(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; current instanceof Error && depth < 4; depth++, current = current.cause) {
		const code = (current as { code?: unknown }).code;
		if (typeof code !== "string") continue;
		if (UNKNOWN_CA_CODES.has(code)) {
			return (
				`its certificate cannot be verified (${current.message}); if a CA Node does not know signed it (a company ` +
				"proxy's), set NODE_EXTRA_CA_CERTS to a PEM file that holds it and restart Pi"
			);
		}
		if (BAD_CERTIFICATE_CODES.has(code)) return `its certificate is not valid (${current.message})`;
	}
	return undefined;
}

function request(
	url: URL,
	method: string,
	headers: Record<string, string>,
	body: string | Uint8Array | undefined,
	signal: AbortSignal,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const all = body === undefined ? headers : { ...headers, "Content-Length": String(Buffer.byteLength(body)) };
		const proxy = proxyFor(url);
		const onResponse = (res: IncomingMessage) => {
			const received = new Headers();
			for (const [name, value] of Object.entries(res.headers)) {
				for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) received.append(name, item);
			}
			const status = res.statusCode ?? 502;
			const empty = [204, 205, 304].includes(status) || method === "HEAD";
			if (empty) res.resume();
			const stream = empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
			resolve(new Response(stream, { status, statusText: res.statusMessage, headers: received }));
		};
		let req: ClientRequest;
		if (proxy && url.protocol === "http:") {
			// A plain-http request goes to the proxy whole, with the full URL as its path.
			req = (proxy.protocol === "https:" ? httpsRequest : httpRequest)(
				{
					hostname: proxy.hostname,
					port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
					path: url.href,
					method,
					headers: { ...all, Host: url.host, ...proxyAuthorization(proxy) },
					signal,
				},
				onResponse,
			);
		} else {
			const send = url.protocol === "https:" ? httpsRequest : httpRequest;
			req = send(url, { method, headers: all, signal, ...(proxy ? { agent: new TunnelAgent(proxy) } : {}) }, onResponse);
		}
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
			// Several addresses that all failed (IPv4 and IPv6) come as an AggregateError without a message of its own
			const plain = error instanceof Error ? error.message || String((error as { code?: unknown }).code ?? error.name) : String(error);
			const reason = certificateProblem(error) ?? plain;
			throw new Error(`${current.origin} is unreachable: ${reason}`);
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

/** The temp dirs of this session's downloads and long responses, removed when the session ends. */
const tempDirs = new Set<string>();

function tempFile(name: string, data: string | Uint8Array): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-gitlab-"));
	tempDirs.add(dir);
	const file = path.join(dir, name);
	writeFileSync(file, data, { mode: 0o600 });
	return file;
}

function removeTempDirs(): void {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.clear();
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

/** A text cut to max characters, with the number of those left out. */
function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)} … [${text.length - max} more characters]` : text;
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
			out[key] = cut(item, LIST_DESCRIPTION_CHARS);
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
			"Path below /api/v4, e.g. /projects/42/issues/7, an href from an earlier response, /api/graphql, the endpoint of the GraphQL API, or a web URL of the instance (a project, merge request, issue, pipeline, job, commit, file, or tree page), read as its API path; may carry a query string",
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
	fieldFiles: Type.Optional(
		Type.Object({}, {
			additionalProperties: Type.String(),
			description:
				"Body fields taken from local files with POST or PUT, field name → path (a 0600 temp file), e.g. {\"value\": \"/tmp/secret.txt\"} for POST /projects/{id}/variables. The file's text (UTF-8, up to 64 KB, one trailing newline stripped) becomes the string value of that field and wins over the same field in body. The value never shows in the call or the result: it is masked in the response. Use it for secrets",
		}),
	),
	raw: Type.Optional(
		Type.Boolean({ description: "Return REST JSON unfolded and job logs with colour codes; secrets stay masked; default false" }),
	),
	overview: Type.Optional(
		Type.Boolean({
			description:
				"Only with a GET of one merge request (/projects/{id}/merge_requests/{iid} or its web URL): the merge request together with its approvals, latest pipelines, open discussions (unresolved threads and comments, bodies cut), and changed files (paths only, no diff), in one result; default false",
		}),
	),
};

/** A merge request's own path below the REST API. */
const MR_PATH = /^\/projects\/[^/]+\/merge_requests\/\d+$/;
/** The overview of a merge request cuts the body of a note to this many characters. */
const OVERVIEW_NOTE_CHARS = 500;
const OVERVIEW_PIPELINES = 20;
/** The overview reads the first page of discussions and changed files, this many to a page. */
const OVERVIEW_PER_PAGE = 100;
/** The fields of a merge request's approvals the overview shows. */
const OVERVIEW_APPROVAL_KEYS = [
	"approved",
	"approvals_required",
	"approvals_left",
	"approved_by",
	"approval_rules_left",
	"user_has_approved",
	"user_can_approve",
];

/** A part of the overview: its JSON, redacted, and its pagination line. */
interface OverviewPart {
	json: Json;
	page?: string;
	status: string;
}

/** A diff position as file:line, the new side first; the file alone without a line. */
function positionText(position: JsonObject): string | undefined {
	const file = ciText(position.new_path) || ciText(position.old_path);
	const line = ciText(position.new_line) || ciText(position.old_line);
	return file ? (line ? `${file}:${line}` : file) : undefined;
}

/**
 * The overview of a merge request (overview: true), its parts fetched in parallel: the merge request, folded unless
 * raw; its approvals; its latest pipelines; its open discussions, that is the threads that are not resolved, without
 * system notes; and its changed files without the diffs. A part that fails shows its error in its section; the merge
 * request itself failing fails the call.
 */
async function mrOverview(
	instance: Instance,
	token: string,
	target: URL,
	raw: boolean,
	absolute: boolean,
	signal: AbortSignal | undefined,
): Promise<{ head: string; body: string }> {
	const part = async (suffix: string, query?: Record<string, unknown>): Promise<OverviewPart> => {
		const url = suffix ? requestUrl(instance, target.pathname + suffix, query) : target;
		const { response } = await send(instance, token, "GET", url, undefined, signal);
		const text = new TextDecoder().decode(await readLimited(response));
		let json: Json | undefined;
		try {
			json = redact(JSON.parse(text) as Json);
		} catch {
			// not JSON: an error page, reported below
		}
		const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
		if (response.status >= 400 || json === undefined) {
			const rerun = response.status === 401 && forgetToken(instance);
			const message = isObject(json) ? ciMessage(json.message ?? json.error ?? json) : text;
			const hint = [STATUS_HINTS[response.status], rerun ? "Its token command runs again at the next call." : ""];
			const what = `GET ${url.pathname}: ${status}`;
			throw new Error([what, ciOneLine(message, 300), ...hint].filter(Boolean).join(" — "));
		}
		return { json, page: pagination(response, absolute), status };
	};
	const [mr, approvals, pipelines, discussions, diffs] = await Promise.allSettled([
		part(""),
		part("/approvals"),
		part("/pipelines", { per_page: OVERVIEW_PIPELINES }),
		part("/discussions", { per_page: OVERVIEW_PER_PAGE }),
		part("/diffs", { per_page: OVERVIEW_PER_PAGE }),
	]);
	signal?.throwIfAborted();
	if (mr.status === "rejected") throw mr.reason;

	const list = (json: Json) => (Array.isArray(json) ? json.filter(isObject) : []);
	const sections = [`Merge request\n${JSON.stringify(raw ? mr.value.json : (fold(mr.value.json, "top") ?? null), null, 1)}`];
	const add = (
		title: string,
		result: PromiseSettledResult<OverviewPart>,
		render: (json: Json) => { title?: string; value: Json | undefined },
	) => {
		if (result.status === "rejected") {
			const reason: unknown = result.reason;
			sections.push(`${title}\nError: ${reason instanceof Error ? reason.message : String(reason)}`);
			return;
		}
		const shown = render(result.value.json);
		// Only a part with more pages names its pagination: the first is all the overview shows.
		const page = result.value.page?.includes("; next page: ") ? result.value.page : undefined;
		const lines = [shown.title ?? title, page, JSON.stringify(shown.value ?? null, null, 1)];
		sections.push(lines.filter(Boolean).join("\n"));
	};
	add("Approvals", approvals, (json) => {
		if (!isObject(json)) return { value: json };
		const picked: JsonObject = {};
		for (const key of OVERVIEW_APPROVAL_KEYS) if (json[key] !== undefined) picked[key] = json[key];
		// approved_by holds {user: {…}} each: the user alone, which fold turns into its line.
		if (Array.isArray(json.approved_by)) {
			picked.approved_by = json.approved_by.map((item) => (isObject(item) && isObject(item.user) ? item.user : item));
		}
		return { value: fold(picked, "top") };
	});
	add("Pipelines", pipelines, (json) => ({
		value: fold(
			list(json).map((pipeline) => ({
				id: pipeline.id ?? null,
				status: pipeline.status ?? null,
				ref: pipeline.ref ?? null,
				sha: ciText(pipeline.sha).slice(0, 8),
				created_at: pipeline.created_at ?? null,
				web_url: pipeline.web_url ?? null,
			})),
			"top",
		),
	}));
	add("Discussions", discussions, (json) => {
		const threads = list(json);
		const open = threads.flatMap((thread): Json[] => {
			const notes = list(thread.notes ?? null).filter((note) => note.system !== true);
			const resolvable = notes.some((note) => note.resolvable === true);
			const resolved = resolvable && notes.every((note) => note.resolvable !== true || note.resolved === true);
			if (notes.length === 0 || resolved) return [];
			const position = notes.map((note) => note.position).find(isObject);
			return [
				{
					id: thread.id ?? null,
					resolvable,
					resolved,
					position: (position && positionText(position)) ?? null,
					notes: notes.map((note) => ({
						author: note.author ?? null,
						created_at: note.created_at ?? null,
						body: cut(ciText(note.body), OVERVIEW_NOTE_CHARS),
					})),
				},
			];
		});
		const title = `Discussions: ${open.length} open of ${threads.length} (resolved threads and system notes left out)`;
		return { title, value: fold(open, "top") };
	});
	add("Changed files", diffs, (json) => {
		const files = list(json).map((diff) => {
			const from = ciText(diff.old_path);
			const to = ciText(diff.new_path);
			if (diff.new_file === true) return `added ${to}`;
			if (diff.deleted_file === true) return `deleted ${from}`;
			if (diff.renamed_file === true) return `renamed ${from} → ${to}`;
			return `modified ${to}`;
		});
		return { title: `Changed files: ${files.length}`, value: files };
	});
	return { head: mr.value.status, body: sections.join("\n\n") };
}

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
 *   like mcpServers in Pi's mcp.json; the first instance is the default.
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

/** The instances of a parsed config file in the order they are written. */
function parseConfig(config: unknown, defaultTokenEnv: string): ConfiguredInstance[] {
	if (!isObject(config) || config.instances === undefined) throw new Error(`expected ${FORMAT}`);
	if (!isObject(config.instances)) throw new Error(`instances must be a map from URL to settings: ${FORMAT}`);
	const entries = Object.entries(config.instances);
	if (entries.length === 0) throw new Error("instances is empty");
	return entries.map(([address, entry]) => {
		if (!isObject(entry)) throw new Error(`${address}: expected the settings of the instance, {"token": "…"}`);
		if (entry.url !== undefined) throw new Error(`${address}: the URL is the key; leave url out`);
		return parseInstance(address, entry, address, defaultTokenEnv);
	});
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

/**
 * The gitlab_pipeline tool: the CI pipelines and jobs of a project in a few lines, through the instances, tokens, and
 * requests of the gitlab tool. A Python port of it for Claude Code carries the same logic: change them alike.
 *
 * - The project is project (its id, its full path, or the web URL of the project, a pipeline, a job, or a merge
 *   request), else the one of the working directory's origin remote, on the instance that remote belongs to.
 * - The pipeline is pipeline (its id, as in /-/pipelines/<id>), else the head pipeline of merge request mr, else the
 *   pipeline of a job given by id, else the latest of ref, else the latest of the project. A job is named by its name
 *   in that pipeline (the latest run of it) or by its id.
 * - status: the pipeline and its jobs as a table (stage, job, status, time, runner, id), trigger jobs with their
 *   downstream pipeline, and the manual jobs waiting to be played.
 * - wait polls a job, or the pipeline, until it settles, without model requests: success, failed, canceled, skipped,
 *   or held at a manual job; a failed pipeline or job comes with the end of the logs of its failed jobs.
 * - needResult is required with wait and chain, and with wait: true on play, retry, and run: the model's decision
 *   whether its next step needs the result, as with the wait tool. true waits in the foreground; when the user sends a
 *   message meanwhile, or after CI_DETACH_MS, the wait goes on in the background with the checks it made, and the call
 *   returns at once with its id. Without a terminal (subagents, print, JSON, and RPC mode) every wait is in the
 *   foreground.
 * - log: the end of a job log, or the lines matching grep with their numbers, without colour codes, timestamps,
 *   section markers, and the lines a carriage return overwrote.
 * - play, retry, cancel, and run change state; with wait: true they wait for the job or pipeline afterwards.
 * - chain runs the jobs given, in their order, in one call: every name is looked up in the pipeline before anything is
 *   played. A manual job is played, one not ready yet (an earlier stage still running) awaited until it is manual, one
 *   that succeeded already left alone; a job that ends failed, canceled, or skipped stops the chain with the end of its
 *   log, and a created job the pipeline no longer moves (a manual job before it not among them) stops it too. Then
 *   check GETs each URL without a token, tried again for about a minute while it answers 5xx or not at all. A chain is
 *   one wait: needResult, the foreground and the background, timeout, and stop_wait work as for wait, and a stopped
 *   chain plays no further job.
 * - needResult: false returns at once with an id. The wait goes on without stopping for
 *   the user's messages, and a message brings its result into the conversation: while Pi works, with its next step,
 *   so it is not stale by the time it comes; when Pi is idle, it starts a turn.
 *   stop_wait (waitId) or /gitlab-waits stop <id> ends one; list and /gitlab-waits list them, those of the wait tool
 *   too. A check that fails on the network or with a server error is repeated, up to CI_RETRIES times in a row.
 * - Background waits go on over /reload, and a result that comes while Pi reloads arrives once it has; another session
 *   (/new, /resume, /fork) ends them and names them in a notice. They are published on the event bus as the wait
 *   tool's are ("background-waits:state", see wait.ts), for the panel of background-agents.ts and for
 *   tmux-tab-activity.ts.
 */
const CI_ACTIONS = ["status", "wait", "log", "play", "retry", "cancel", "run", "chain", "stop_wait", "list"] as const;
type CiAction = (typeof CI_ACTIONS)[number];
/** States of a job or pipeline that still change by themselves; manual waits for a person and counts as settled. */
const CI_ACTIVE = new Set(["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled", "waiting_for_callback"]);
const CI_JOB_PAGES = 5;
const CI_LOG_LINES = 60;
const CI_MAX_LOG_LINES = 500;
const CI_TAIL_LINES = 15;
const CI_TAIL_JOBS = 3;
const CI_LINE_CHARS = 400;
const CI_INTERVAL_S = 15;
const CI_TIMEOUT_MIN = 30;
const CI_BACKGROUND_TIMEOUT_MIN = 120;
/** Checks in a row that may fail on the network or with a server error before a wait gives up. */
const CI_RETRIES = 3;
const CI_MESSAGE_TYPE = "gitlab_pipeline";
const CI_MAX_TIMEOUT_MIN = 180;
/** How long a wait whose result the model needs stays in the foreground before it goes on in the background. */
const CI_DETACH_MS = 5 * 60_000;
/** A chain's check of a URL that answers 5xx or not at all is tried again every CI_CHECK_EVERY_MS for this long. */
const CI_CHECK_WINDOW_MS = 75_000;
const CI_CHECK_EVERY_MS = 15_000;
/** The event-bus contract with wait.ts, background-agents.ts, and tmux-tab-activity.ts. */
const WAITS_STATE = "background-waits:state";
const WAITS_REQUEST = "background-waits:request";
const WAITS_CANCEL = "background-waits:cancel";
/** What GitLab's timestamped job logs put before each line: the time, the stream, and "+" (append) or a space. */
const CI_LOG_PREFIX = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z [0-9a-f]{2}[OE][+ ]?/;
/** The start and end markers of a collapsible section in a job log. */
const CI_SECTION = /section_(?:start|end):\d+:[^\s\r\x1b]+/g;

/** The project of a call and what its web URL named. */
type CiTarget = { instance: Instance; project: string; pipeline?: number; job?: number; mr?: number; issue?: number };

const ciText = (value: Json | undefined): string =>
	value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

/** GitLab's error message as text: a string, a list, or a map from field to messages ({"base": ["…"]}). */
function ciMessage(value: Json | undefined): string {
	if (Array.isArray(value)) return value.map(ciMessage).join("; ");
	if (isObject(value)) {
		return Object.entries(value)
			.map(([key, inner]) => (key === "base" ? ciMessage(inner) : `${key}: ${ciMessage(inner)}`))
			.join("; ");
	}
	return ciText(value);
}

function ciObject(value: Json, what: string): JsonObject {
	if (!isObject(value)) throw new Error(`GitLab answered with something other than ${what}`);
	return value;
}

function ciOneLine(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * A request of gitlab_pipeline and gitlab_work: the body of an answer below 400 as text. An answer of 400 or more
 * throws, masked, with the method, the path, the status, GitLab's message, and a hint; the error carries status and
 * detail, GitLab's message alone.
 */
async function apiRequest(
	instance: Instance,
	token: string,
	method: "GET" | "POST" | "PUT",
	path: string,
	query: Record<string, unknown> | undefined,
	body: unknown,
	signal: AbortSignal | undefined,
	mask: (text: string) => string,
): Promise<string> {
	const url = requestUrl(instance, path, query);
	const payload: Payload | undefined = body === undefined ? undefined : { contentType: "application/json", data: JSON.stringify(body) };
	const { response } = await send(instance, token, method, url, payload, signal);
	const text = new TextDecoder().decode(await readLimited(response));
	if (response.status < 400) return text;
	const rerun = response.status === 401 && forgetToken(instance);
	let message = text.trim();
	try {
		const parsed = JSON.parse(message) as Json;
		if (isObject(parsed)) message = ciMessage(parsed.message ?? parsed.error ?? parsed.errors ?? parsed);
	} catch {
		// not JSON: the text itself
	}
	const hint = [STATUS_HINTS[response.status], rerun ? "Its token command runs again at the next call." : ""];
	const error = new Error(
		mask([`${method} ${url.pathname}: HTTP ${response.status}`, ciOneLine(message, 300), ...hint].filter(Boolean).join(" — ")),
	);
	throw Object.assign(error, { status: response.status, detail: mask(message) });
}

/** The JSON of an answer, redacted; anything else throws with its start. */
function apiJson(text: string, mask: (text: string) => string): Json {
	try {
		return redact(JSON.parse(text) as Json);
	} catch {
		throw new Error(`GitLab answered with something other than JSON: ${ciOneLine(mask(text), 200)}`);
	}
}

function ciDuration(seconds: number | undefined): string {
	if (seconds === undefined || !Number.isFinite(seconds)) return "";
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A time of GitLab's as local YYYY-MM-DD HH:MM. */
function ciTime(value: Json | undefined): string {
	const date = new Date(ciText(value));
	if (Number.isNaN(date.getTime())) return ciText(value);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The working directory's origin remote as host, path, and scheme (empty for scp syntax); undefined without one. */
function ciOriginRemote(cwd: string): { host: string; path: string; scheme: string } | undefined {
	const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", timeout: 10_000, windowsHide: true });
	const remote = result.status === 0 ? result.stdout.trim() : "";
	if (!remote) return undefined;
	const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(remote);
	if (scp && !remote.includes("://")) return { host: scp[1].toLowerCase(), path: scp[2], scheme: "" };
	try {
		const url = new URL(remote);
		return { host: url.hostname.toLowerCase(), path: decodeURIComponent(url.pathname), scheme: url.protocol.replace(/:$/, "") };
	} catch {
		return undefined;
	}
}

const ciHostname = (instance: Instance) => new URL(instance.origin).hostname.toLowerCase();

/** The instance and the URL-encoded project of a call: project, a web URL in it, or the origin remote of cwd. */
function ciTarget(instances: Instance[], host: string | undefined, project: string | undefined, cwd: string): CiTarget {
	const names = instances.map((instance) => instance.name).join(", ");
	const given = project?.trim() ?? "";
	const named = host?.trim() ? pickInstance(instances, host, "", () => true, CONFIG_FILE) : undefined;
	if (/^https?:\/\//i.test(given)) {
		const url = new URL(given);
		const instance =
			named ?? instances.find((candidate) => url.origin === candidate.origin && within(url.pathname, candidate.basePath));
		if (!instance || url.origin !== instance.origin) throw new Error(`${given} is not on a configured instance (${names})`);
		const { project: name, page } = webPage(instance, url);
		const item = /^(pipelines|jobs|merge_requests|issues|work_items)\/(\d+)/.exec(page);
		if (!name) throw new Error(`${given} names no project`);
		const id = item ? Number(item[2]) : undefined;
		return {
			instance,
			project: encodeURIComponent(name),
			pipeline: item?.[1] === "pipelines" ? id : undefined,
			job: item?.[1] === "jobs" ? id : undefined,
			mr: item?.[1] === "merge_requests" ? id : undefined,
			issue: item?.[1] === "issues" || item?.[1] === "work_items" ? id : undefined,
		};
	}
	if (given) {
		const name = given.replace(/^\/+|\/+$/g, "");
		return { instance: named ?? instances[0], project: /^\d+$/.test(name) ? name : encodeURIComponent(name) };
	}
	const remote = ciOriginRemote(cwd);
	if (!remote) throw new Error("the working directory has no git origin remote: give project (group/project, its id, or a web URL)");
	const instance = named ?? instances.find((candidate) => ciHostname(candidate) === remote.host);
	if (!instance || ciHostname(instance) !== remote.host) {
		throw new Error(
			`origin (${remote.host || "no host"}) is not a project of ${instance ? instance.base : `a configured instance (${names})`}: give project`,
		);
	}
	let path = remote.path;
	if (instance.basePath && /^https?$/.test(remote.scheme) && within(path.replace(/\/+$/, ""), instance.basePath)) {
		path = path.slice(instance.basePath.length);
	}
	path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
	if (!path) throw new Error("origin names no project path: give project");
	return { instance, project: encodeURIComponent(path) };
}

/** The lines of a job log as a terminal shows them, without timestamps, section markers, and colour codes. */
function ciLogLines(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.replace(ANSI_ESCAPE, "").split("\n")) {
		let line = raw.replace(CI_LOG_PREFIX, "");
		const marker = line.includes("section_start:") || line.includes("section_end:");
		line = line.replace(CI_SECTION, "").replace(/\r+$/, "");
		line = line.slice(line.lastIndexOf("\r") + 1).trimEnd();
		if (marker && !line.trim()) continue;
		out.push(line.length > CI_LINE_CHARS ? `${line.slice(0, CI_LINE_CHARS - 1)}…` : line);
	}
	while (out.length > 0 && !out[out.length - 1].trim()) out.pop();
	return out;
}

function ciJobRow(job: JsonObject): string[] {
	const status = ciText(job.status);
	const started = Date.parse(ciText(job.started_at));
	const seconds =
		typeof job.duration === "number"
			? job.duration
			: status === "running" && !Number.isNaN(started)
				? (Date.now() - started) / 1000
				: undefined;
	const runner = isObject(job.runner) ? ciText(job.runner.description) || `#${ciText(job.runner.id)}` : "";
	const allowed = job.allow_failure === true && status === "failed" ? " (allowed)" : "";
	return [ciText(job.stage), ciText(job.name), status + allowed, ciDuration(seconds), runner, ciText(job.id)];
}

function ciBridgeRow(bridge: JsonObject): string[] {
	const down = isObject(bridge.downstream_pipeline) ? bridge.downstream_pipeline : undefined;
	const target = down ? `→ pipeline ${ciText(down.id)} ${ciText(down.status)}` : "→ no pipeline yet";
	return [ciText(bridge.stage), ciText(bridge.name), ciText(bridge.status), "", target, `bridge ${ciText(bridge.id)}`];
}

/** Jobs and bridges in stage order (the order a stage first appears in), each stage in the order of creation. */
function ciRows(jobs: JsonObject[], bridges: JsonObject[]): string[][] {
	const all = [
		...jobs.map((job) => ({ id: Number(job.id), stage: ciText(job.stage), row: ciJobRow(job) })),
		...bridges.map((bridge) => ({ id: Number(bridge.id), stage: ciText(bridge.stage), row: ciBridgeRow(bridge) })),
	].sort((a, b) => a.id - b.id);
	const rank = new Map<string, number>();
	for (const item of all) if (!rank.has(item.stage)) rank.set(item.stage, rank.size);
	return all.sort((a, b) => (rank.get(a.stage) ?? 0) - (rank.get(b.stage) ?? 0) || a.id - b.id).map((item) => item.row);
}

/** Rows of cells in aligned columns, the last one unpadded. */
function ciColumns(rows: string[][]): string {
	const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
	return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ").trimEnd()).join("\n");
}

const ciTable = (rows: string[][]): string => ciColumns([["stage", "job", "status", "time", "runner", "id"], ...rows]);

function ciPipelineHead(pipeline: JsonObject): string {
	const ref = ciText(pipeline.ref);
	const mr = /^refs\/merge-requests\/(\d+)\//.exec(ref);
	const where = mr ? `merge request !${mr[1]}` : pipeline.tag === true ? `tag ${ref}` : `branch ${ref}`;
	const user = isObject(pipeline.user) ? ciText(pipeline.user.username) : "";
	const parts = [
		`Pipeline ${ciText(pipeline.id)}${pipeline.iid === undefined ? "" : ` (#${ciText(pipeline.iid)})`}`,
		where,
		ciText(pipeline.sha).slice(0, 8),
		ciText(pipeline.status),
		ciDuration(typeof pipeline.duration === "number" ? pipeline.duration : undefined),
		`${ciText(pipeline.source)}${user ? ` by ${user}` : ""}, ${ciTime(pipeline.created_at)}`,
	];
	return `${parts.filter(Boolean).join(" · ")}\n${ciText(pipeline.web_url)}`;
}

function ciJobHead(job: JsonObject): string {
	const [, name, status, time, runner] = ciJobRow(job);
	const parts = [
		`Job ${ciText(job.id)} ${name}`,
		status + (job.failure_reason ? ` (${ciText(job.failure_reason)})` : ""),
		time,
		runner ? `runner ${runner}` : "",
		isObject(job.pipeline) ? `pipeline ${ciText(job.pipeline.id)}` : "",
		ciText(job.ref),
	];
	return `${parts.filter(Boolean).join(" · ")}\n${ciText(job.web_url)}`;
}

/** CI/CD variables as GitLab takes them, {key, value}. */
function ciVariables(variables: Record<string, unknown> | undefined): Array<{ key: string; value: string }> {
	return Object.entries(variables ?? {}).map(([key, value]) => {
		if (!/^[A-Za-z0-9_]+$/.test(key)) throw new Error(`variable ${key}: a key takes letters, digits, and _ only`);
		return { key, value: typeof value === "string" ? value : JSON.stringify(value) };
	});
}

/** What a chain's check of a URL found: the final status (none when unreachable), the time, and where it ended. */
type CiProbe = { status?: number; ms: number; url: URL; error?: string };

/** GETs a URL as a browser reaches it, never with a token, following up to MAX_REDIRECTS redirects. */
async function ciProbe(url: URL, signal: AbortSignal | undefined): Promise<CiProbe> {
	const started = Date.now();
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let current = url;
	for (let hop = 0; ; hop++) {
		let response: Response;
		try {
			response = await request(current, "GET", { Accept: "text/html, */*;q=0.1", "User-Agent": USER_AGENT }, undefined, abort);
		} catch (error) {
			if (signal?.aborted) throw error;
			const plain = timeout.aborted
				? `no answer within ${REQUEST_TIMEOUT_MS / 1000}s`
				: error instanceof Error
					? error.message || String((error as { code?: unknown }).code ?? error.name)
					: String(error);
			return { ms: Date.now() - started, url: current, error: certificateProblem(error) ?? plain };
		}
		await response.body?.cancel().catch(() => {});
		const location = response.headers.get("location");
		if (location && response.status >= 300 && response.status < 400 && hop < MAX_REDIRECTS) {
			current = new URL(location, current);
			continue;
		}
		return { status: response.status, ms: Date.now() - started, url: current };
	}
}

/** Whether gitlab.json keeps a tool: all but "pipelines": false (gitlab_pipeline) and "work": false (gitlab_work). */
function toolWanted(key: "pipelines" | "work"): boolean {
	try {
		const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as unknown;
		return !(isObject(config as Json) && (config as JsonObject)[key] === false);
	} catch {
		return true;
	}
}

const CiParams = {
	action: StringEnum(CI_ACTIONS, {
		description:
			"status: the pipeline and its jobs; wait: until a job or the pipeline settles; log: the end of a job log; play: start a manual job; retry: a job, or the failed jobs of the pipeline; cancel: a job or the pipeline; run: a new pipeline for ref; chain: run jobs one after the other, then check URLs; stop_wait: end a background wait (waitId), the pipeline or job itself goes on; list: the background waits, the wait tool's too",
	}),
	project: Type.Optional(
		Type.String({
			description:
				"group/project, its id, or a web URL of the project or of one of its pipelines, jobs, or merge requests; default the project of the working directory's origin remote",
		}),
	),
	pipeline: Type.Optional(Type.Integer({ description: "Pipeline id, as in /-/pipelines/<id>; default the latest of ref, or of the project" })),
	ref: Type.Optional(
		Type.String({ description: "Branch or tag: its latest pipeline; for run, the ref to run (default: the default branch)" }),
	),
	mr: Type.Optional(Type.Integer({ description: "Merge request iid: its head pipeline" })),
	job: Type.Optional(
		Type.Union([Type.String(), Type.Integer()], {
			description: "A job: its name in the pipeline (e.g. docker-deploy:prd) or its id. Without it, wait, retry, and cancel act on the pipeline",
		}),
	),
	variables: Type.Optional(
		Type.Object({}, {
			additionalProperties: Type.String(),
			description: "CI/CD variables, key → value: for run, of the new pipeline; for play and chain, of each job played",
		}),
	),
	jobs: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"chain: the names of jobs in the pipeline, in the order to run them. A manual one is played, one not ready yet awaited, " +
				"one that succeeded already left alone; one that fails stops the chain. All must exist, or nothing is played",
		}),
	),
	check: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"chain: http(s) URLs to GET without a token once all jobs succeeded: status, time, and where redirects end. A 5xx " +
				"or no answer is tried again for about a minute and fails the chain; 401 and 403 count as reachable",
		}),
	),
	wait: Type.Optional(Type.Boolean({ description: "play, retry, run: wait for the job or pipeline afterwards, as action wait does" })),
	needResult: Type.Optional(
		Type.Boolean({
			description:
				"Required with wait and chain, and with wait: true on play/retry/run: does your next step need the result? true: wait here " +
				"(up to 5 minutes, then in the background). false: return at once, wait in the background, a message brings the result",
		}),
	),
	waitId: Type.Optional(Type.String({ description: "stop_wait: the id of the background wait, as gp1" })),
	interval: Type.Optional(Type.Number({ description: `wait, chain: seconds between checks (default ${CI_INTERVAL_S}, 5 to 300)` })),
	timeout: Type.Optional(
		Type.Number({
			description: `wait, chain (the whole chain): minutes before giving up (default ${CI_TIMEOUT_MIN}, with needResult: false ${CI_BACKGROUND_TIMEOUT_MIN}; at most ${CI_MAX_TIMEOUT_MIN})`,
		}),
	),
	lines: Type.Optional(Type.Integer({ description: `log: lines from the end (default ${CI_LOG_LINES}, at most ${CI_MAX_LOG_LINES})` })),
	grep: Type.Optional(
		Type.String({ description: "log: only the lines matching this regular expression (case-insensitive), with their numbers" }),
	),
};

interface CiWait {
	id: string;
	/** "pipeline 123 of group/project", "job 456 of group/project". */
	what: string;
	started: number;
	checks: number;
	/** What the last check found. */
	progress: string;
	intervalMs: number;
	timeoutMs: number;
	abort: AbortController;
	/** A chain plays jobs: stopping it ends its plays, while stopping a wait leaves what it waits for alone. */
	chain: boolean;
}

// A copy of BackgroundWaitView from wait.ts, the event-bus contract between wait.ts, gitlab.ts, background-agents.ts,
// and tmux-tab-activity.ts: change all alike.
/** A background wait as other extensions see it ("background-waits:state", { tool, waits } for each tool that waits). */
interface BackgroundWaitView {
	/** w1, gp1, …: what cancel and stop_wait take. */
	id: string;
	/** The tool that waits: wait, gitlab_pipeline. */
	tool: string;
	/** What is awaited. */
	label: string;
	/** When the wait ends, in words; for a repeating wait, when it raises an alert. */
	until: string;
	/** Repeats its check until it is cancelled or the session ends, and does not end when until holds. */
	repeat?: boolean;
	startedAt: number;
	checks: number;
	/** What the last check found, in one line. */
	last?: string;
	/** The command each check runs, where there is one. */
	command?: string;
	/** The end of the last check's output, where it says more than last. */
	output?: string;
	intervalMs: number;
	/** When it gives up; Infinity for a repeating wait without a timeout. */
	deadline: number;
}

/** Whether a result message is open: a click toggles it, ctrl+o sets all of them anew. */
const resultOpen = new WeakMap<object, { expanded: boolean; open: boolean }>();

/** The text of a custom message. */
function messageText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	return typeof content === "string" ? content : content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

/**
 * A background wait's result message in one line, in the colours of Pi's custom messages: [label] and what was awaited
 * on the left, the outcome on the right. A click or ctrl+o opens the whole text as Pi draws it. Copied in wait.ts and
 * gitlab.ts, which keep it alike.
 */
function resultLine(
	message: object,
	label: string,
	left: string,
	right: string,
	body: string,
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component {
	let state = resultOpen.get(message);
	if (!state || state.expanded !== options.expanded) {
		state = { expanded: options.expanded, open: options.expanded };
		resultOpen.set(message, state);
	}
	const shown = state;
	const paint = (text: string) => theme.bg("customMessageBg", text);
	const tag = theme.fg("customMessageLabel", `\x1b[1m[${label}]\x1b[22m`);
	const full = new Box(options.outputPad, 1, paint);
	full.addChild(new Text(tag, 0, 0));
	full.addChild(new Spacer(1));
	full.addChild(new Markdown(body, 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) }));
	const row: Component = {
		render(width) {
			if (shown.open) return full.render(width);
			const pad = Math.min(options.outputPad, Math.floor((width - 1) / 2));
			const inner = Math.max(1, width - 2 * pad);
			const end = visibleWidth(right) > inner - 2 ? truncateToWidth(right, Math.max(0, inner - 2), "") : right;
			const room = Math.max(1, inner - (end ? visibleWidth(end) + 2 : 0));
			const start = truncateToWidth(`${tag} ${theme.fg("customMessageText", left)}`, room, "…");
			const gap = Math.max(end ? 2 : 0, inner - visibleWidth(start) - visibleWidth(end));
			const line = " ".repeat(pad) + start + " ".repeat(gap) + end;
			return [paint(line + " ".repeat(Math.max(0, width - visibleWidth(line))))];
		},
		invalidate() {
			full.invalidate();
		},
	};
	return new MouseRegion(row, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		shown.open = !shown.open;
		return { handled: true };
	});
}

/** How a background result reads on the right of its line: the mark, its colour, and a few words. */
function ciOutcome(first: string): { color: "success" | "error" | "warning" | "accent" | "muted"; mark: string; word: string } {
	const lead = first.replace(/^Background wait [\w-]+: /, "").replace(/\.$/, "");
	if (/^Background wait [\w-]+ for .* ended without a result/.test(first)) return { color: "error", mark: "✗", word: "no result" };
	const gaveUp = /^Gave up after [^:]+: .* is still (\w+)/.exec(lead);
	if (gaveUp) return { color: "warning", mark: "■", word: `gave up, still ${gaveUp[1]}` };
	if (/^Chain succeeded/.test(lead)) return { color: "success", mark: "✓", word: "chain succeeded" };
	if (/^Chain /.test(lead)) return { color: "error", mark: "✗", word: truncateToWidth(lead, 48, "…") };
	const status = /^(?:Pipeline|Job) .* is (\w+)/.exec(lead)?.[1];
	if (status === "success") return { color: "success", mark: "✓", word: status };
	if (status === "failed") return { color: "error", mark: "✗", word: status };
	if (status === "manual") return { color: "accent", mark: "◆", word: "waits at a manual job" };
	if (status === "canceled") return { color: "warning", mark: "■", word: status };
	return { color: "muted", mark: "•", word: status ?? truncateToWidth(lead, 48, "…") };
}

/** A result that came while no session runtime could take it, during a /reload. */
interface CiHeld {
	content: string;
	details: Record<string, unknown>;
}

/**
 * The background waits of gitlab_pipeline, shared by the session runtimes of this process: /reload loads this file
 * afresh and replaces the runtime, and its pi and ctx throw once replaced. So a wait outlives the runtime that started
 * it and reports to the one current when it ends.
 */
interface CiShared {
	/** The current runtime; ready once it is complete, after resources_discover. None during a reload. */
	live?: { pi: ExtensionAPI; ctx: ExtensionContext; ready: boolean };
	waits: Map<string, CiWait>;
	counter: number;
	held: CiHeld[];
	/** The waits a switch to another session ended, for a notice in that one. */
	ended: string[];
}
const ciStore = globalThis as typeof globalThis & Record<symbol, CiShared | undefined>;
const ciShared: CiShared = (ciStore[Symbol.for("pi.gitlab-pipeline.waits")] ??= { waits: new Map(), counter: 0, held: [], ended: [] });

/** A time as HH:MM, with the date before it when it is not today. */
function ciClock(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return d.toDateString() === new Date().toDateString() ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

function ciView(entry: CiWait): BackgroundWaitView {
	return {
		id: entry.id,
		tool: CI_MESSAGE_TYPE,
		label: entry.what,
		until: entry.chain ? "the chain ends" : `the ${entry.what.split(" ")[0]} settles`,
		startedAt: entry.started,
		checks: entry.checks,
		last: entry.progress,
		intervalMs: entry.intervalMs,
		deadline: entry.started + entry.timeoutMs,
	};
}

/** Tells the other extensions about the background waits, through the runtime given or else the current one. */
function ciPublish(via: ExtensionAPI | undefined = ciShared.live?.pi): void {
	try {
		via?.events.emit(WAITS_STATE, { tool: CI_MESSAGE_TYPE, waits: [...ciShared.waits.values()].map(ciView) });
	} catch {
		// A runtime replaced meanwhile; the next one asks at its start.
	}
}

/** Brings a result into the conversation of the current runtime, or keeps it until there is one. */
function ciDeliver(held: CiHeld): void {
	const live = ciShared.live;
	if (live?.ready) {
		try {
			live.pi.sendMessage(
				{ customType: CI_MESSAGE_TYPE, content: held.content, display: true, details: held.details },
				{ triggerTurn: true, deliverAs: "steer" },
			);
			return;
		} catch {
			// The runtime went away meanwhile: kept for the next one.
		}
	}
	ciShared.held.push(held);
}

function stopCiWait(id: string): string {
	const entry = ciShared.waits.get(id);
	const running = [...ciShared.waits.keys()];
	if (!entry) return `No background wait ${id}${running.length > 0 ? `; running: ${running.join(", ")}` : ""}.`;
	entry.abort.abort();
	ciShared.waits.delete(id);
	ciPublish();
	const span = ciDuration((Date.now() - entry.started) / 1000) || "0s";
	const rest = entry.chain
		? "it plays no further job, and a job already running goes on"
		: `the ${entry.what.split(" ")[0]} itself goes on`;
	return `Stopped background wait ${id} for ${entry.what} after ${span}; ${rest}.`;
}

/** One line per background wait, of every tool that waits. */
function ciListText(views: BackgroundWaitView[]): string {
	if (views.length === 0) return "No background waits.";
	const now = Date.now();
	return views
		.map((v) => {
			const span = `${v.checks} check${v.checks === 1 ? "" : "s"} in ${ciDuration((now - v.startedAt) / 1000) || "0s"}, every ${ciDuration(v.intervalMs / 1000)}`;
			return `${v.id}  ${v.label} (${v.tool}): until ${v.until}; ${span}, gives up at ${ciClock(v.deadline)}${v.last ? `; last: ${v.last}` : ""}`;
		})
		.join("\n");
}

function ciParameters(instances: Instance[]) {
	const all = Type.Object({ host: Type.Optional(hostParameter(instances, "GitLab")), ...CiParams });
	return instances.length > 1 ? all : (Type.Object(CiParams) as unknown as typeof all);
}

/**
 * The gitlab_work tool: in one call what takes several gitlab calls otherwise, through the instances, tokens, and
 * requests of the gitlab tool. A Python port of it for Claude Code carries the same logic: change them alike.
 *
 * - The project is found as for gitlab_pipeline (ciTarget); a web URL of an issue or merge request gives iid too.
 * - issue_template lists a project's issue templates, or shows one. issue_create checks a description against the
 *   headings of template, assigns the token's own user unless assignee says otherwise, and sets the group's current
 *   iteration with GraphQL (issueSetIteration; REST ignores iteration_id) where there is exactly one; with several it
 *   names them and sets none rather than guess. issue_update makes the REST changes and the iteration's in one call.
 * - issue_view fetches the issue, its notes, related merge requests, and linked issues in parallel; a part that fails
 *   shows its error in its section.
 * - mr_create returns the open merge request of the source branch where there is one already, and tries once more
 *   after WORK_BRANCH_RETRY_MS when GitLab does not know the source branch yet (a push just landed).
 * - mr_merge polls detailed_merge_status every WORK_MERGE_EVERY_MS while GitLab works it out, in the foreground only,
 *   bounded by timeout. A pipeline still running ends the call with a note unless wait_for_pipeline waits for it or
 *   when_pipeline_succeeds sets auto-merge; a status that blocks the merge is reported at once. The merge sends the sha
 *   it checked, so a commit pushed meanwhile is not merged unseen.
 * - deployed shows the last successful deployment of each environment, or without environments the latest successful
 *   job of each name matching jobs, and with contains whether each runs that commit (merge_base).
 */
const WORK_ACTIONS = ["issue_template", "issue_create", "issue_update", "issue_view", "mr_create", "mr_merge", "deployed"] as const;
type WorkAction = (typeof WORK_ACTIONS)[number];
/** issue_view shows this many notes, the newest, each cut to WORK_NOTE_CHARS. */
const WORK_NOTES = 20;
const WORK_NOTE_CHARS = 500;
const WORK_MERGE_EVERY_MS = 5_000;
const WORK_MERGE_TIMEOUT_MIN = 10;
const WORK_MAX_MERGE_TIMEOUT_MIN = 30;
const WORK_BRANCH_RETRY_MS = 2_000;
/** deployed reads this many pages of 100 successful jobs at most, and this many environments. */
const WORK_JOB_PAGES = 5;
const WORK_ENVIRONMENTS = 50;
/** GitLab takes a description of up to 1 MB. */
const WORK_MAX_DESCRIPTION_BYTES = 1024 * 1024;
/** Merge statuses GitLab is still working out. */
const MERGE_PENDING = new Set(["checking", "unchecked", "preparing", "approvals_syncing"]);
/** Why a merge status blocks the merge, and what helps. */
const MERGE_BLOCKS: Record<string, string> = {
	conflict: "it has merge conflicts: rebase the source branch or resolve them",
	discussions_not_resolved: "its open threads must be resolved first",
	not_approved: "it lacks required approvals",
	requested_changes: "a reviewer requested changes",
	draft_status: "it is a draft: mark it ready first",
	blocked_status: "another merge request blocks it",
	merge_request_blocked: "a merge request it depends on must be merged first",
	need_rebase: "the target branch moved on: rebase the source branch first",
	ci_must_pass: "its pipeline must succeed first",
	not_open: "it is not open",
	commits_status: "its source branch is missing or has no commits",
	jira_association_missing: "its title or description must name a Jira issue",
	status_checks_must_pass: "external status checks must pass first",
	locked_paths: "files it changes are locked",
	locked_lfs_files: "LFS files it changes are locked",
	security_policy_violations: "a security policy blocks it",
	title_regex: "its title does not match the pattern the project requires",
	merge_time: "it may be merged only after a set time",
};
const ITERATION_FIELDS = "id title startDate dueDate iterationCadence { id title }";
const CURRENT_ITERATIONS_QUERY = `query($path: ID!) { project(fullPath: $path) { group { iterations(state: current, includeAncestors: true, first: 20) { nodes { ${ITERATION_FIELDS} } } } } }`;
const ISSUE_ITERATION_QUERY = `query($path: ID!, $iid: String!) { project(fullPath: $path) { issue(iid: $iid) { iteration { ${ITERATION_FIELDS} } } } }`;
const SET_ITERATION_MUTATION = `mutation($path: ID!, $iid: String!, $iteration: IterationID) { issueSetIteration(input: {projectPath: $path, iid: $iid, iterationId: $iteration}) { errors issue { iteration { ${ITERATION_FIELDS} } } } }`;
const DEPLOY_JOBS_QUERY = `query($path: ID!, $after: String) { project(fullPath: $path) { jobs(statuses: [SUCCESS], first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { name refName finishedAt pipeline { ... on Pipeline { sha user { username } } } } } } }`;

const workMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Sleeps ms, or throws once signal aborts. */
function workSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const aborted = () => reject(new Error("gitlab_work: aborted"));
		if (signal?.aborted) return aborted();
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			aborted();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** The description of a call: description, or the UTF-8 text of descriptionFile. */
function workDescription(text: string | undefined, file: string | undefined): string | undefined {
	if (text !== undefined && file !== undefined) throw new Error("give description or descriptionFile, not both");
	if (file === undefined) return text;
	const resolved = localPath(file);
	let data: Buffer;
	try {
		const stat = statSync(resolved);
		if (!stat.isFile()) throw new Error("not a regular file");
		if (stat.size > WORK_MAX_DESCRIPTION_BYTES) throw new Error(`larger than ${formatSize(WORK_MAX_DESCRIPTION_BYTES)}`);
		data = readFileSync(resolved);
	} catch (error) {
		throw new Error(`descriptionFile: ${resolved} cannot be read (${workMessage(error)})`);
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch {
		throw new Error(`descriptionFile: ${resolved} is not UTF-8 text`);
	}
}

/** The Markdown headings of a text (ATX, # to ######) as they stand, those in fenced code left out. */
function workHeadings(markdown: string): string[] {
	const out: string[] = [];
	let fence = "";
	for (const line of markdown.split(/\r?\n/)) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
			continue;
		}
		if (!fence && /^ {0,3}#{1,6}[ \t]+\S/.test(line)) out.push(line.trim());
	}
	return out;
}

/** A heading compared by its text alone: without its #s, case, and extra spaces. */
const workHeadingKey = (heading: string) =>
	heading.replace(/^#+\s*/, "").replace(/\s+#+$/, "").replace(/\s+/g, " ").trim().toLowerCase();

/** The headings of a template that the description lacks, or has out of their order. */
function workMissingHeadings(template: string, description: string): string[] {
	const found = workHeadings(description).map(workHeadingKey);
	const missing: string[] = [];
	let at = 0;
	for (const heading of workHeadings(template)) {
		const index = found.indexOf(workHeadingKey(heading), at);
		if (index < 0) missing.push(heading);
		else at = index + 1;
	}
	return missing;
}

/** Labels as GitLab takes them, comma-separated; undefined when not given. */
function workLabels(value: string | string[] | undefined): string | undefined {
	if (value === undefined) return undefined;
	return (Array.isArray(value) ? value : value.split(",")).map((label) => label.trim()).filter(Boolean).join(",");
}

/** An iteration of REST (start_date, numeric id) or GraphQL (startDate, gid) as "Cadence Title start – due (gid)". */
function workIteration(iteration: JsonObject): string {
	const cadence = isObject(iteration.iterationCadence) ? ciText(iteration.iterationCadence.title) : "";
	const start = ciText(iteration.startDate ?? iteration.start_date);
	const due = ciText(iteration.dueDate ?? iteration.due_date);
	const id = ciText(iteration.id);
	const gid = id.startsWith("gid://") ? id : `gid://gitlab/Iteration/${id}`;
	return [cadence, ciText(iteration.title), start || due ? `${start} – ${due}` : "", `(${gid})`].filter(Boolean).join(" ");
}

/** The usernames of a list of users, as @name, or none. */
function workUsers(value: Json | undefined): string {
	const users = Array.isArray(value) ? value.filter(isObject) : [];
	return users.map((user) => `@${ciText(user.username)}`).join(", ") || "none";
}

/** An issue in one line: state, assignees, labels, due date, milestone, confidential. */
function workIssueLine(issue: JsonObject): string {
	const labels = Array.isArray(issue.labels) ? issue.labels.map(ciText).join(", ") : "";
	return [
		ciText(issue.state),
		`assignee ${workUsers(issue.assignees)}`,
		`labels ${labels || "none"}`,
		issue.due_date ? `due ${ciText(issue.due_date)}` : "",
		isObject(issue.milestone) ? `milestone ${ciText(issue.milestone.title)}` : "",
		issue.confidential === true ? "confidential" : "",
	]
		.filter(Boolean)
		.join(" · ");
}

/** A merge request in one line: branches, merge status, people, labels, and what happens at the merge. */
function workMrLine(mr: JsonObject): string {
	const labels = Array.isArray(mr.labels) ? mr.labels.map(ciText).join(", ") : "";
	return [
		`${ciText(mr.source_branch)} → ${ciText(mr.target_branch)}`,
		ciText(mr.state),
		`merge status ${ciText(mr.detailed_merge_status) || ciText(mr.merge_status) || "unknown"}`,
		`assignee ${workUsers(mr.assignees)}`,
		`reviewer ${workUsers(mr.reviewers)}`,
		`labels ${labels || "none"}`,
		mr.draft === true ? "draft" : "",
		mr.squash === true ? "squash" : "",
		mr.force_remove_source_branch === true || mr.should_remove_source_branch === true ? "removes the source branch" : "",
	]
		.filter(Boolean)
		.join(" · ");
}

const LabelsParam = (description: string) =>
	Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description }));

const WorkParams = {
	action: StringEnum(WORK_ACTIONS, {
		description:
			"issue_template: a project's issue templates, or one's content; issue_create: an issue, assigned and in the current iteration; issue_update: change an issue, its iteration too; issue_view: an issue with its notes, merge requests, links, and iteration; mr_create: a merge request, or the open one of its source branch; mr_merge: merge once mergeable, or set auto-merge; deployed: what each environment runs",
	}),
	project: Type.Optional(
		Type.String({
			description:
				"group/project, its id, or a web URL of the project or of one of its issues or merge requests (which gives iid); default the project of the working directory's origin remote",
		}),
	),
	iid: Type.Optional(Type.Integer({ description: "issue_update, issue_view: the issue's iid; mr_merge: the merge request's iid" })),
	template: Type.Optional(
		Type.String({
			description:
				"issue_template: the template to show (without it, the list); issue_create: the template the description follows, its headings checked in order",
		}),
	),
	title: Type.Optional(Type.String({ description: "issue_create, mr_create (required), issue_update: the title" })),
	description: Type.Optional(Type.String({ description: "issue_create, issue_update, mr_create: the description, Markdown" })),
	descriptionFile: Type.Optional(
		Type.String({ description: "Instead of description, the path of a local UTF-8 file holding it, for a long text" }),
	),
	assignee: Type.Optional(
		Type.String({
			description:
				"Username or user id, several separated by commas, or none; issue_create and mr_create default to the token's own user",
		}),
	),
	reviewer: Type.Optional(Type.String({ description: "mr_create: username or user id, several separated by commas" })),
	labels: LabelsParam("issue_create, mr_create: the labels; issue_update: replaces all labels"),
	add_labels: LabelsParam("issue_update: labels to add"),
	remove_labels: LabelsParam("issue_update: labels to remove"),
	iteration: Type.Optional(
		Type.String({
			description:
				"issue_create (default current), issue_update: current (the group's current iteration, set only when there is exactly one), none (create: skip; update: unset), or an iteration's gid or id",
		}),
	),
	due_date: Type.Optional(Type.String({ description: "issue_create, issue_update: YYYY-MM-DD" })),
	milestone_id: Type.Optional(Type.Integer({ description: "issue_create, issue_update: the milestone's id" })),
	confidential: Type.Optional(Type.Boolean({ description: "issue_create, issue_update: confidential or not" })),
	state_event: Type.Optional(StringEnum(["close", "reopen"] as const, { description: "issue_update: close or reopen the issue" })),
	source_branch: Type.Optional(Type.String({ description: "mr_create: the branch to merge (required), pushed already" })),
	target_branch: Type.Optional(Type.String({ description: "mr_create: the branch to merge into; default the default branch" })),
	remove_source_branch: Type.Optional(
		Type.Boolean({ description: "mr_create (default true), mr_merge: remove the source branch with the merge" }),
	),
	squash: Type.Optional(
		Type.Boolean({ description: "mr_create (default the project's setting), mr_merge: squash the commits at the merge" }),
	),
	draft: Type.Optional(Type.Boolean({ description: "mr_create: create it as a draft" })),
	sha: Type.Optional(
		Type.String({ description: "mr_merge: merge only if the head of the source branch is this commit (or starts so)" }),
	),
	when_pipeline_succeeds: Type.Optional(
		Type.Boolean({ description: "mr_merge: with a pipeline still running, set auto-merge and return instead of waiting" }),
	),
	wait_for_pipeline: Type.Optional(
		Type.Boolean({
			description:
				"mr_merge: with a pipeline still running, wait here for it (within timeout); without it or when_pipeline_succeeds the call reports the pipeline and merges nothing",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: `mr_merge: minutes to wait for a mergeable status (default ${WORK_MERGE_TIMEOUT_MIN}, at most ${WORK_MAX_MERGE_TIMEOUT_MIN})`,
		}),
	),
	contains: Type.Optional(
		Type.String({ description: "deployed: a commit sha, tag, or branch: whether each deployment contains it" }),
	),
	jobs: Type.Optional(
		Type.String({
			description:
				"deployed, for a project without environments: a regular expression (case-insensitive) for the names of the deploy jobs; default deploy",
		}),
	),
};

function workParameters(instances: Instance[]) {
	const all = Type.Object({ host: Type.Optional(hostParameter(instances, "GitLab")), ...WorkParams });
	return instances.length > 1 ? all : (Type.Object(WorkParams) as unknown as typeof all);
}

/** What a call does about an issue's iteration: set gid (null unsets it), or name the candidates, or note why not. */
type IterationPlan = { gid?: string | null; candidates?: JsonObject[]; note?: string };

function registerWorkTool(pi: ExtensionAPI, instances: Instance[]): void {
	/** The token's own user of each instance, asked once a session. */
	const selves = new Map<string, Promise<JsonObject>>();

	pi.registerTool({
		name: "gitlab_work",
		label: "GitLab work",
		description:
			"Do in one call what takes several gitlab calls, with the gitlab tool's instances and tokens. issue_template: a " +
			"project's issue templates, or the content of one. issue_create: an issue, assigned to the token's user unless " +
			"assignee says otherwise, in the group's current iteration (several current ones: none is set, they are listed); " +
			"with template, the description must keep the template's headings in order, or nothing is created. issue_update: " +
			"title, description, labels (all, or add/remove), assignee, state, due date, milestone, confidential, and the " +
			"iteration (current, none, or a gid) in one call. issue_view: the issue with its notes (without system notes, " +
			"the newest last), related merge requests, linked issues, and iteration. mr_create: a merge request from " +
			"source_branch into target_branch (default the default branch), assigned to the token's user, removing the " +
			"source branch at the merge; an open one of that branch is returned instead. mr_merge: waits without model " +
			"requests while GitLab checks mergeability (at most timeout minutes), then merges; when_pipeline_succeeds sets " +
			"auto-merge while the pipeline runs; a blocking status (conflicts, open threads, approvals, draft, failed " +
			"pipeline, …) is reported at once. deployed: the last successful deployment of each environment (ref, sha, " +
			"when, by, job), or without environments the latest successful job of each name matching jobs; contains tells " +
			"whether each runs a commit, tag, or branch. The project defaults to the one of the working directory's origin " +
			"remote; a web URL of an issue or merge request in project gives iid.",
		promptSnippet: "GitLab work in one call: issue templates, create/update/view issues with iteration, create and merge MRs, deployed",
		promptGuidelines: [
			"Use gitlab_work instead of several gitlab calls for issue templates, creating, updating, and reading issues (with notes, merge requests, links, and iteration), creating and merging merge requests, and what is deployed where; the gitlab tool stays for everything else.",
			"gitlab_work: issue_create, issue_update, and mr_create only for what the user asked for; mr_merge only with the user's approval of that merge or a standing one, never because the merge request looks ready.",
			"gitlab_work: for an issue from a template, read the template first (issue_template with template), fill in its sections under its headings, and pass template to issue_create, which refuses a description that drops or reorders them.",
			"gitlab_work: issue_create sets the current iteration by itself; when it lists several current iterations and sets none, set one with issue_update only where the user or the project's convention says which.",
			"gitlab_work: mr_merge with a pipeline still running reports it and merges nothing; when_pipeline_succeeds (auto-merge) or wait_for_pipeline (wait here) only as the user wants the merge done.",
		],
		parameters: workParameters(instances),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },

		async execute(_id, params, signal, onUpdate, ctx) {
			const action = params.action as WorkAction;
			const target = ciTarget(instances, params.host as string | undefined, params.project, ctx.cwd);
			const { instance } = target;
			const P = target.project;
			const label = decodeURIComponent(P);
			const details = { host: instance.name, project: label, action };
			const token = await resolveToken(
				instance,
				CONFIG_FILE,
				`Create a personal access token in ${instance.base} under User settings → Personal access tokens (scope api, or read_api to read only)`,
				signal,
			);
			const mask = masker([token]);
			const api = (method: "GET" | "POST" | "PUT", path: string, query?: Record<string, unknown>, body?: unknown) =>
				apiRequest(instance, token, method, path, query, body, signal, mask);
			const get = async (path: string, query?: Record<string, unknown>) => apiJson(await api("GET", path, query), mask);
			const write = async (method: "POST" | "PUT", path: string, body: unknown) =>
				apiJson(await api(method, path, undefined, body), mask);
			const graphql = async (query: string, variables: Record<string, unknown>): Promise<JsonObject> => {
				const answer = ciObject(apiJson(await api("POST", instance.graphql, undefined, { query, variables }), mask), "JSON");
				const errors = Array.isArray(answer.errors) ? answer.errors.map((error) => ciText(isObject(error) ? error.message : error)) : [];
				if (errors.length > 0) throw new Error(`GraphQL: ${ciOneLine(errors.join("; "), 300)}`);
				return isObject(answer.data) ? answer.data : {};
			};
			let project: Promise<JsonObject> | undefined;
			const projectInfo = () => (project ??= get(`/projects/${P}`).then((json) => ciObject(json, "a project")));
			// GraphQL names a project by its full path only.
			const fullPath = async () => (/^\d+$/.test(P) ? ciText((await projectInfo()).path_with_namespace) : label);
			const ownUser = () => {
				let me = selves.get(instance.name);
				if (!me) {
					me = get("/user").then((json) => ciObject(json, "a user"));
					selves.set(instance.name, me);
					me.catch(() => selves.delete(instance.name));
				}
				return me;
			};
			// The user ids of assignee or reviewer: the token's own user when not given and self, none for "none".
			const people = async (given: string | undefined, self: boolean): Promise<number[] | undefined> => {
				const wanted = given?.trim() ?? "";
				if (!wanted) return self ? [Number((await ownUser()).id)] : undefined;
				if (wanted.toLowerCase() === "none") return [];
				return Promise.all(
					wanted
						.split(",")
						.map((item) => item.trim())
						.filter(Boolean)
						.map(async (item) => {
							if (/^\d+$/.test(item)) return Number(item);
							const username = item.replace(/^@/, "");
							const list = await get("/users", { username });
							const user = Array.isArray(list) ? list.find(isObject) : undefined;
							if (!user) throw new Error(`there is no user @${username} on ${instance.name}: give a username or a user id`);
							return Number(user.id);
						}),
				);
			};
			const description = workDescription(params.description, params.descriptionFile);

			const templateOf = async (name: string): Promise<string> => {
				try {
					const template = ciObject(await get(`/projects/${P}/templates/issues/${encodeURIComponent(name)}`), "a template");
					return ciText(template.content);
				} catch (error) {
					if ((error as { status?: number }).status !== 404) throw error;
					const names = await templateNames().catch(() => []);
					throw new Error(`${label} has no issue template ${name}; its templates: ${names.join(", ") || "none"}`);
				}
			};
			const templateNames = async (): Promise<string[]> => {
				const list = await get(`/projects/${P}/templates/issues`, { per_page: 100 });
				return (Array.isArray(list) ? list.filter(isObject) : []).map((item) => ciText(item.name ?? item.key));
			};

			const planIteration = async (given: string): Promise<IterationPlan> => {
				const value = given.trim();
				if (value.toLowerCase() === "none") return { gid: null };
				if (value.toLowerCase() !== "current") {
					const id = /^\d+$/.test(value) ? value : /^gid:\/\/gitlab\/Iteration\/(\d+)$/.exec(value)?.[1];
					if (!id) throw new Error(`iteration ${given}: give current, none, or an iteration's gid (gid://gitlab/Iteration/<id>) or id`);
					return { gid: `gid://gitlab/Iteration/${id}` };
				}
				let data: JsonObject;
				try {
					data = await graphql(CURRENT_ITERATIONS_QUERY, { path: await fullPath() });
				} catch (error) {
					return { note: `none set, the current one is not found (${workMessage(error)})` };
				}
				if (!isObject(data.project)) return { note: `none set, GraphQL does not find ${await fullPath()}` };
				const group = data.project.group;
				if (!isObject(group)) return { note: "none, the project is not in a group" };
				const nodes = isObject(group.iterations) && Array.isArray(group.iterations.nodes) ? group.iterations.nodes.filter(isObject) : [];
				if (nodes.length === 0) return { note: "none, the group has no current iteration" };
				return nodes.length === 1 ? { gid: ciText(nodes[0].id) } : { candidates: nodes };
			};
			// Carries out a plan for issue iid, in words for the answer; a failure is told, the rest being done by then.
			const applyIteration = async (plan: IterationPlan, iid: number): Promise<string> => {
				if (plan.candidates) {
					const list = plan.candidates.map((candidate) => `  ${workIteration(candidate)}`).join("\n");
					return `iteration: none set, the project has ${plan.candidates.length} current iterations; set one with issue_update iteration: <gid>\n${list}`;
				}
				if (plan.gid === undefined) return `iteration: ${plan.note ?? "unchanged"}`;
				try {
					const data = await graphql(SET_ITERATION_MUTATION, { path: await fullPath(), iid: String(iid), iteration: plan.gid });
					const result = isObject(data.issueSetIteration) ? data.issueSetIteration : {};
					const errors = Array.isArray(result.errors) ? result.errors.map(ciText).filter(Boolean) : [];
					if (errors.length > 0) throw new Error(errors.join("; "));
					const set = isObject(result.issue) && isObject(result.issue.iteration) ? result.issue.iteration : undefined;
					return `iteration: ${set ? workIteration(set) : "none"}`;
				} catch (error) {
					return `iteration: NOT set (${workMessage(error)}); the rest is done`;
				}
			};

			let head: string;
			let body = "";
			let isError = false;
			switch (action) {
				case "issue_template": {
					const name = params.template?.trim();
					if (name) {
						head = `Issue template ${name} of ${label}:`;
						body = await templateOf(name);
					} else {
						const names = await templateNames();
						head = names.length > 0 ? `Issue templates of ${label} (${names.length}):` : `${label} has no issue templates.`;
						body = names.join("\n");
					}
					break;
				}
				case "issue_create": {
					const title = params.title?.trim();
					if (!title) throw new Error("issue_create needs title");
					const templateName = params.template?.trim();
					let checked = "";
					if (templateName) {
						const content = await templateOf(templateName);
						const headings = workHeadings(content);
						const missing = workMissingHeadings(content, description ?? "");
						if (missing.length > 0) {
							throw new Error(
								`the description lacks ${missing.length} of the ${headings.length} headings of template ${templateName}, or has them ` +
									`out of order: ${missing.join(" | ")}. Nothing was created: keep every heading of the template in its order ` +
									"(issue_template with template shows it) and fill in its sections.",
							);
						}
						checked = `template ${templateName}: all ${headings.length} headings in order`;
					}
					const iteration = params.iteration?.trim() || "current";
					const [assignees, plan] = await Promise.all([
						people(params.assignee, true),
						iteration.toLowerCase() === "none" ? undefined : planIteration(iteration),
					]);
					const issue = ciObject(
						await write("POST", `/projects/${P}/issues`, {
							title,
							description,
							assignee_ids: assignees?.length ? assignees : undefined,
							labels: workLabels(params.labels),
							due_date: params.due_date,
							milestone_id: params.milestone_id,
							confidential: params.confidential,
						}),
						"an issue",
					);
					const iterationLine = plan ? await applyIteration(plan, Number(issue.iid)) : "iteration: none, skipped as asked";
					head = `Created issue #${ciText(issue.iid)}: ${ciText(issue.title)}\n${ciText(issue.web_url)}`;
					body = [workIssueLine(issue), iterationLine, checked].filter(Boolean).join("\n");
					break;
				}
				case "issue_update": {
					const iid = params.iid ?? target.issue;
					if (iid === undefined) throw new Error("issue_update needs iid, or a web URL of the issue as project");
					const [assignees, plan] = await Promise.all([
						people(params.assignee, false),
						params.iteration?.trim() ? planIteration(params.iteration) : undefined,
					]);
					const changes: Record<string, unknown> = {
						title: params.title?.trim() || undefined,
						description,
						assignee_ids: assignees,
						labels: workLabels(params.labels),
						add_labels: workLabels(params.add_labels),
						remove_labels: workLabels(params.remove_labels),
						state_event: params.state_event,
						due_date: params.due_date,
						milestone_id: params.milestone_id,
						confidential: params.confidential,
					};
					for (const key of Object.keys(changes)) if (changes[key] === undefined) delete changes[key];
					if (Object.keys(changes).length === 0 && !plan) {
						throw new Error(
							"issue_update has nothing to change: give title, description, labels, add_labels, remove_labels, assignee, state_event, due_date, milestone_id, confidential, or iteration",
						);
					}
					const path = `/projects/${P}/issues/${iid}`;
					let issue = Object.keys(changes).length > 0 ? ciObject(await write("PUT", path, changes), "an issue") : undefined;
					const iterationLine = plan ? await applyIteration(plan, iid) : "";
					issue ??= ciObject(await get(path), "an issue");
					const current = isObject(issue.iteration) ? `iteration: ${workIteration(issue.iteration)}` : "";
					head = `Updated issue #${ciText(issue.iid)}: ${ciText(issue.title)}\n${ciText(issue.web_url)}`;
					body = [workIssueLine(issue), iterationLine || current].filter(Boolean).join("\n");
					break;
				}
				case "issue_view": {
					const iid = params.iid ?? target.issue;
					if (iid === undefined) throw new Error("issue_view needs iid, or a web URL of the issue as project");
					const path = `/projects/${P}/issues/${iid}`;
					const [found, notes, mrs, links] = await Promise.allSettled([
						get(path).then((json) => ciObject(json, "an issue")),
						get(`${path}/notes`, { per_page: 100, sort: "desc", order_by: "created_at" }),
						get(`${path}/related_merge_requests`, { per_page: 100 }),
						get(`${path}/links`),
					]);
					signal?.throwIfAborted();
					if (found.status === "rejected") throw found.reason;
					const issue = found.value;
					const list = (json: Json) => (Array.isArray(json) ? json.filter(isObject) : []);
					const sections: string[] = [];
					const add = <T>(title: string, result: PromiseSettledResult<T>, render: (value: T) => { title: string; lines: string[] }) => {
						if (result.status === "rejected") {
							sections.push(`${title}\nError: ${workMessage(result.reason)}`);
							return;
						}
						const shown = render(result.value);
						sections.push([shown.title, ...shown.lines].join("\n"));
					};
					const { _links: _, ...rest } = issue;
					sections.push(`Issue\n${JSON.stringify(fold(rest, "top") ?? null, null, 1)}`);
					add("Notes", notes, (json) => {
						const own = list(json).filter((note) => note.system !== true);
						const total = typeof issue.user_notes_count === "number" ? Math.max(issue.user_notes_count, own.length) : own.length;
						const shown = own.slice(0, WORK_NOTES).reverse();
						const older = total - shown.length;
						return {
							title:
								total === 0
									? "Notes: none (system notes left out)"
									: `Notes: ${shown.length} of ${total}, the newest last (system notes left out${older > 0 ? `, the ${older} oldest too` : ""})`,
							lines: shown.map((note) => {
								const author = isObject(note.author) ? `@${ciText(note.author.username)}` : "?";
								return `— ${author}, ${ciTime(note.created_at)} (note ${ciText(note.id)}):\n${cut(ciText(note.body).trim(), WORK_NOTE_CHARS)}`;
							}),
						};
					});
					const where = (item: JsonObject, mark: string) =>
						item.project_id !== issue.project_id && isObject(item.references) ? ciText(item.references.full) : `${mark}${ciText(item.iid)}`;
					add("Related merge requests", mrs, (json) => {
						const items = list(json);
						return {
							title: `Related merge requests: ${items.length}`,
							lines: items.map((mr) => `${where(mr, "!")} ${ciText(mr.state)}  ${ciText(mr.title)}  ${ciText(mr.web_url)}`),
						};
					});
					add("Linked issues", links, (json) => {
						const items = list(json);
						return {
							title: `Linked issues: ${items.length}`,
							lines: items.map(
								(item) =>
									`${where(item, "#")} ${ciText(item.state)} ${ciText(item.link_type)}  ${ciText(item.title)}  ${ciText(item.web_url)}`,
							),
						};
					});
					// REST of GitLab EE carries the iteration (null for none); without the field, GraphQL is asked.
					const iterationOf = async (): Promise<Json> => {
						if ("iteration" in issue) return issue.iteration;
						const data = await graphql(ISSUE_ITERATION_QUERY, { path: await fullPath(), iid: String(iid) });
						return isObject(data.project) && isObject(data.project.issue) ? (data.project.issue.iteration ?? null) : null;
					};
					const [iteration] = await Promise.allSettled([iterationOf()]);
					add("Iteration", iteration, (value) => ({
						title: `Iteration: ${isObject(value) ? workIteration(value) : "none"}`,
						lines: [],
					}));
					head = `Issue #${ciText(issue.iid)} of ${label}`;
					body = sections.join("\n\n");
					break;
				}
				case "mr_create": {
					const source = params.source_branch?.trim();
					const title = params.title?.trim();
					if (!source || !title) throw new Error("mr_create needs source_branch (pushed already) and title");
					const [info, assignees, reviewers] = await Promise.all([
						projectInfo(),
						people(params.assignee, true),
						people(params.reviewer, false),
					]);
					const into = params.target_branch?.trim() || ciText(info.default_branch);
					if (!into) throw new Error(`${label} has no default branch: give target_branch`);
					const draft = params.draft === true && !/^(draft:|\[draft\]|\(draft\))/i.test(title);
					const request = {
						source_branch: source,
						target_branch: into,
						title: draft ? `Draft: ${title}` : title,
						description,
						assignee_ids: assignees,
						reviewer_ids: reviewers,
						labels: workLabels(params.labels),
						remove_source_branch: params.remove_source_branch ?? true,
						squash: params.squash ?? ["always", "default_on"].includes(ciText(info.squash_option)),
					};
					let mr: JsonObject | undefined;
					let note = "";
					for (let attempt = 1; !mr; attempt++) {
						try {
							mr = ciObject(await write("POST", `/projects/${P}/merge_requests`, request), "a merge request");
						} catch (error) {
							const status = (error as { status?: number }).status ?? 0;
							const detail = (error as { detail?: string }).detail ?? "";
							if (status === 409) {
								const open = await get(`/projects/${P}/merge_requests`, { state: "opened", source_branch: source, per_page: 20 });
								mr = Array.isArray(open) ? open.find(isObject) : undefined;
								if (!mr) throw error;
								note = `An open merge request of ${source} exists already; nothing was created, here it is.`;
							} else if (status >= 400 && status < 500 && /source[ _]branch/i.test(detail) && /exist/i.test(detail)) {
								if (attempt > 1) {
									throw new Error(`${workMessage(error)} — GitLab does not know ${source}, also after a second try: push it first (git push -u origin ${source})`);
								}
								await workSleep(WORK_BRANCH_RETRY_MS, signal);
								note = `GitLab did not know ${source} at first; created at the second try.`;
							} else {
								throw error;
							}
						}
					}
					const existing = note.startsWith("An open");
					head = `${existing ? "Found" : "Created"} merge request !${ciText(mr.iid)}: ${ciText(mr.title)}\n${ciText(mr.web_url)}`;
					body = [workMrLine(mr), note].filter(Boolean).join("\n");
					break;
				}
				case "mr_merge": {
					const iid = params.iid ?? target.mr;
					if (iid === undefined) throw new Error("mr_merge needs iid, or a web URL of the merge request as project");
					const path = `/projects/${P}/merge_requests/${iid}`;
					const mrOf = async () => ciObject(await get(path), "a merge request");
					const timeoutMs = Math.min(Math.max(params.timeout ?? WORK_MERGE_TIMEOUT_MIN, 0.1), WORK_MAX_MERGE_TIMEOUT_MIN) * 60_000;
					const started = Date.now();
					const span = () => ciDuration((Date.now() - started) / 1000) || "0s";
					const auto = params.when_pipeline_succeeds === true;
					const pipelineOf = (mr: JsonObject) => (isObject(mr.head_pipeline) ? mr.head_pipeline : undefined);
					const blocked = (mr: JsonObject, status: string) => {
						const pipeline = pipelineOf(mr);
						const ci = status.startsWith("ci_") && pipeline ? ` (pipeline ${ciText(pipeline.id)} ${ciText(pipeline.status)})` : "";
						return `!${iid} not merged, ${status}: ${MERGE_BLOCKS[status] ?? "GitLab reports this status"}${ci}.\n${ciText(mr.web_url)}`;
					};
					const mergedText = async (mr: JsonObject, already: boolean): Promise<string> => {
						const commit = ciText(mr.merge_commit_sha)
							? `merge commit ${ciText(mr.merge_commit_sha).slice(0, 8)}`
							: ciText(mr.squash_commit_sha)
								? `squash commit ${ciText(mr.squash_commit_sha).slice(0, 8)}`
								: `fast-forward to ${ciText(mr.sha).slice(0, 8)}`;
						const source = ciText(mr.source_branch);
						let branch = `source branch ${source} kept`;
						if (mr.force_remove_source_branch === true || mr.should_remove_source_branch === true) {
							const sourceProject = ciText(mr.source_project_id) || P;
							branch = await api("GET", `/projects/${sourceProject}/repository/branches/${encodeURIComponent(source)}`).then(
								() => `source branch ${source} still there, to be removed`,
								(error) => ((error as { status?: number }).status === 404 ? `source branch ${source} removed` : `source branch ${source}: ${workMessage(error)}`),
							);
						}
						const by = already && isObject(mr.merged_by) ? ` by @${ciText(mr.merged_by.username)}` : "";
						const when = already && mr.merged_at ? ` on ${ciTime(mr.merged_at)}` : "";
						return `${already ? "Already merged" : "Merged"} !${iid} into ${ciText(mr.target_branch)}${by}${when}: ${commit}; ${branch}.\n${ciText(mr.web_url)}`;
					};
					const merge = async (): Promise<string> => {
						let mr = await mrOf();
						for (let checks = 1; ; checks++) {
							if (mr.state === "merged") return mergedText(mr, true);
							if (mr.state !== "opened") {
								isError = true;
								return `!${iid} not merged: it is ${ciText(mr.state)}.\n${ciText(mr.web_url)}`;
							}
							const sha = params.sha?.trim();
							if (sha && !ciText(mr.sha).startsWith(sha)) {
								isError = true;
								return `!${iid} not merged: its head is ${ciText(mr.sha).slice(0, 8)}, not ${sha}. Review the new commits; merge then with that sha.`;
							}
							const status = ciText(mr.detailed_merge_status);
							const pipeline = pipelineOf(mr);
							const running =
								status === "ci_still_running" || (status === "ci_must_pass" && pipeline !== undefined && CI_ACTIVE.has(ciText(pipeline.status)));
							if (status === "mergeable" || (auto && running)) break;
							if (running && params.wait_for_pipeline !== true) {
								const which = pipeline ? `pipeline ${ciText(pipeline.id)} is still ${ciText(pipeline.status)}` : "its pipeline is still running";
								return `!${iid} not merged yet: ${which}. Give when_pipeline_succeeds: true to set auto-merge, or wait_for_pipeline: true to wait here.\n${ciText(mr.web_url)}`;
							}
							if (!running && !MERGE_PENDING.has(status)) {
								isError = true;
								return blocked(mr, status);
							}
							if (Date.now() - started >= timeoutMs) {
								isError = true;
								return `Gave up after ${span()} (${checks} checks): !${iid} is still ${status}; nothing merged. Call mr_merge again to go on.`;
							}
							onUpdate?.({ content: [{ type: "text", text: mask(`${span()}, ${checks} checks: !${iid} ${status}`) }], details });
							await workSleep(Math.min(WORK_MERGE_EVERY_MS, Math.max(timeoutMs - (Date.now() - started), 0)), signal);
							mr = await mrOf();
						}
						const request = {
							sha: ciText(mr.sha),
							squash: params.squash,
							should_remove_source_branch: params.remove_source_branch,
							// auto_merge since GitLab 17.11; merge_when_pipeline_succeeds for older ones.
							...(auto ? { auto_merge: true, merge_when_pipeline_succeeds: true } : {}),
						};
						let result: JsonObject;
						try {
							result = ciObject(await write("PUT", `${path}/merge`, request), "a merge request");
						} catch (error) {
							const status = (error as { status?: number }).status ?? 0;
							if (![405, 406, 409, 422].includes(status)) throw error;
							const now = await mrOf();
							if (now.state === "merged") return mergedText(now, false);
							isError = true;
							const detail = (error as { detail?: string }).detail ?? "";
							const state = ciText(now.detailed_merge_status) || ciText(now.state);
							const why = MERGE_BLOCKS[state] ? `: ${MERGE_BLOCKS[state]}` : "";
							return `GitLab refused the merge of !${iid} (HTTP ${status}${detail ? `: ${ciOneLine(detail, 200)}` : ""}); it now reports ${state}${why}.\n${ciText(now.web_url)}`;
						}
						if (result.state === "merged") return mergedText(result, false);
						if (auto && (result.merge_when_pipeline_succeeds === true || result.auto_merge_enabled === true)) {
							const pipeline = pipelineOf(result) ?? pipelineOf(mr);
							const which = pipeline ? `pipeline ${ciText(pipeline.id)}` : "its pipeline";
							return `Auto-merge set: !${iid} merges into ${ciText(result.target_branch)} once ${which} succeeds.\n${ciText(result.web_url)}`;
						}
						// GitLab took the merge and finishes it in the background.
						while (Date.now() - started < timeoutMs) {
							await workSleep(WORK_MERGE_EVERY_MS, signal);
							result = await mrOf();
							if (result.state === "merged") return mergedText(result, false);
						}
						isError = true;
						return `GitLab took the merge of !${iid} but has not finished it after ${span()}; mr_merge again tells whether it is merged.\n${ciText(result.web_url)}`;
					};
					head = await merge();
					break;
				}
				case "deployed": {
					const wanted = params.contains?.trim();
					let containsSha = "";
					if (wanted) {
						try {
							containsSha = ciText(ciObject(await get(`/projects/${P}/repository/commits/${encodeURIComponent(wanted)}`), "a commit").id);
						} catch (error) {
							if ((error as { status?: number }).status !== 404) throw error;
							throw new Error(`contains: ${wanted} is no commit, tag, or branch of ${label}; give a sha, a tag, or a branch`);
						}
					}
					// Whether a deployed commit contains the wanted one: it is that commit or descends from it.
					const verdicts = new Map<string, Promise<string>>();
					const contains = (sha: string): Promise<string> => {
						if (!containsSha || !sha) return Promise.resolve("");
						if (sha === containsSha) return Promise.resolve("✓");
						let verdict = verdicts.get(sha);
						if (!verdict) {
							verdict = get(`/projects/${P}/repository/merge_base`, { refs: [sha, containsSha] }).then(
								(json) => (ciText(ciObject(json, "a commit").id) === containsSha ? "✓" : "✗"),
								(error) => `? ${ciOneLine(workMessage(error), 120)}`,
							);
							verdicts.set(sha, verdict);
						}
						return verdict;
					};
					type Row = { name: string; ref: string; sha: string; when: string; by: string; job?: string };
					const environments = await get(`/projects/${P}/environments`, { states: "available", per_page: 100 });
					const envs = Array.isArray(environments) ? environments.filter(isObject) : [];
					let rows: Row[];
					if (envs.length > 0) {
						rows = await Promise.all(
							envs.slice(0, WORK_ENVIRONMENTS).map(async (env): Promise<Row> => {
								const name = ciText(env.name);
								try {
									const list = await get(`/projects/${P}/deployments`, {
										environment: name,
										status: "success",
										order_by: "finished_at",
										sort: "desc",
										per_page: 1,
									});
									const deployment = Array.isArray(list) ? list.find(isObject) : undefined;
									if (!deployment) return { name, ref: "", sha: "", when: "no successful deployment", by: "", job: "" };
									const job = isObject(deployment.deployable) ? deployment.deployable : {};
									const user = isObject(deployment.user) ? `@${ciText(deployment.user.username)}` : "";
									return {
										name,
										ref: ciText(deployment.ref),
										sha: ciText(deployment.sha),
										when: ciTime(job.finished_at ?? deployment.updated_at),
										by: user,
										job: ciText(job.name),
									};
								} catch (error) {
									return { name, ref: "", sha: "", when: `error: ${ciOneLine(workMessage(error), 200)}`, by: "", job: "" };
								}
							}),
						);
						const more = envs.length > WORK_ENVIRONMENTS ? `, the first ${WORK_ENVIRONMENTS} shown` : "";
						head = `Deployments of ${label}, the last successful one of each of its ${envs.length} environments${more}:`;
					} else {
						const pattern = params.jobs?.trim() || "deploy";
						let regex: RegExp;
						try {
							regex = new RegExp(pattern, "i");
						} catch (error) {
							throw new Error(`jobs is not a valid regular expression: ${workMessage(error)}`);
						}
						const path = await fullPath();
						// The jobs come newest first: the first of a name is its latest.
						const newest = new Map<string, JsonObject>();
						let seen = 0;
						let after: string | null = null;
						for (let page = 1; page <= WORK_JOB_PAGES; page++) {
							const data = await graphql(DEPLOY_JOBS_QUERY, { path, after });
							if (!isObject(data.project)) throw new Error(`GraphQL does not find ${path}`);
							const jobs = isObject(data.project.jobs) ? data.project.jobs : {};
							for (const node of Array.isArray(jobs.nodes) ? jobs.nodes.filter(isObject) : []) {
								seen++;
								const name = ciText(node.name);
								if (regex.test(name) && !newest.has(name)) newest.set(name, node);
							}
							const info = isObject(jobs.pageInfo) ? jobs.pageInfo : {};
							if (info.hasNextPage !== true) break;
							after = ciText(info.endCursor);
						}
						if (newest.size === 0) {
							throw new Error(
								`${label} has no environments, and none of its last ${seen} successful jobs matches /${pattern}/i: give jobs, a regular expression for the names of its deploy jobs`,
							);
						}
						rows = [...newest.values()]
							.map((node) => {
								const pipeline = isObject(node.pipeline) ? node.pipeline : {};
								return {
									name: ciText(node.name),
									ref: ciText(node.refName),
									sha: ciText(pipeline.sha),
									when: ciTime(node.finishedAt),
									by: isObject(pipeline.user) ? `@${ciText(pipeline.user.username)}` : "",
								};
							})
							.sort((a, b) => a.name.localeCompare(b.name));
						head = `${label} has no environments; the latest successful job of each name matching /${pattern}/i among its last ${seen} successful jobs:`;
					}
					const marks = await Promise.all(rows.map((row) => contains(row.sha)));
					const environmentsShown = envs.length > 0;
					const header = [environmentsShown ? "environment" : "job", "ref", "sha", environmentsShown ? "deployed" : "finished", "by"];
					if (environmentsShown) header.push("job");
					if (containsSha) header.push(`contains ${wanted === containsSha ? containsSha.slice(0, 8) : wanted}`);
					const table = rows.map((row, index) => {
						const cells = [row.name, row.ref, row.sha.slice(0, 8), row.when, row.by];
						if (environmentsShown) cells.push(row.job ?? "");
						if (containsSha) cells.push(marks[index]);
						return cells;
					});
					body = ciColumns([header, ...table]);
					break;
				}
				default:
					throw new Error(`unknown action ${String(action)}`);
			}
			return { content: [{ type: "text", text: limited(mask(head), mask(body), false) }], details, isError };
		},

		renderCall(args, theme) {
			const host = args.host as string | undefined;
			const mark = String(args.action ?? "").startsWith("mr_") ? "!" : "#";
			const which = [
				args.project,
				args.iid !== undefined ? `${mark}${args.iid}` : undefined,
				args.template,
				args.source_branch ? `${args.source_branch}${args.target_branch ? ` → ${args.target_branch}` : ""}` : undefined,
				args.title ? `"${ciOneLine(String(args.title), 60)}"` : undefined,
				args.contains ? `contains ${args.contains}` : undefined,
			].filter((part) => part !== undefined && part !== "");
			return new Text(
				theme.fg("toolTitle", theme.bold("gitlab_work ")) +
					(host ? theme.fg("muted", `${host} `) : "") +
					theme.fg("muted", `${args.action ?? "?"}${which.length > 0 ? " " : ""}`) +
					theme.fg("accent", which.join(" ")) +
					(args.action === "mr_merge" && args.when_pipeline_succeeds ? theme.fg("dim", " (auto-merge)") : ""),
				0,
				0,
			);
		},
	});
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
			"issues, /search, /user. path also takes a web URL of the instance, read as its API path: a project, a merge " +
			"request, issue, or work item, a pipeline, a job, a commit, a file (/-/blob/<ref>/<file>, a ref without " +
			"slashes), or a tree. overview: true with a GET of one merge request adds its approvals, latest pipelines, " +
			"open discussions, and changed files (paths only) in one result. Lists take per_page (up to 100) and page; a " +
			"line above the body gives the page, the total, and the href of the next page. The endpoint of the GraphQL " +
			"API is /api/graphql, not below /api/v4; " +
			"it takes POST {\"query\": …, \"variables\": …}, for what " +
			"REST lacks, such as setting an issue's iteration (issueSetIteration). REST JSON is folded: empty fields, " +
			"avatar URLs, and the _links of list items are left out, a user inside another resource or a list reads " +
			"\"Name (@username, id N)\", and a description in a list is cut; raw: true returns it unfolded. Tokens and " +
			"secret CI/CD variable values are always masked. File contents come as they are, job logs without colour " +
			"codes; binary content such as artifacts is saved to a temp file. files uploads local files as multipart/form-data, " +
			"e.g. a project avatar (PUT /projects/{id}, files {\"avatar\": path}) or an image for markdown (POST " +
			"/projects/{id}/uploads, files {\"file\": path}). fieldFiles takes body fields from local files so a secret " +
			"stays out of the call and the result (POST /projects/{id}/variables with body {\"key\": …} and fieldFiles " +
			"{\"value\": path}); the value is masked in the response. Output over " +
			`${formatSize(DEFAULT_MAX_BYTES)} is truncated (a job log keeps its end) and the full response saved to a ` +
			"temp file. Temp files are removed when the session ends.",
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
			"gitlab: send a secret (a CI/CD variable value, a token) with fieldFiles, a field name → the path of a 0600 temp file, never in body, so it stays out of the call, the result, and the transcript.",
		],
		parameters: parameters(instances),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },

		async execute(_id, params, signal) {
			const host = params.host as string | undefined;
			const web = webApiPath(instances, params.path);
			const instance = web?.instance ?? pickInstance(instances, host, params.path, owns, CONFIG_FILE);
			if (web && host?.trim() && pickInstance(instances, host, "", owns, CONFIG_FILE) !== web.instance) {
				throw new Error(`${params.path.trim()} is a page of ${web.instance.name}, not of host ${host}`);
			}
			const method = (params.method ?? "GET") as "GET" | "POST" | "PUT" | "DELETE";
			if (params.body !== undefined && (method === "GET" || method === "DELETE")) {
				throw new Error(`a ${method} request takes no body; send its parameters as query`);
			}
			const files = params.files as Record<string, string> | undefined;
			if (files !== undefined && method !== "POST" && method !== "PUT") throw new Error("files are uploaded with POST or PUT");
			const fieldFiles = params.fieldFiles as Record<string, string> | undefined;
			if (fieldFiles !== undefined && method !== "POST" && method !== "PUT") {
				throw new Error(`fieldFiles go in the body of POST or PUT, not of a ${method} request`);
			}
			const target = requestUrl(instance, web?.path ?? params.path, params.query as Record<string, unknown> | undefined);
			if (files !== undefined && target.pathname === instance.graphql) throw new Error("files cannot go to /api/graphql");
			const overview = params.overview === true;
			if (overview && (method !== "GET" || !MR_PATH.test(target.pathname.slice(instance.api.length)))) {
				throw new Error(
					"overview takes a GET of one merge request: /projects/{id}/merge_requests/{iid}, or its web URL …/-/merge_requests/{iid}",
				);
			}
			const fromFiles = fieldFiles !== undefined ? readFieldFiles(fieldFiles) : {};
			const sent =
				Object.keys(fromFiles).length > 0 ? { ...(params.body as Record<string, unknown> | undefined), ...fromFiles } : params.body;
			const payload: Payload | undefined =
				files !== undefined && Object.keys(files).length > 0
					? multipart(sent as Record<string, unknown> | undefined, files)
					: sent !== undefined
						? { contentType: "application/json", data: JSON.stringify(sent) }
						: undefined;
			const token = await resolveToken(
				instance,
				CONFIG_FILE,
				`Create a personal access token in ${instance.base} under User settings → Personal access tokens (scope api, or read_api to read only)`,
				signal,
			);
			if (overview) {
				const mask = masker([token]);
				const absolute = instance !== instances[0];
				const shown = await mrOverview(instance, token, target, params.raw === true, absolute, signal).catch((error: unknown) => {
					throw new Error(mask(error instanceof Error ? error.message : String(error)));
				});
				const details = {
					host: instance.name,
					method,
					path: target.pathname + target.search,
					status: 200,
					file: undefined as string | undefined,
				};
				return { content: [{ type: "text", text: limited(mask(shown.head), mask(shown.body), false) }], details, isError: false };
			}
			const { response, url } = await send(instance, token, method, target, payload, signal);
			const mask = masker([token, ...Object.values(fromFiles)]);
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

	if (toolWanted("work")) registerWorkTool(pi, instances);
	// The temp files of all three tools go with the session, whichever tools are on.
	pi.on("session_shutdown", () => removeTempDirs());
	if (!toolWanted("pipelines")) return;
	/** The background waits of the other tools, as "background-waits:state" brings them. */
	const otherWaits = new Map<string, BackgroundWaitView[]>();
	const allWaits = () => [...[...ciShared.waits.values()].map(ciView), ...[...otherWaits.values()].flat()];

	pi.on("session_start", (_event, ctx) => {
		ciShared.live = { pi, ctx, ready: false };
		otherWaits.clear();
		if (ciShared.ended.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Background waits of gitlab_pipeline in the previous session ended with it: ${ciShared.ended.join(", ")}.`, "warning");
		}
		ciShared.ended = [];
		// The other tools publish theirs, and this file's own handler publishes the waits that went on over a /reload.
		pi.events.emit(WAITS_REQUEST, undefined);
	});
	// Pi emits resources_discover after session_start, at the start and at /reload alike; a message sent before could
	// start a turn inside the reload. The results that came meanwhile go out then.
	pi.on("resources_discover", () => {
		setTimeout(() => {
			const live = ciShared.live;
			if (live?.pi !== pi) return;
			live.ready = true;
			for (const held of ciShared.held.splice(0)) ciDeliver(held);
		}, 0);
	});
	pi.on("session_shutdown", (event) => {
		if (ciShared.live?.pi === pi) ciShared.live = undefined;
		if (event.reason === "reload") return;
		// Another session or the end of Pi: the waits belong to the conversation that started them.
		const ended = [
			...[...ciShared.waits.values()].map((entry) => `${entry.id} (${entry.what})`),
			...ciShared.held.map((held) => `${String(held.details.waitId)} (its result unread)`),
		];
		for (const entry of ciShared.waits.values()) entry.abort.abort();
		ciShared.waits.clear();
		ciShared.held = [];
		if (event.reason !== "quit") ciShared.ended.push(...ended);
	});
	pi.events.on(WAITS_REQUEST, () => ciPublish(pi));
	pi.events.on(WAITS_STATE, (data) => {
		const { tool, waits } = (data ?? {}) as { tool?: unknown; waits?: unknown };
		if (typeof tool === "string" && tool !== CI_MESSAGE_TYPE && Array.isArray(waits)) otherWaits.set(tool, waits as BackgroundWaitView[]);
	});
	pi.events.on(WAITS_CANCEL, (data) => {
		const id = String((data as { id?: unknown } | undefined)?.id);
		if (ciShared.waits.has(id)) ciShared.live?.ctx.ui.notify(stopCiWait(id), "info");
	});

	// A result in one line: the wait's id and what it waited for, then how it ended and the time it took.
	pi.registerMessageRenderer<{ project?: string; waitId?: string; what?: string; elapsedMs?: number }>(CI_MESSAGE_TYPE, (message, options, theme) => {
		const d = message.details;
		if (!d?.waitId) return undefined;
		const body = messageText(message.content);
		const { color, mark, word } = ciOutcome(body.split("\n")[0] ?? "");
		const took = d.elapsedMs === undefined ? "" : ciDuration(d.elapsedMs / 1000) || "0s";
		const right = `${theme.fg(color, `${mark} ${word}`)}${took ? theme.fg("muted", ` · ${took}`) : ""}`;
		return resultLine(message, CI_MESSAGE_TYPE, `${d.waitId} ${d.what ?? d.project ?? ""}`.trim(), right, body, options, theme);
	});

	pi.registerTool({
		name: "gitlab_pipeline",
		label: "GitLab pipeline",
		description:
			"Show, wait for, and drive the CI pipelines and jobs of a GitLab project in a few lines, with the gitlab tool's " +
			"instances and tokens. status: the pipeline and a table of its jobs (stage, job, status, time, runner, id), " +
			"trigger jobs with their downstream pipeline, and the manual jobs waiting to be played. wait: checks a job, or " +
			"the pipeline, every interval seconds without model requests until it settles (success, failed, canceled, " +
			"skipped, or held at a manual job), at most timeout minutes. A failed pipeline or job comes with the end of " +
			"the logs of its failed jobs. log: the end of a job log, or the " +
			"lines matching grep, without colour codes and timestamps. play starts a manual job (with variables), retry runs " +
			"a job again (without job: the failed jobs of the pipeline), cancel stops a job or the pipeline, run starts a " +
			"pipeline for ref (with variables); with wait: true they wait afterwards. chain runs jobs (names, in order) in one " +
			"call, as for a rollout: plays each manual one once the one before succeeded, awaits one not ready yet, leaves one " +
			"that succeeded already, stops at a failure with the end of its log, then GETs the check URLs without a token " +
			"(status, time, redirect), trying a 5xx or unreachable one again for about a minute. Every wait and chain needs " +
			"needResult. false returns " +
			"at once with an id, and a message brings the result later, with your next step or as a turn of its own; true " +
			"waits here until the user sends a message or 5 minutes pass, then it goes on in the background. Background " +
			"waits go on over /reload. stop_wait " +
			"with waitId ends such a wait, the pipeline itself goes on; list lists the background waits, the wait tool's too. " +
			"The project defaults to the one of " +
			"the working directory's origin remote; the pipeline is pipeline (its id), the head pipeline of mr, or the " +
			"latest of ref or of the project; a job is its name in that pipeline or its id.",
		promptSnippet: "See, wait for, and drive GitLab CI pipelines and jobs: status, wait, log, play, retry, cancel, run, chain",
		promptGuidelines: [
			"Use gitlab_pipeline for CI pipelines and jobs (their state, waiting for them, job logs, manual jobs, retries) instead of the gitlab tool or wait: it answers in a few lines and waits without model requests.",
			"gitlab_pipeline: play, retry, cancel, and run only what the user asked for; a deploy job, to production above all, only on the user's word for that deploy.",
			"gitlab_pipeline: chain plays exactly the jobs given and never picks an environment itself; include a production deploy job only on the user's word for that deploy.",
			"gitlab_pipeline: without project it acts on the project of the working directory's origin remote; a web URL of a pipeline, job, or merge request in project names that one.",
			"gitlab_pipeline: needResult: true only when your very next step needs the outcome and nothing else is left to do until then (a deploy to check right after, a failure to fix); otherwise needResult: false, go on with the work that does not depend on it, and end your turn when nothing is left: the result arrives as a message and starts the next turn. Never wait here for a pipeline you only report on.",
		],
		parameters: ciParameters(instances),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },

		async execute(_id, params, signal, onUpdate, ctx) {
			const action = params.action as CiAction;
			if (action === "stop_wait") {
				const id = String(params.waitId ?? "").trim();
				if (!id) throw new Error("stop_wait needs waitId: the id of a background wait, as gp1");
				return { content: [{ type: "text", text: stopCiWait(id) }], details: { host: "", project: "", action } };
			}
			if (action === "list") return { content: [{ type: "text", text: ciListText(allWaits()) }], details: { host: "", project: "", action } };
			const waits = action === "wait" || action === "chain" || (params.wait === true && (action === "play" || action === "retry" || action === "run"));
			if (waits && typeof params.needResult !== "boolean") {
				throw new Error(
					"needResult is required with a wait: true when your next step needs the result, false to wait in the background and go on",
				);
			}
			// Without a terminal nobody takes a result that comes after the run: every wait is in the foreground there.
			const background = waits && params.needResult === false && ctx.hasUI;
			const target = ciTarget(instances, params.host as string | undefined, params.project, ctx.cwd);
			const { instance } = target;
			const P = target.project;
			const label = decodeURIComponent(P);
			const details = { host: instance.name, project: label, action };
			const token = await resolveToken(
				instance,
				CONFIG_FILE,
				`Create a personal access token in ${instance.base} under User settings → Personal access tokens (scope api, or read_api to read only)`,
				signal,
			);
			const mask = (text: string) => text.split(token).join(REDACTED);
			// The tool call's signal, until a background wait takes over with its own.
			let active: AbortSignal | undefined = signal;

			const call = async (method: "GET" | "POST", path: string, query?: Record<string, unknown>, body?: unknown): Promise<string> =>
				apiRequest(instance, token, method, path, query, body, active, mask);
			const get = async (path: string, query?: Record<string, unknown>) => apiJson(await call("GET", path, query), mask);
			const post = async (path: string, body?: unknown) => apiJson(await call("POST", path, undefined, body), mask);

			const jobsOf = async (pipeline: number): Promise<JsonObject[]> => {
				const jobs: JsonObject[] = [];
				for (let page = 1; page <= CI_JOB_PAGES; page++) {
					const list = await get(`/projects/${P}/pipelines/${pipeline}/jobs`, { per_page: 100, page });
					if (!Array.isArray(list)) break;
					jobs.push(...list.filter(isObject));
					if (list.length < 100) break;
				}
				return jobs;
			};
			// Trigger jobs only add to the table: without them (an older GitLab, a narrow token) it shows the jobs alone.
			const bridgesOf = async (pipeline: number): Promise<JsonObject[]> => {
				try {
					const list = await get(`/projects/${P}/pipelines/${pipeline}/bridges`, { per_page: 100 });
					return Array.isArray(list) ? list.filter(isObject) : [];
				} catch {
					return [];
				}
			};
			const givenJob = params.job === undefined ? "" : String(params.job).trim();
			const jobId = /^\d+$/.test(givenJob) ? Number(givenJob) : givenJob ? undefined : target.job;
			const hasJob = givenJob !== "" || target.job !== undefined;
			const pipelineOf = async (id: Json | undefined) => ciObject(await get(`/projects/${P}/pipelines/${ciText(id)}`), "a pipeline");

			const findPipeline = async (): Promise<JsonObject> => {
				const id = params.pipeline ?? target.pipeline;
				if (id !== undefined) return pipelineOf(id);
				const mr = params.mr ?? target.mr;
				if (mr !== undefined) {
					const request = ciObject(await get(`/projects/${P}/merge_requests/${mr}`), "a merge request");
					const head = isObject(request.head_pipeline) ? request.head_pipeline.id : undefined;
					if (head === undefined || head === null) throw new Error(`merge request !${mr} of ${label} has no pipeline`);
					return pipelineOf(head);
				}
				if (jobId !== undefined && !params.ref) {
					const job = ciObject(await get(`/projects/${P}/jobs/${jobId}`), "a job");
					if (isObject(job.pipeline)) return pipelineOf(job.pipeline.id);
				}
				const list = await get(`/projects/${P}/pipelines`, { per_page: 1, ...(params.ref ? { ref: params.ref } : {}) });
				const latest = Array.isArray(list) ? list.find(isObject) : undefined;
				if (!latest) throw new Error(params.ref ? `${label} has no pipeline for ${params.ref}` : `${label} has no pipeline`);
				return pipelineOf(latest.id);
			};
			const findJob = async (): Promise<JsonObject> => {
				if (jobId !== undefined) return ciObject(await get(`/projects/${P}/jobs/${jobId}`), "a job");
				if (!givenJob) throw new Error(`${action} needs job: its name in the pipeline or its id`);
				const pipeline = await findPipeline();
				const jobs = await jobsOf(Number(pipeline.id));
				const matches = jobs.filter((job) => job.name === givenJob).sort((a, b) => Number(b.id) - Number(a.id));
				if (matches.length > 0) return matches[0];
				const bridges = await bridgesOf(Number(pipeline.id));
				if (bridges.some((bridge) => bridge.name === givenJob)) {
					throw new Error(`${givenJob} in pipeline ${ciText(pipeline.id)} is a trigger job; its downstream pipeline shows in status`);
				}
				const names = [...new Set(jobs.map((job) => ciText(job.name)))].join(", ") || "none";
				throw new Error(`pipeline ${ciText(pipeline.id)} has no job ${givenJob}; its jobs: ${names}`);
			};

			const statusText = async (pipeline: JsonObject, jobs?: JsonObject[]): Promise<string> => {
				const id = Number(pipeline.id);
				const all = jobs ?? (await jobsOf(id));
				const rows = ciRows(all, await bridgesOf(id));
				const manual = all.filter((job) => job.status === "manual").map((job) => `${ciText(job.name)} (${ciText(job.id)})`);
				return [
					ciPipelineHead(pipeline),
					rows.length > 0 ? ciTable(rows) : "No jobs (yet).",
					...(manual.length > 0 ? [`Manual, waiting to be played: ${manual.join(", ")}`] : []),
				].join("\n");
			};
			const tails = async (jobs: JsonObject[]): Promise<string> => {
				const failed = jobs
					.filter((job) => job.status === "failed")
					.sort((a, b) => Number(a.id) - Number(b.id))
					.slice(0, CI_TAIL_JOBS);
				const parts: string[] = [];
				for (const job of failed) {
					const reason = job.failure_reason ? `, ${ciText(job.failure_reason)}` : "";
					let lines: string;
					try {
						lines = ciLogLines(await call("GET", `/projects/${P}/jobs/${ciText(job.id)}/trace`)).slice(-CI_TAIL_LINES).join("\n");
					} catch (error) {
						lines = `(no log: ${error instanceof Error ? error.message : String(error)})`;
					}
					parts.push(`\nEnd of the log of ${ciText(job.name)} (job ${ciText(job.id)}${reason}):\n${lines}`);
				}
				return parts.join("\n");
			};

			const intervalMs = Math.min(Math.max(params.interval ?? CI_INTERVAL_S, 5), 300) * 1000;
			const defaultTimeout = background ? CI_BACKGROUND_TIMEOUT_MIN : CI_TIMEOUT_MIN;
			const timeoutMs = Math.min(Math.max(params.timeout ?? defaultTimeout, 0.5), CI_MAX_TIMEOUT_MIN) * 60_000;
			// Where a check reports: the tool row in the foreground, the list of background waits in the background; text
			// for the row, found for the list.
			let progressTo = (text: string, _checks: number, _found: string) => onUpdate?.({ content: [{ type: "text", text: mask(text) }], details });
			/** The background wait a wait in the foreground went on as, after a message from the user. */
			let moved: CiWait | undefined;
			/** Set while a wait runs in the foreground: hands it to the background, from where it stands. */
			let handOver: ((started: number, checks: number, found: string) => void) | undefined;
			/** When a wait in the foreground makes way for the background by itself; set as it starts, with a terminal. */
			let detachAt = Number.POSITIVE_INFINITY;
			const interrupted = () => !background && !moved && handOver !== undefined && (ctx.hasPendingMessages() || Date.now() >= detachAt);
			// Sleeps until the next check; a wait in the foreground goes to the background meanwhile when it is interrupted.
			const pause = async (ms: number, started: number, checks: number, found: string) => {
				const until = Date.now() + ms;
				while (Date.now() < until && !active?.aborted) {
					if (interrupted()) handOver?.(started, checks, found);
					await new Promise((resolve) => setTimeout(resolve, Math.min(1000, until - Date.now())));
				}
			};
			type Polled<T> = { outcome: "settled" | "timeout"; value: T; checks: number; elapsedMs: number };
			// A chain polls from its own start and goes on counting, so its timeout and its checks span all of its jobs.
			const poll = async <T>(
				check: () => Promise<{ settled: boolean; progress: string; value: T }>,
				started = Date.now(),
				before = 0,
			): Promise<Polled<T>> => {
				let failures = 0;
				let found = "first check";
				for (let checks = before + 1; ; checks++) {
					if (active?.aborted) throw new Error("gitlab_pipeline: wait aborted");
					let state: { settled: boolean; progress: string; value: T } | undefined;
					try {
						state = await check();
						failures = 0;
					} catch (error) {
						// A network error or a server error may pass; a refusal (401, 403, 404, …) will not.
						const status = (error as { status?: number }).status;
						const passing = status === undefined || status >= 500 || status === 429;
						if (!passing || active?.aborted || ++failures > CI_RETRIES || Date.now() - started >= timeoutMs) throw error;
					}
					const elapsedMs = Date.now() - started;
					const span = ciDuration(elapsedMs / 1000) || "0s";
					if (state) {
						const value = state.value;
						const done = (outcome: Polled<T>["outcome"]) => ({ outcome, value, checks, elapsedMs });
						if (state.settled) return done("settled");
						if (elapsedMs >= timeoutMs) return done("timeout");
						found = state.progress;
						progressTo(`${span}, ${checks} checks: ${state.progress}`, checks, state.progress);
					} else {
						found = `the last ${failures} failed, trying again`;
						progressTo(`${span}, ${checks} checks: ${found}`, checks, found);
					}
					await pause(Math.min(intervalMs, Math.max(timeoutMs - elapsedMs, 1000)), started, checks, found);
				}
			};
			const lead = (polled: Polled<unknown>, what: string, status: string): string => {
				const span = ciDuration(polled.elapsedMs / 1000) || "0s";
				if (polled.outcome === "settled") {
					return polled.checks === 1 ? `${what} is ${status}.` : `${what} is ${status}, after ${span} of waiting (${polled.checks} checks).`;
				}
				return `Gave up after ${span}: ${what} is still ${status}. Wait again to go on.`;
			};
			const waitPipeline = async (id: number): Promise<string> => {
				const polled = await poll(async () => {
					const pipeline = await pipelineOf(id);
					const jobs = await jobsOf(id);
					const busy = jobs
						.filter((job) => CI_ACTIVE.has(ciText(job.status)) && job.status !== "created")
						.map((job) => `${ciText(job.name)} ${ciText(job.status)}`);
					const progress = `pipeline ${ciText(pipeline.status)}${busy.length > 0 ? `; ${busy.join(", ")}` : ""}`;
					return { settled: !CI_ACTIVE.has(ciText(pipeline.status)), progress, value: { pipeline, jobs } };
				});
				const { pipeline, jobs } = polled.value;
				const first = lead(polled, `Pipeline ${id}`, ciText(pipeline.status));
				const tail = polled.outcome === "settled" ? await tails(jobs) : "";
				return `${first}\n${await statusText(pipeline, jobs)}${tail}`;
			};
			const waitJob = async (id: number): Promise<string> => {
				const polled = await poll(async () => {
					const job = ciObject(await get(`/projects/${P}/jobs/${id}`), "a job");
					const status = ciText(job.status);
					return { settled: !CI_ACTIVE.has(status), progress: `${ciText(job.name)} ${status}`, value: job };
				});
				const job = polled.value;
				const status = ciText(job.status);
				let text = `${lead(polled, `Job ${ciText(job.name)} (${id})`, status)}\n${ciJobHead(job)}`;
				if (status === "manual") text += "\nIt waits to be played (action play).";
				if (polled.outcome === "settled" && status === "failed") text += await tails([job]);
				return text;
			};
			// A background wait for a job or pipeline: listed for the panel and the lists, checked through its own signal. It
			// runs on in this closure over /reload, and reports through ciShared, never through this runtime's pi.
			const register = (what: string, started: number, checks: number, found: string): CiWait => {
				const entry: CiWait = {
					id: `gp${++ciShared.counter}`,
					what,
					started,
					checks,
					progress: mask(found),
					intervalMs,
					timeoutMs,
					abort: new AbortController(),
					chain: action === "chain",
				};
				ciShared.waits.set(entry.id, entry);
				ciPublish();
				active = entry.abort.signal;
				progressTo = (_text, count, last) => {
					entry.checks = count;
					entry.progress = mask(last);
					ciPublish();
				};
				return entry;
			};
			const deliverTo = (entry: CiWait, text: string) => {
				if (entry.abort.signal.aborted) return;
				if (ciShared.waits.get(entry.id) === entry) ciShared.waits.delete(entry.id);
				ciPublish();
				const elapsedMs = Date.now() - entry.started;
				ciDeliver({ content: limited(mask(text), "", false), details: { ...details, waitId: entry.id, what: entry.what, elapsedMs } });
			};
			const failed = (entry: CiWait, error: unknown) =>
				`Background wait ${entry.id} for ${entry.what} ended without a result: ${error instanceof Error ? error.message : String(error)}`;
			// Runs a wait (for a job, a pipeline, or a chain) here, or hands it to the background and says so.
			const settle = async (what: string, run: () => Promise<string>): Promise<string> => {
				const every = ciDuration(intervalMs / 1000);
				if (background) {
					const entry = register(what, Date.now(), 0, "first check");
					void run().then(
						(text) => deliverTo(entry, `Background wait ${entry.id}: ${text}`),
						(error) => deliverTo(entry, failed(entry, error)),
					);
					const upTo = ciDuration(timeoutMs / 1000);
					return `Waiting in the background as ${entry.id} for ${entry.what}, checking every ${every} for up to ${upTo}. A message brings the result; until then carry on or end your turn.`;
				}
				// In the foreground a message from the user hands the wait to the background, which goes on from where it
				// stands; the call returns then, and the result comes as a message.
				let handed: (text: string) => void = () => {};
				const handedOver = new Promise<string>((resolve) => (handed = resolve));
				if (ctx.hasUI) detachAt = Date.now() + CI_DETACH_MS;
				handOver = (started, checks, found) => {
					const byUser = ctx.hasPendingMessages();
					const entry = register(what, started, checks, found);
					moved = entry;
					const span = ciDuration((Date.now() - started) / 1000) || "0s";
					const why = byUser ? "The user sent a message" : `No result after ${span}`;
					const meanwhile = byUser
						? "answer the user meanwhile"
						: "go on with work that does not depend on it, or end your turn now: the result starts the next one";
					handed(
						`${why}, so the wait goes on in the background as ${entry.id} for ${entry.what}, checking every ` +
							`${every}; ${checks} check${checks === 1 ? "" : "s"} in ${span} so far, the last: ${found}. Gives up at ` +
							`${ciClock(started + timeoutMs)}. A message brings the result; ${meanwhile}.`,
					);
				};
				const running = run();
				running.then(
					(text) => moved && deliverTo(moved, `Background wait ${moved.id}: ${text}`),
					(error) => moved && deliverTo(moved, failed(moved, error)),
				);
				try {
					return await Promise.race([running, handedOver]);
				} finally {
					handOver = undefined;
				}
			};
			const settleOn = (kind: "job" | "pipeline", id: number) =>
				settle(`${kind} ${id} of ${label}`, () => (kind === "job" ? waitJob(id) : waitPipeline(id)));
			// The chain: each job once the one before succeeded, played where it is manual, then the checks of the URLs.
			const runChain = async (
				pipeline: JsonObject,
				steps: Array<{ name: string; id: number }>,
				urls: URL[],
				playBody: unknown,
			): Promise<string> => {
				const started = Date.now();
				const aborted = () => {
					if (active?.aborted) throw new Error("gitlab_pipeline: chain aborted");
				};
				let checks = 0;
				const rows: string[][] = [];
				let stop = "";
				let tail = "";
				for (const [index, step] of steps.entries()) {
					const nth = `job ${index + 1} of ${steps.length}`;
					/** The status the first check found, and the pipeline's while the job stays created. */
					let first: string | undefined;
					let pipelineStatus = "";
					let idle = 0;
					const watch = (id: number) =>
						poll(
							async () => {
								const job = ciObject(await get(`/projects/${P}/jobs/${id}`), "a job");
								const status = ciText(job.status);
								first ??= status;
								// A created job waits for an earlier stage; if the pipeline stands still twice in a row, a manual job
								// before it holds it, and it will not move by itself.
								if (status === "created") {
									pipelineStatus = ciText((await pipelineOf(pipeline.id)).status);
									idle = CI_ACTIVE.has(pipelineStatus) ? 0 : idle + 1;
								}
								const settled = !CI_ACTIVE.has(status) || (status === "created" && idle >= 2);
								return { settled, progress: `${step.name} ${status} (${nth})`, value: job };
							},
							started,
							checks,
						);
					let polled = await watch(step.id);
					checks = polled.checks;
					let played = false;
					if (polled.outcome === "settled" && polled.value.status === "manual") {
						aborted();
						const job = ciObject(await post(`/projects/${P}/jobs/${step.id}/play`, playBody), "a job");
						played = true;
						polled = await watch(Number(job.id));
						checks = polled.checks;
					}
					const job = polled.value;
					const status = ciText(job.status);
					const time = ciJobRow(job)[3];
					const id = `#${ciText(job.id)}`;
					const before = !played && first === status ? " (before the chain)" : "";
					if (polled.outcome === "settled" && status === "success") {
						rows.push(before ? [`↷ ${step.name}`, "already succeeded", "", id] : [`✓ ${step.name}`, status, time, id]);
						continue;
					}
					const span = ciDuration(polled.elapsedMs / 1000) || "0s";
					if (polled.outcome === "timeout") {
						rows.push([`✗ ${step.name}`, `still ${status}`, time, id]);
						stop = `gave up after ${span}: ${step.name} is still ${status}`;
					} else if (status === "created") {
						rows.push([`✗ ${step.name}`, `still created, the pipeline ${pipelineStatus}`, "", id]);
						stop = `stopped: ${step.name} waits for a job before it that is not running, such as a manual job not among jobs`;
					} else {
						const reason = job.failure_reason ? ` (${ciText(job.failure_reason)})` : "";
						rows.push([`✗ ${step.name}`, `${status}${reason}${before}`, time, id]);
						stop = `failed: ${step.name} ${status}${before}`;
						tail = await tails([job]);
					}
					const rest = steps.slice(index + 1).map((later) => later.name);
					if (rest.length > 0) stop += `; not played: ${rest.join(", ")}`;
					break;
				}
				const probes: string[][] = [];
				let down = 0;
				for (const url of stop ? [] : urls) {
					const from = Date.now();
					let tries = 1;
					let probe: CiProbe;
					for (; ; tries++) {
						aborted();
						probe = await ciProbe(url, active);
						checks++;
						const final = probe.status !== undefined && probe.status < 500;
						if (final || Date.now() - from >= CI_CHECK_WINDOW_MS || Date.now() - started >= timeoutMs) break;
						const found = `${url.href} ${probe.status ?? "unreachable"}, trying again`;
						progressTo(`${ciDuration((Date.now() - started) / 1000) || "0s"}, ${checks} checks: ${found}`, checks, found);
						await pause(CI_CHECK_EVERY_MS, started, checks, found);
					}
					const status = probe.status;
					const bad = status === undefined || status >= 500;
					if (bad) down++;
					const mark = bad ? "✗" : status < 400 || status === 401 || status === 403 ? "✓" : "!";
					const notes = [
						probe.url.href !== url.href ? `→ ${probe.url.href}` : "",
						status === 401 || status === 403 ? "(reachable, behind a login)" : "",
						status !== undefined && status >= 300 && status < 400 ? `(more than ${MAX_REDIRECTS} redirects)` : "",
						probe.error ? `(${probe.error})` : "",
						tries > 1 ? `(try ${tries})` : "",
					];
					const ms = probe.ms < 60_000 ? `${(probe.ms / 1000).toFixed(1)}s` : ciDuration(probe.ms / 1000);
					probes.push([`${mark} ${status ?? "unreachable"}`, ms, [url.href, ...notes].filter(Boolean).join(" ")]);
				}
				const span = ciDuration((Date.now() - started) / 1000) || "0s";
				const ran = `${steps.length} job${steps.length === 1 ? "" : "s"}`;
				const result = stop
					? `Chain ${stop}.`
					: down > 0
						? `Chain failed: ${ran} succeeded, but ${down} of ${urls.length} checks answered 5xx or not at all, after ${span}.`
						: `Chain succeeded: ${ran}${urls.length > 0 ? `, ${urls.length} check${urls.length === 1 ? "" : "s"}` : ""}, in ${span}.`;
				const latest = await pipelineOf(pipeline.id).catch(() => pipeline);
				return [
					ciPipelineHead(latest),
					ciColumns(rows),
					...(probes.length > 0 ? [ciColumns(probes)] : []),
					result + tail,
				].join("\n");
			};
			// The answer of play, retry, and run: what they did, then the wait wait: true asks for.
			const after = async (done: () => string | Promise<string>, kind: "job" | "pipeline", id: number): Promise<string> => {
				if (!params.wait) return done();
				if (!background) {
					const text = await settleOn(kind, id);
					return moved ? `${await done()}\n${text}` : text;
				}
				return `${await done()}\n${await settleOn(kind, id)}`;
			};

			let head: string;
			let body = "";
			let keepEnd = false;
			switch (action) {
				case "status":
					head = await statusText(await findPipeline());
					break;
				case "wait":
					head = hasJob ? await settleOn("job", Number((await findJob()).id)) : await settleOn("pipeline", Number((await findPipeline()).id));
					break;
				case "log": {
					const job = await findJob();
					const lines = ciLogLines(await call("GET", `/projects/${P}/jobs/${ciText(job.id)}/trace`));
					const count = Math.min(Math.max(params.lines ?? CI_LOG_LINES, 1), CI_MAX_LOG_LINES);
					let what: string;
					if (params.grep) {
						let regex: RegExp;
						try {
							regex = new RegExp(params.grep, "i");
						} catch (error) {
							throw new Error(`grep is not a valid regular expression: ${(error as Error).message}`);
						}
						const hits = lines.flatMap((line, i) => (regex.test(line) ? [`${i + 1}: ${line}`] : []));
						body = hits.slice(-count).join("\n");
						const shown = hits.length > count ? `, the last ${count} shown` : "";
						what = `${hits.length} of ${lines.length} lines match /${params.grep}/i${shown}`;
					} else {
						body = lines.slice(-count).join("\n");
						what = lines.length > count ? `the last ${count} of ${lines.length} lines` : `all ${lines.length} lines`;
					}
					head = `${ciJobHead(job)}\nLog, ${what}:`;
					keepEnd = true;
					break;
				}
				case "play": {
					const job = await findJob();
					const status = ciText(job.status);
					if (status !== "manual" && status !== "scheduled") {
						const again = CI_ACTIVE.has(status) ? "" : "; retry runs a finished job again";
						throw new Error(`job ${ciText(job.name)} (${ciText(job.id)}) is ${status}, not manual${again}`);
					}
					const attributes = ciVariables(params.variables as Record<string, unknown> | undefined);
					const played = ciObject(
						await post(`/projects/${P}/jobs/${ciText(job.id)}/play`, attributes.length > 0 ? { job_variables_attributes: attributes } : undefined),
						"a job",
					);
					head = await after(() => `Played. ${ciJobHead(played)}`, "job", Number(played.id));
					break;
				}
				case "retry": {
					if (hasJob) {
						const job = await findJob();
						const retried = ciObject(await post(`/projects/${P}/jobs/${ciText(job.id)}/retry`), "a job");
						head = await after(
							() => `Retried job ${ciText(job.id)} as job ${ciText(retried.id)}. ${ciJobHead(retried)}`,
							"job",
							Number(retried.id),
						);
					} else {
						const pipeline = await findPipeline();
						const retried = ciObject(await post(`/projects/${P}/pipelines/${ciText(pipeline.id)}/retry`), "a pipeline");
						head = await after(
							async () => `Retried the failed and canceled jobs of pipeline ${ciText(pipeline.id)}.\n${await statusText(retried)}`,
							"pipeline",
							Number(retried.id),
						);
					}
					break;
				}
				case "cancel": {
					if (hasJob) {
						const job = await findJob();
						if (!CI_ACTIVE.has(ciText(job.status))) {
							throw new Error(`job ${ciText(job.name)} (${ciText(job.id)}) is ${ciText(job.status)}: nothing to cancel`);
						}
						head = `Canceled. ${ciJobHead(ciObject(await post(`/projects/${P}/jobs/${ciText(job.id)}/cancel`), "a job"))}`;
					} else {
						const pipeline = await findPipeline();
						if (!CI_ACTIVE.has(ciText(pipeline.status))) {
							throw new Error(`pipeline ${ciText(pipeline.id)} is ${ciText(pipeline.status)}: nothing to cancel`);
						}
						const canceled = ciObject(await post(`/projects/${P}/pipelines/${ciText(pipeline.id)}/cancel`), "a pipeline");
						head = `Canceled pipeline ${ciText(pipeline.id)}.\n${await statusText(canceled)}`;
					}
					break;
				}
				case "run": {
					let ref = params.ref?.trim();
					if (!ref) {
						ref = ciText(ciObject(await get(`/projects/${P}`), "a project").default_branch);
						if (!ref) throw new Error(`${label} has no default branch: give ref`);
					}
					const variables = ciVariables(params.variables as Record<string, unknown> | undefined).map((v) => ({
						...v,
						variable_type: "env_var",
					}));
					const created = ciObject(
						await post(`/projects/${P}/pipeline`, { ref, ...(variables.length > 0 ? { variables } : {}) }),
						"a pipeline",
					);
					head = await after(async () => `Started a pipeline for ${ref}.\n${await statusText(created)}`, "pipeline", Number(created.id));
					break;
				}
				case "chain": {
					const names = (params.jobs ?? []).map((name) => String(name).trim());
					if (names.length === 0 || names.includes("")) throw new Error("chain needs jobs: the names of the jobs to run, in their order");
					const urls = (params.check ?? []).map((given) => {
						const url = URL.canParse(given.trim()) ? new URL(given.trim()) : undefined;
						if (!url || !/^https?:$/.test(url.protocol)) throw new Error(`check: ${given} is not an http(s) URL`);
						return url;
					});
					const attributes = ciVariables(params.variables as Record<string, unknown> | undefined);
					const pipeline = await findPipeline();
					const jobs = await jobsOf(Number(pipeline.id));
					const latest = (name: string) => jobs.filter((job) => job.name === name).sort((a, b) => Number(b.id) - Number(a.id))[0];
					const missing = names.filter((name) => !latest(name));
					if (missing.length > 0) {
						const bridges = new Set((await bridgesOf(Number(pipeline.id))).map((bridge) => ciText(bridge.name)));
						const which = missing.map((name) => (bridges.has(name) ? `${name} (a trigger job, which chain does not play)` : name));
						const manual = [...new Set(jobs.filter((job) => job.status === "manual").map((job) => ciText(job.name)))];
						throw new Error(
							`pipeline ${ciText(pipeline.id)} has no job ${which.join(", ")}; nothing was played. Its manual jobs: ${manual.join(", ") || "none"}`,
						);
					}
					const steps = names.map((name) => ({ name, id: Number(latest(name).id) }));
					const playBody = attributes.length > 0 ? { job_variables_attributes: attributes } : undefined;
					head = await settle(`chain › ${label} ${ciText(pipeline.ref)}: ${names.join(", ")}`, () =>
						runChain(pipeline, steps, urls, playBody),
					);
					break;
				}
				default:
					throw new Error(`unknown action ${String(action)}`);
			}
			return { content: [{ type: "text", text: limited(mask(head), mask(body), keepEnd) }], details };
		},

		renderCall(args, theme) {
			const host = args.host as string | undefined;
			const which = [
				args.project,
				args.pipeline !== undefined ? `pipeline ${args.pipeline}` : args.mr !== undefined ? `!${args.mr}` : args.ref,
				args.job !== undefined ? `job ${args.job}` : undefined,
				Array.isArray(args.jobs) ? args.jobs.join(" → ") : undefined,
				args.waitId,
			].filter((part) => part !== undefined && part !== "");
			return new Text(
				theme.fg("toolTitle", theme.bold("gitlab_pipeline ")) +
					(host ? theme.fg("muted", `${host} `) : "") +
					theme.fg("muted", `${args.action ?? "?"}${which.length > 0 ? " " : ""}`) +
					theme.fg("accent", which.join(" ")) +
					(args.needResult === false && (args.action === "wait" || args.action === "chain" || args.wait) ? theme.fg("dim", " (background)") : args.wait ? theme.fg("dim", " (wait)") : ""),
				0,
				0,
			);
		},
	});

	pi.registerCommand("gitlab-waits", {
		description: "List the background waits, the wait tool's too (/gitlab-waits stop <id> ends one of gitlab_pipeline's)",
		handler: async (args, ctx) => {
			const [verb, id] = args.trim().split(/\s+/);
			if (verb === "stop" && id) {
				ctx.ui.notify(stopCiWait(id), "info");
				return;
			}
			ctx.ui.notify(ciListText(allWaits()), "info");
		},
	});
}
