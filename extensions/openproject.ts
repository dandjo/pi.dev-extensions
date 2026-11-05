/**
 * OpenProject: the openproject tool, which calls the API v3 of an OpenProject instance with a personal API token.
 *
 * - The instance comes from ~/.pi/agent/openproject.json ({"url": "https://openproject.example.com"}); without that
 *   file the tool is not registered. The token comes from the environment variable OPENPROJECT_API_TOKEN, read at
 *   every call, and goes only to that instance: paths and links that lead elsewhere are refused, and a redirect to
 *   another host (attachment storage) is followed without it. The token never appears in a result.
 * - JSON responses are folded unless raw is set: a link becomes "Title <href>"; embedded copies of linked resources,
 *   empty fields, and templated and representation links are left out; a work package in a list keeps only self and
 *   its titled API links outside its own href (status, assignee, project, …), since its sub-resources and UI pages are
 *   reachable from its id; a formatted text keeps its raw text; and the actions the user may take on the top-level
 *   resource are listed under _actions. Other text is returned as it is, binary content (attachments) is saved to a
 *   temp file.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const USER_AGENT = "pi-openproject/1.0 (+https://pi.dev)";
const ACCEPT = "application/hal+json, application/json;q=0.9, */*;q=0.1";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Instance {
	origin: string;
	/** Origin plus the path OpenProject is served under, without a trailing slash. */
	base: string;
	/** The path every API URL starts with, e.g. /api/v3 or /openproject/api/v3. */
	api: string;
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
		return { origin: url.origin, base: url.origin + basePath, api: `${basePath}/api/v3` };
	} catch (error) {
		return new Error(`${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The URL for a path below /api/v3, an href from a response, or a full URL; anything outside the API is refused. */
function requestUrl(instance: Instance, target: string, query: Record<string, unknown> | undefined): URL {
	let url: URL;
	const trimmed = target.trim();
	if (/^https?:\/\//i.test(trimmed)) {
		url = new URL(trimmed);
	} else {
		let p = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
		if (p !== instance.api && !p.startsWith(`${instance.api}/`) && !p.startsWith(`${instance.api}?`)) {
			p = instance.api + (/^\/api\/v3(?=$|[/?])/.test(p) ? p.slice("/api/v3".length) : p);
		}
		url = new URL(p, instance.origin);
	}
	if (url.origin !== instance.origin || (url.pathname !== instance.api && !url.pathname.startsWith(`${instance.api}/`))) {
		throw new Error(`${target} is outside the API of ${instance.base} (${instance.api})`);
	}
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value === undefined || value === null) continue;
		url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
	}
	return url;
}

/** Sends the request; a GET follows redirects, carrying the token only within the instance. */
async function send(
	instance: Instance,
	token: string,
	method: string,
	url: URL,
	body: unknown,
	signal: AbortSignal | undefined,
): Promise<{ response: Response; url: URL }> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let current = url;
	for (let hop = 0; ; hop++) {
		const headers: Record<string, string> = { Accept: ACCEPT, "User-Agent": USER_AGENT };
		if (current.origin === instance.origin) headers.Authorization = `Bearer ${token}`;
		if (body !== undefined) headers["Content-Type"] = "application/json";
		let response: Response;
		try {
			response = await fetch(current, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "manual",
				signal: abort,
			});
		} catch (error) {
			if (abort.aborted) throw error;
			const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
			throw new Error(`${current.origin} is unreachable${cause}`);
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
	const file = path.join(mkdtempSync(path.join(os.tmpdir(), "pi-openproject-")), name);
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
	method: Type.Optional(StringEnum(["GET", "POST", "PATCH", "DELETE"] as const, { description: "HTTP method; default GET" })),
	path: Type.String({
		description: "Path below /api/v3, e.g. /work_packages/42, or an href from an earlier response; may carry a query string",
	}),
	query: Type.Optional(
		Type.Object({}, {
			additionalProperties: true,
			description: "Query parameters; arrays and objects (filters, sortBy) are sent as JSON",
		}),
	),
	body: Type.Optional(Type.Object({}, { additionalProperties: true, description: "JSON body for POST and PATCH" })),
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

	pi.registerTool({
		name: "openproject",
		label: "OpenProject",
		description:
			`Call the OpenProject API v3 of ${instance.base} as the owner of the API token. GET reads, POST creates, ` +
			"PATCH updates, DELETE removes. Common paths: /work_packages (query: filters, sortBy, pageSize, offset = page " +
			"number, select), /work_packages/{id}, /work_packages/{id}/activities (POST {\"comment\": {\"raw\": \"…\"}} " +
			"adds a comment), /work_packages/{id}/relations, /projects, /projects/{id}/work_packages, /time_entries, " +
			"/versions, /statuses, /types, /priorities, /users/me. JSON responses are folded: links read \"Title <href>\"; " +
			"empty fields and embedded copies of linked resources are left out; a work package in a list keeps only self " +
			"and its data links (status, assignee, project, …); formatted texts keep their raw text; and " +
			"the top-level resource lists the actions the user may take under _actions as \"METHOD href\"; raw: true " +
			"returns the response unchanged. Binary content such as attachments is saved to a temp file. Output over " +
			`${formatSize(DEFAULT_MAX_BYTES)} is truncated and the full response saved to a temp file.`,
		promptSnippet: "Read and change OpenProject work packages, projects, comments, and time entries (API v3)",
		promptGuidelines: [
			"Use openproject for OpenProject work packages, projects, comments, and time entries instead of curl; it adds the API token itself.",
			"openproject: a PATCH needs the resource's current lockVersion from a GET just before. When fields or allowed values are unclear, POST the payload to the form endpoint first (/work_packages/form, /work_packages/{id}/form) and read its validationErrors.",
			"openproject: send POST, PATCH, or DELETE only for changes the user asked for.",
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
			const method = (params.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE";
			if (params.body !== undefined && (method === "GET" || method === "DELETE")) throw new Error(`a ${method} request takes no body`);
			const target = requestUrl(instance, params.path, params.query as Record<string, unknown> | undefined);
			const { response, url } = await send(instance, token, method, target, params.body, signal);

			const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
			const hint = STATUS_HINTS[response.status];
			const head = hint ? `${status}\n${hint}` : status;
			const details = { method, path: target.pathname + target.search, status: response.status, file: undefined as string | undefined };
			const isError = response.status >= 400;
			const contentType = response.headers.get("content-type") ?? "";

			let text: string;
			if (/json/i.test(contentType)) {
				const body = await response.text();
				let parsed: Json | undefined;
				try {
					parsed = JSON.parse(body) as Json;
				} catch {
					parsed = undefined;
				}
				const shown = parsed === undefined ? body : JSON.stringify(params.raw ? parsed : (fold(parsed, "top") ?? null), null, 1);
				text = `${head}\n${shown}`;
			} else if (isError || !contentType || /^text\/|xml|csv|yaml|markdown/i.test(contentType)) {
				const body = (await response.text()).trim();
				text = body ? `${head}\n${body}` : head;
			} else {
				const data = await readLimited(response);
				details.file = tempFile(downloadName(response, url), data);
				text = `${head}\n${contentType.split(";")[0]}, ${formatSize(data.length)}, saved to: ${details.file}`;
			}
			return { content: [{ type: "text", text: limited(text) }], details, isError };
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
