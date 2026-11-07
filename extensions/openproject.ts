/**
 * OpenProject: the openproject tool, which calls the API v3 (and the BCF API 2.1) of an OpenProject instance with a
 * personal API token.
 *
 * - The instance comes from ~/.pi/agent/openproject.json ({"url": "https://openproject.example.com"}); without that
 *   file the tool is not registered. The token comes from the environment variable OPENPROJECT_API_TOKEN, read at
 *   every call, and goes only to that instance: paths and links that lead elsewhere are refused, and a redirect to
 *   another host (attachment storage) is followed without it. The token never appears in a result.
 * - A request body is JSON (body), plain text (text, e.g. for /render/markdown), or multipart/form-data (files, for
 *   attachments: the fields of body go first, an object as a JSON part, so metadata precedes the file as OpenProject
 *   requires; without one, metadata is {"fileName": the file's name}). contentType overrides the body's type. A
 *   POST, PATCH, or PUT without any of them sends {} as JSON: OpenProject answers 406 to every request but GET and
 *   DELETE that carries no content type, even without a body.
 * - Binary downloads go to a temp dir, removed when the session ends, or to saveTo, which stays.
 * - JSON responses are folded unless raw is set: a link becomes "Title <href>"; embedded copies of linked resources,
 *   empty fields, and templated and representation links are left out; a work package in a list keeps only self and
 *   its titled API links outside its own href (status, assignee, project, …), since its sub-resources and UI pages are
 *   reachable from its id; a formatted text keeps its raw text; and the actions the user may take on the top-level
 *   resource are listed under _actions. Other text is returned as it is, binary content (attachments) is saved to a
 *   temp file.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	getAgentDir,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CONFIG_FILE = path.join(getAgentDir(), "openproject.json");
const TOKEN_ENV = "OPENPROJECT_API_TOKEN";
/** Until the response's headers arrive; the body (a download) and an upload get TRANSFER_TIMEOUT_MS. */
const REQUEST_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 300_000;
const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".json": "application/json",
	".xml": "application/xml",
	".html": "text/html",
	".zip": "application/zip",
	".gz": "application/gzip",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".odt": "application/vnd.oasis.opendocument.text",
	".ods": "application/vnd.oasis.opendocument.spreadsheet",
	".mp4": "video/mp4",
	".eml": "message/rfc822",
};
const USER_AGENT = "pi-openproject/1.0 (+https://pi.dev)";
const ACCEPT = "application/hal+json, application/json;q=0.9, */*;q=0.1";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Instance {
	origin: string;
	/** Origin plus the path OpenProject is served under, without a trailing slash. */
	base: string;
	/** The path every API v3 URL starts with, e.g. /api/v3 or /openproject/api/v3. */
	api: string;
	/** The path of the BCF API 2.1, e.g. /api/bcf/2.1. */
	bcf: string;
}

function loadInstance(): Instance | Error | undefined {
	let text: string;
	try {
		text = readFileSync(CONFIG_FILE, "utf8");
	} catch {
		return undefined;
	}
	try {
		const configured = (JSON.parse(text) as { url?: unknown }).url;
		if (typeof configured !== "string" || !configured) throw new Error('expected {"url": "https://…"}');
		const url = new URL(configured);
		const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("the url must use https");
		const basePath = url.pathname.replace(/\/+$/, "");
		return { origin: url.origin, base: url.origin + basePath, api: `${basePath}/api/v3`, bcf: `${basePath}/api/bcf/2.1` };
	} catch (error) {
		return new Error(`${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Whether a path is root or lies below it. */
const within = (pathname: string, root: string) => pathname === root || pathname.startsWith(`${root}/`);

/**
 * The URL for a path below /api/v3, a path below /api/bcf/2.1, an href from a response, or a full URL; anything
 * outside the two APIs is refused.
 */
function requestUrl(instance: Instance, target: string, query: Record<string, unknown> | undefined): URL {
	let url: URL;
	const trimmed = target.trim();
	if (/^https?:\/\//i.test(trimmed)) {
		url = new URL(trimmed);
	} else {
		let p = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
		const bare = p.split("?")[0];
		if (within(bare, instance.bcf) || within(bare, instance.api)) {
			// already the full path
		} else if (within(bare, "/api/bcf/2.1")) {
			p = instance.bcf + p.slice("/api/bcf/2.1".length);
		} else {
			p = instance.api + (/^\/api\/v3(?=$|[/?])/.test(p) ? p.slice("/api/v3".length) : p);
		}
		url = new URL(p, instance.origin);
	}
	if (url.origin !== instance.origin || !(within(url.pathname, instance.api) || within(url.pathname, instance.bcf))) {
		throw new Error(`${target} is outside the APIs of ${instance.base} (${instance.api}, ${instance.bcf})`);
	}
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value === undefined || value === null) continue;
		url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
	}
	return url;
}

/** A request body: its content type and data. */
interface Payload {
	contentType: string;
	data: string | Uint8Array<ArrayBuffer>;
}

/** A local path with ~ expanded, resolved against the working directory. */
function localPath(file: string): string {
	const trimmed = file.trim();
	if (trimmed === "~" || trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(1));
	return path.resolve(trimmed);
}

/**
 * A multipart/form-data body: the fields of body first, each object or array as one JSON part (OpenProject's
 * metadata), anything else as a text field, then the files (form field name → local path).
 */
function multipart(fields: Record<string, unknown>, files: Record<string, string>): Payload {
	const boundary = `pi-openproject-${randomBytes(16).toString("hex")}`;
	const quoted = (text: string) => text.replace(/["\r\n]/g, (c) => encodeURIComponent(c));
	const parts: Uint8Array[] = [];
	for (const [name, value] of Object.entries(fields)) {
		if (value === undefined || value === null) continue;
		const json = typeof value === "object";
		parts.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"\r\n` +
					(json ? "Content-Type: application/json\r\n" : "") +
					`\r\n${json ? JSON.stringify(value) : String(value)}\r\n`,
			),
		);
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
	// Buffer.concat allocates a plain ArrayBuffer, as fetch's BodyInit wants it
	return { contentType: `multipart/form-data; boundary=${boundary}`, data: Buffer.concat(parts) as Uint8Array<ArrayBuffer> };
}

function timeoutError(ms: number): Error {
	const error = new Error(`no answer within ${ms / 1000} s`);
	error.name = "TimeoutError";
	return error;
}

/**
 * Sends the request; a GET follows redirects, carrying the token only within the instance. The headers must arrive
 * within REQUEST_TIMEOUT_MS (an upload within TRANSFER_TIMEOUT_MS); from then on the body has TRANSFER_TIMEOUT_MS,
 * until release is called.
 */
async function send(
	instance: Instance,
	token: string,
	method: string,
	url: URL,
	payload: Payload | undefined,
	upload: boolean,
	signal: AbortSignal | undefined,
): Promise<{ response: Response; url: URL; release: () => void }> {
	const controller = new AbortController();
	const first = upload ? TRANSFER_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
	let timer = setTimeout(() => controller.abort(timeoutError(first)), first);
	const release = () => clearTimeout(timer);
	const abort = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	let current = url;
	try {
		for (let hop = 0; ; hop++) {
			const headers: Record<string, string> = { Accept: ACCEPT, "User-Agent": USER_AGENT };
			if (current.origin === instance.origin) {
				// the BCF API takes an API token only as Basic apikey:token (Bearer there means OAuth); API v3 takes either
				headers.Authorization = within(current.pathname, instance.bcf)
					? `Basic ${Buffer.from(`apikey:${token}`).toString("base64")}`
					: `Bearer ${token}`;
			}
			if (payload) headers["Content-Type"] = payload.contentType;
			let response: Response;
			try {
				response = await fetch(current, {
					method,
					headers,
					body: payload?.data,
					redirect: "manual",
					signal: abort,
				});
			} catch (error) {
				if (abort.aborted) throw abort.reason instanceof Error ? abort.reason : error;
				const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
				throw new Error(`${current.origin} is unreachable${cause}`);
			}
			const location = response.headers.get("location");
			if (method === "GET" && location && response.status >= 300 && response.status < 400 && hop < MAX_REDIRECTS) {
				await response.body?.cancel().catch(() => {});
				current = new URL(location, current);
				continue;
			}
			clearTimeout(timer);
			timer = setTimeout(() => controller.abort(timeoutError(TRANSFER_TIMEOUT_MS)), TRANSFER_TIMEOUT_MS);
			return { response, url: current, release };
		}
	} catch (error) {
		release();
		throw error;
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
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-openproject-"));
	tempDirs.add(dir);
	const file = path.join(dir, name);
	writeFileSync(file, data, { mode: 0o600 });
	return file;
}

function removeTempDirs(): void {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.clear();
}

/** Writes a download to saveTo: into it when it is a directory, else to that file, which must not exist yet. */
function savedFile(saveTo: string, name: string, data: Uint8Array): string {
	let file = localPath(saveTo);
	if (existsSync(file) && statSync(file).isDirectory()) {
		const ext = path.extname(name);
		const stem = name.slice(0, name.length - ext.length);
		file = path.join(file, name);
		for (let n = 1; existsSync(file); n++) file = path.join(path.dirname(file), `${stem}-${n}${ext}`);
	} else if (existsSync(file)) {
		throw new Error(`saveTo: ${file} exists already`);
	}
	writeFileSync(file, data, { mode: 0o600, flag: "wx" });
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

/** A link as "Title <href>" or its href; undefined for empty, templated, and representation (media type) links. */
function linkText(link: Json): string | undefined {
	if (!isObject(link) || typeof link.href !== "string" || !link.href) return undefined;
	if (link.templated === true || typeof link.type === "string") return undefined;
	return typeof link.title === "string" && link.title ? `${link.title} <${link.href}>` : link.href;
}

/** Where an object sits: the response itself, an item of a collection's elements, or anywhere else. */
type Place = "top" | "element" | "inner";

/** Folds HAL into what the model needs; actions are listed for the top-level resource only. */
function fold(value: Json, place: Place): Json | undefined {
	if (value === null) return undefined;
	if (Array.isArray(value)) {
		const itemPlace = place === "element" ? "element" : "inner";
		return value.map((item) => fold(item, itemPlace)).filter((item): item is Json => item !== undefined);
	}
	if (!isObject(value)) return value;
	const keys = Object.keys(value);
	if (typeof value.format === "string" && "raw" in value && keys.every((k) => k === "format" || k === "raw" || k === "html")) {
		return typeof value.raw === "string" ? value.raw : undefined;
	}

	const links = isObject(value._links) ? value._links : {};
	const self = isObject(links.self) && typeof links.self.href === "string" ? `${links.self.href}/` : undefined;
	/** A link a listed work package keeps: a titled one into the API that is not one of its own sub-resources. */
	const dataLink = (link: Json) =>
		isObject(link) &&
		typeof link.title === "string" &&
		typeof link.href === "string" &&
		link.href.includes("/api/v3/") &&
		!(self && link.href.startsWith(self));
	const listed = place === "element" && value._type === "WorkPackage";
	const out: JsonObject = {};
	const actions: JsonObject = {};
	for (const key of keys) {
		const item = value[key];
		if (key === "_links") {
			const kept: JsonObject = {};
			for (const [rel, link] of Object.entries(links)) {
				if (Array.isArray(link)) {
					const items = link.map(linkText).filter((text): text is string => text !== undefined);
					if (items.length > 0) kept[rel] = items;
				} else if (isObject(link) && typeof link.method === "string" && link.method.toUpperCase() !== "GET") {
					if (place === "top" && typeof link.href === "string") actions[rel] = `${link.method.toUpperCase()} ${link.href}`;
				} else if (listed && rel !== "self" && !dataLink(link)) {
					continue;
				} else {
					const text = linkText(link);
					if (text !== undefined) kept[rel] = text;
				}
			}
			if (Object.keys(kept).length > 0) out._links = kept;
		} else if (key === "_embedded" && isObject(item)) {
			const kept: JsonObject = {};
			for (const [name, embedded] of Object.entries(item)) {
				if (name in links) continue;
				const folded = fold(embedded, name === "elements" ? "element" : "inner");
				if (folded !== undefined) kept[name] = folded;
			}
			if (Object.keys(kept).length > 0) out._embedded = kept;
		} else {
			const folded = fold(item, "inner");
			if (folded !== undefined) out[key] = folded;
		}
	}
	if (Object.keys(actions).length > 0) out._actions = actions;
	return out;
}

function limited(text: string): string {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!t.truncated) return text;
	const file = tempFile("response.txt", text);
	return `${t.content}\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Full response saved to: ${file}]`;
}

const STATUS_HINTS: Record<number, string> = {
	401: "The API token was rejected: it expired or was revoked, or the instance does not accept API tokens.",
	403: "The token's user lacks the permission for this.",
	409: "The resource changed in the meantime: GET it again and send its current lockVersion.",
};

const Params = Type.Object({
	method: Type.Optional(
		StringEnum(["GET", "POST", "PATCH", "PUT", "DELETE"] as const, {
			description: "HTTP method; default GET (PUT only the BCF API uses)",
		}),
	),
	path: Type.String({
		description:
			"Path below /api/v3, e.g. /work_packages/42, a path below /api/bcf/2.1, or an href from an earlier response; may carry a query string",
	}),
	query: Type.Optional(
		Type.Object({}, {
			additionalProperties: true,
			description: "Query parameters; arrays and objects (filters, sortBy) are sent as JSON",
		}),
	),
	body: Type.Optional(
		Type.Object({}, {
			additionalProperties: true,
			description:
				"JSON body for POST, PATCH, and PUT (without one, {} is sent); with files, its fields go first as form fields, an object as a JSON part (metadata)",
		}),
	),
	text: Type.Optional(
		Type.String({ description: "Plain-text body instead of body, e.g. the markdown for POST /render/markdown" }),
	),
	contentType: Type.Optional(
		Type.String({
			description:
				"Content type of body or text; default application/json for body, text/plain for text (e.g. application/hal+json for emoji_reactions)",
		}),
	),
	files: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"Local files to upload with POST as multipart/form-data, form field name → path, e.g. {\"file\": \"./report.pdf\"} for " +
				"POST /work_packages/{id}/attachments; body.metadata ({\"fileName\": …, \"description\": {\"raw\": …}}) defaults to the file's name",
		}),
	),
	saveTo: Type.Optional(
		Type.String({
			description:
				"Where a binary download is kept: a directory (the file's own name) or a new file path; default a temp dir removed when the session ends",
		}),
	),
	raw: Type.Optional(Type.Boolean({ description: "Return JSON unchanged instead of folded; default false" })),
});

export default function (pi: ExtensionAPI) {
	const instance = loadInstance();
	if (instance instanceof Error) {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(`openproject: ${instance.message}`, "error");
		});
		return;
	}
	if (!instance) return;

	pi.on("session_shutdown", () => removeTempDirs());

	pi.registerTool({
		name: "openproject",
		label: "OpenProject",
		description:
			`Call the OpenProject API v3 of ${instance.base} (and its BCF API 2.1 under /api/bcf/2.1) as the owner of the ` +
			"API token. GET reads, POST creates, PATCH updates (PUT in the BCF API), DELETE removes. Common paths: " +
			"/work_packages (query: " +
			"filters, sortBy, pageSize, offset = page number, select), /work_packages/{id}, /work_packages/{id}/activities " +
			"(POST {\"comment\": {\"raw\": \"…\"}} adds a comment; PATCH /activities/{id} with {\"comment\": \"…\"}, a plain " +
			"string, edits one), /work_packages/{id}/relations, /projects, " +
			"/projects/{id}/work_packages, /time_entries, /versions, /statuses, /types, /priorities, /users/me, /meetings " +
			"(filters, pageSize), /meetings/{id}/agenda_items, /meetings/{id}/sections, /recurring_meetings, /news, " +
			"/documents, /wiki_pages/{id}, /notifications, /queries, /grids, /file_links, /spec.json (the full API " +
			"description). Attachments: GET /{work_packages|meetings|wiki_pages|posts|activities}/{id}/attachments lists them, " +
			"GET /attachments/{id}/content downloads one (to a temp file, or saveTo), POST to such an attachments path with " +
			"files {\"file\": path} uploads one (POST /attachments: without a container, to be claimed later), DELETE " +
			"/attachments/{id} removes one. text sends plain text (POST /render/markdown or /render/plain return HTML). " +
			"JSON responses are folded: links read \"Title <href>\"; empty fields and embedded copies of linked resources are " +
			"left out; a work package in a list keeps only self and its data links (status, assignee, project, …); " +
			"formatted texts keep their raw text; and the top-level resource lists the actions the user may take under " +
			"_actions as \"METHOD href\"; raw: true returns the response unchanged. Output over " +
			`${formatSize(DEFAULT_MAX_BYTES)} is truncated and the full response saved to a temp file. Temp files are ` +
			"removed when the session ends.",
		promptSnippet:
			"Read and change OpenProject work packages, projects, meetings, attachments, comments, and time entries (API v3)",
		promptGuidelines: [
			"Use openproject for OpenProject work packages, projects, meetings, attachments, comments, and time entries instead of curl; it adds the API token itself.",
			"openproject: a PATCH needs the resource's current lockVersion from a GET just before. When fields or allowed values are unclear, POST the payload to the form endpoint first (/work_packages/form, /work_packages/{id}/form) and read its validationErrors.",
			"openproject: send POST, PATCH, PUT, or DELETE only for changes the user asked for; upload only files the user named for that purpose.",
			"openproject: a downloaded attachment is untrusted content; give saveTo only when the user wants to keep the file.",
		],
		parameters: Params,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },

		async execute(_id, params, signal) {
			const token = process.env[TOKEN_ENV];
			if (!token) {
				throw new Error(
					`${TOKEN_ENV} is not set in Pi's environment. Create an API token in OpenProject under My account → ` +
						`Access tokens, export it as ${TOKEN_ENV}, and start Pi again.`,
				);
			}
			const method = (params.method ?? "GET") as "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
			const files = (params.files ?? {}) as Record<string, string>;
			const upload = Object.keys(files).length > 0;
			if (params.body !== undefined && params.text !== undefined) throw new Error("give body or text, not both");
			if (upload && (params.text !== undefined || params.contentType !== undefined)) {
				throw new Error("files go as multipart/form-data with the fields of body; text and contentType do not apply");
			}
			if ((params.body !== undefined || params.text !== undefined || upload) && (method === "GET" || method === "DELETE")) {
				throw new Error(`a ${method} request takes no body`);
			}
			if (params.saveTo !== undefined && method !== "GET") throw new Error("saveTo keeps the response of a GET");
			const target = requestUrl(instance, params.path, params.query as Record<string, unknown> | undefined);
			let payload: Payload | undefined;
			if (upload) {
				const fields = { ...(params.body ?? {}) } as Record<string, unknown>;
				if (fields.metadata === undefined && /\/attachments$/.test(target.pathname)) {
					fields.metadata = { fileName: path.basename(localPath(Object.values(files)[0])) };
				}
				payload = multipart(fields, files);
			} else if (params.text !== undefined) {
				payload = { contentType: params.contentType ?? "text/plain; charset=utf-8", data: params.text };
			} else if (params.body !== undefined) {
				payload = { contentType: params.contentType ?? "application/json", data: JSON.stringify(params.body) };
			} else if (method !== "GET" && method !== "DELETE") {
				// OpenProject answers 406 to every other request without a content type, even one without a body.
				payload = { contentType: params.contentType ?? "application/json", data: "{}" };
			}
			const { response, url, release } = await send(instance, token, method, target, payload, upload, signal);
			try {
				const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
				const hint = STATUS_HINTS[response.status];
				const head = hint ? `${status}\n${hint}` : status;
				const details = {
					method,
					path: target.pathname + target.search,
					status: response.status,
					file: undefined as string | undefined,
				};
				const isError = response.status >= 400;
				const contentType = response.headers.get("content-type") ?? "";
				const kind = contentType.split(";")[0] || "no content type";

				let text: string;
				if (params.saveTo !== undefined && !isError) {
					const data = await readLimited(response);
					details.file = savedFile(params.saveTo, downloadName(response, url), data);
					text = `${head}\n${kind}, ${formatSize(data.length)}, saved to: ${details.file}`;
				} else if (/json/i.test(contentType)) {
					const body = await response.text();
					let parsed: Json | undefined;
					try {
						parsed = JSON.parse(body) as Json;
					} catch {
						parsed = undefined;
					}
					const shown =
						parsed === undefined ? body : JSON.stringify(params.raw ? parsed : (fold(parsed, "top") ?? null), null, 1);
					text = `${head}\n${shown}`;
				} else if (isError || !contentType || /^text\/|xml|csv|yaml|markdown/i.test(contentType)) {
					const body = (await response.text()).trim();
					text = body ? `${head}\n${body}` : head;
				} else {
					const data = await readLimited(response);
					details.file = tempFile(downloadName(response, url), data);
					text = `${head}\n${kind}, ${formatSize(data.length)}, saved to: ${details.file} (removed when the session ends)`;
				}
				return { content: [{ type: "text", text: limited(text) }], details, isError };
			} finally {
				release();
			}
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("openproject ")) + theme.fg("muted", `${args.method ?? "GET"} `) + theme.fg("accent", args.path ?? ""),
				0,
				0,
			);
		},
	});
}
