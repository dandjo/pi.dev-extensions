/**
 * Clipboard: a tool that lets the model read and write the system clipboard on Linux and macOS.
 *
 * - clipboard read returns what the clipboard holds: text, an image (PNG, JPEG, WebP, or GIF; other formats converted
 *   to PNG; scaled down as Pi's images.autoResize setting says), and on macOS the paths of files copied in Finder.
 *   format "text" or "image" asks for one of them only.
 * - clipboard write puts text on the clipboard with Pi's own copy routine: wl-copy, xclip, or xsel on Linux, the
 *   native helper or pbcopy on macOS, and over SSH OSC 52, which reaches the clipboard of the machine the terminal
 *   runs on.
 * - Reading asks first, since what the model reads goes to its provider, a password just copied from a password
 *   manager as much as anything else. The question names what the clipboard holds (text with its length, an image with
 *   its format and size), never the content. {"confirmRead": false} in ~/.pi/agent/clipboard.json reads without
 *   asking; without a UI (pi -p, subagents) reading is refused unless that is set. Writing never asks.
 * - Linux reads through wl-paste on Wayland, else xclip on X11 (XWayland included), else Pi's native X11 helper with
 *   xsel for text; macOS through Pi's native helper, with pbpaste for text. Over SSH no display is there, and the
 *   clipboard of the machine in front of you cannot be read.
 * - Text beyond Pi's output limit is cut, the full text saved to a private temp file that goes when the session ends.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	convertToPng,
	copyToClipboard,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	formatDimensionNote,
	formatSize,
	getAgentDir,
	resizeImage,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { getNativeClipboard, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CONFIG_FILE = path.join(getAgentDir(), "clipboard.json");
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_CLIPBOARD_BYTES = 64 * 1024 * 1024;
/** The image formats models take, in order of preference. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** The names of plain text among the types wl-paste and xclip list, in order of preference. */
const TEXT_TYPES = ["text/plain;charset=utf-8", "utf8_string", "text/plain", "text", "string"];

type Format = "text" | "image";

interface ClipboardImage {
	bytes: Buffer;
	mimeType: string;
}

interface Contents {
	text?: string;
	image?: ClipboardImage;
	files?: string[];
}

interface CommandResult {
	/** Whether the command exists; false means it could not be started. */
	found: boolean;
	ok: boolean;
	stdout: Buffer;
	stderr: string;
}

/** Runs a clipboard command; output beyond MAX_CLIPBOARD_BYTES, a timeout, or an abort count as failure. */
function run(command: string, args: string[], signal?: AbortSignal): Promise<CommandResult> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let stderr = "";
		let settled = false;
		const finish = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		const fail = () => {
			child.kill();
			finish({ found: true, ok: false, stdout: Buffer.alloc(0), stderr });
		};
		const onAbort = () => fail();
		const timer = setTimeout(fail, COMMAND_TIMEOUT_MS);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_CLIPBOARD_BYTES) fail();
			else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error: NodeJS.ErrnoException) =>
			finish({ found: error.code !== "ENOENT", ok: false, stdout: Buffer.alloc(0), stderr: error.message }),
		);
		child.on("close", (code) => finish({ found: true, ok: code === 0, stdout: Buffer.concat(chunks), stderr }));
	});
}

const baseType = (type: string) => type.split(";")[0].trim().toLowerCase();

function pickImageType(types: string[]): string | undefined {
	for (const preferred of IMAGE_TYPES) {
		const match = types.find((type) => baseType(type) === preferred);
		if (match) return match;
	}
	return undefined;
}

function pickTextType(types: string[]): string | undefined {
	for (const preferred of TEXT_TYPES) {
		const match = types.find((type) => type.toLowerCase() === preferred);
		if (match) return match;
	}
	return types.find((type) => baseType(type) === "text/plain");
}

/** The image format of raw bytes, from their signature. */
function imageTypeOf(bytes: Uint8Array): string | undefined {
	const head = Buffer.from(bytes.subarray(0, 12));
	if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
	if (head.toString("latin1", 0, 4) === "GIF8") return "image/gif";
	if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp";
	if (head.toString("latin1", 0, 2) === "BM") return "image/bmp";
	if (head.toString("latin1", 0, 4) === "II*\0" || head.toString("latin1", 0, 4) === "MM\0*") return "image/tiff";
	return undefined;
}

/** Reads the types a clipboard tool lists, then the text and the image among them. */
async function readByTypes(
	types: string[],
	want: Format | undefined,
	read: (type: string) => Promise<CommandResult>,
): Promise<Contents> {
	const contents: Contents = {};
	if (want !== "image") {
		const textType = pickTextType(types);
		if (textType) {
			const result = await read(textType);
			if (result.ok && result.stdout.length) contents.text = result.stdout.toString("utf8");
		}
	}
	if (want !== "text") {
		const imageType = pickImageType(types);
		if (imageType) {
			const result = await read(imageType);
			if (result.ok && result.stdout.length) contents.image = { bytes: result.stdout, mimeType: baseType(imageType) };
		} else {
			const other = types.find((type) => baseType(type).startsWith("image/"));
			if (other) {
				const result = await read(other);
				if (result.ok && result.stdout.length) contents.image = { bytes: result.stdout, mimeType: baseType(other) };
			}
		}
	}
	return contents;
}

const linesOf = (output: Buffer) =>
	output
		.toString("utf8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

async function readLinux(want: Format | undefined, signal?: AbortSignal): Promise<Contents> {
	if (process.env.WAYLAND_DISPLAY) {
		const list = await run("wl-paste", ["--list-types"], signal);
		if (list.ok) {
			return readByTypes(linesOf(list.stdout), want, (type) => run("wl-paste", ["--no-newline", "--type", type], signal));
		}
		// An empty Wayland clipboard; X11 might still hold something older that is no longer on the clipboard.
		if (list.found && /nothing is copied|no selection/i.test(list.stderr)) return {};
	}
	if (process.env.DISPLAY) {
		const xclip = (type: string) => run("xclip", ["-selection", "clipboard", "-t", type, "-o"], signal);
		const targets = await xclip("TARGETS");
		if (targets.ok) return readByTypes(linesOf(targets.stdout), want, xclip);
		if (targets.found) return {};
		const contents: Contents = {};
		const native = getNativeClipboard();
		if (want !== "image") {
			const xsel = await run("xsel", ["--clipboard", "--output"], signal);
			if (xsel.ok) contents.text = xsel.stdout.toString("utf8") || undefined;
			else if (native) contents.text = (await native.getText()) ?? undefined;
			else throw new Error("no clipboard tool: install xclip (or xsel for text only)");
		}
		if (want !== "text") {
			const bytes = native ? await native.getImage() : undefined;
			if (bytes === undefined && want === "image") throw new Error("reading images needs xclip: install it");
			if (bytes?.length) contents.image = { bytes: Buffer.from(bytes), mimeType: imageTypeOf(bytes) ?? "image/png" };
		}
		return contents;
	}
	if (process.env.WAYLAND_DISPLAY) throw new Error("no clipboard tool: install wl-clipboard (wl-paste)");
	throw new Error(
		process.env.SSH_CONNECTION || process.env.SSH_CLIENT
			? "no clipboard to read over SSH: the clipboard of the machine in front of you cannot be reached from here"
			: "no clipboard: this session has no display (neither WAYLAND_DISPLAY nor DISPLAY is set)",
	);
}

async function readMac(want: Format | undefined, signal?: AbortSignal): Promise<Contents> {
	const contents: Contents = {};
	const native = getNativeClipboard();
	if (want !== "text") {
		// Files copied in Finder bring their icon as an image along; the paths are what counts then.
		const files = want === undefined ? await native?.getFilePaths?.() : undefined;
		if (files?.length) contents.files = files;
		else {
			const bytes = native ? await native.getImage() : undefined;
			if (bytes?.length) contents.image = { bytes: Buffer.from(bytes), mimeType: imageTypeOf(bytes) ?? "image/png" };
			else if (bytes === undefined && want === "image") throw new Error("reading images needs Pi's native clipboard helper, which did not load");
		}
	}
	// The text of copied files is their names, already among the paths.
	if (want !== "image" && !contents.files) {
		const text = native ? await native.getText() : undefined;
		if (text !== undefined) contents.text = text ?? undefined;
		else {
			const pbpaste = await run("pbpaste", [], signal);
			if (!pbpaste.ok) throw new Error(`pbpaste failed: ${pbpaste.stderr.trim() || "no output"}`);
			contents.text = pbpaste.stdout.toString("utf8") || undefined;
		}
	}
	return contents;
}

function readClipboard(want: Format | undefined, signal?: AbortSignal): Promise<Contents> {
	if (process.platform === "darwin") return readMac(want, signal);
	if (process.platform === "linux") return readLinux(want, signal);
	throw new Error(`reading the clipboard is supported on Linux and macOS, not on ${process.platform}`);
}

/** Width and height from a PNG, JPEG, or GIF header; undefined for other formats. */
function dimensionsOf(image: ClipboardImage): { width: number; height: number } | undefined {
	const b = image.bytes;
	if (image.mimeType === "image/png" && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
	if (image.mimeType === "image/gif" && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
	if (image.mimeType === "image/jpeg") {
		for (let i = 2; i + 9 < b.length; ) {
			if (b[i] !== 0xff) return undefined;
			const marker = b[i + 1];
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
			}
			i += 2 + b.readUInt16BE(i + 2);
		}
	}
	return undefined;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What the clipboard holds, without its content: for the confirmation and the tool's display. */
function describe(contents: Contents): string {
	const parts: string[] = [];
	if (contents.files) parts.push(plural(contents.files.length, "file"));
	if (contents.text !== undefined) {
		parts.push(`text, ${plural(contents.text.split("\n").length, "line")}, ${plural(contents.text.length, "character")}`);
	}
	if (contents.image) {
		const size = dimensionsOf(contents.image);
		parts.push(
			`image, ${contents.image.mimeType.replace("image/", "").toUpperCase()}` +
				(size ? `, ${size.width}×${size.height}` : "") +
				`, ${formatSize(contents.image.bytes.length)}`,
		);
	}
	return parts.join("; ") || "nothing";
}

interface Config {
	confirmRead: boolean;
	problem?: string;
}

function loadConfig(): Config {
	let config: any;
	try {
		config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { confirmRead: true };
		return { confirmRead: true, problem: `${CONFIG_FILE} is not valid JSON, so reading asks first` };
	}
	if (config?.confirmRead === undefined) return { confirmRead: true };
	if (typeof config.confirmRead !== "boolean") {
		return { confirmRead: true, problem: `${CONFIG_FILE}: confirmRead must be true or false, so reading asks first` };
	}
	return { confirmRead: config.confirmRead };
}

const tempDirs: string[] = [];

/** Saves the full clipboard text where only its owner can read it, for the rest after a cut. */
function saveText(text: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-clipboard-"));
	tempDirs.push(dir);
	const file = path.join(dir, "clipboard.txt");
	writeFileSync(file, text, { mode: 0o600 });
	return file;
}

/** The text as the model gets it: cut at Pi's output limit, the rest in a temp file. */
function textBlock(text: string): string {
	const cut = truncateHead(text);
	if (!cut.truncated) return text;
	const head = cut.content || Buffer.from(text).subarray(0, DEFAULT_MAX_BYTES).toString("utf8").replace(/\uFFFD$/, "");
	const file = saveText(text);
	return (
		`${head}\n\n[Clipboard text cut at ${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines: ` +
		`${plural(cut.totalLines, "line")}, ${formatSize(cut.totalBytes)} in all. The full text is in ${file}.]`
	);
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

async function imageBlocks(image: ClipboardImage, pi: ExtensionAPI, ctx: ExtensionContext): Promise<Content[]> {
	let data = image.bytes.toString("base64");
	let mimeType = image.mimeType;
	const notes: string[] = [];
	if (!IMAGE_TYPES.includes(mimeType)) {
		const png = await convertToPng(data, mimeType);
		if (!png) return [{ type: "text", text: `[Clipboard image (${mimeType}) omitted: it could not be converted to PNG.]` }];
		notes.push(`[Image converted from ${mimeType} to ${png.mimeType}.]`);
		({ data, mimeType } = png);
	}
	const settings = pi.getSettings() as { images?: { autoResize?: boolean } };
	if (settings.images?.autoResize !== false) {
		const model = ctx.model as { inputLimits?: { images?: { resize?: Parameters<typeof resizeImage>[2] } } } | undefined;
		const resized = await resizeImage(Buffer.from(data, "base64"), mimeType, model?.inputLimits?.images?.resize);
		if (!resized) return [{ type: "text", text: "[Clipboard image omitted: it could not be made small enough for the model.]" }];
		({ data, mimeType } = resized);
		const note = formatDimensionNote(resized);
		if (note) notes.push(note);
	}
	if (ctx.model && !ctx.model.input.includes("image")) {
		notes.push("[The current model does not take images; the image is left out of the request.]");
	}
	return [
		{ type: "text", text: [`Clipboard image [${mimeType}]`, ...notes].join("\n") },
		{ type: "image", data, mimeType },
	];
}

const trustedUI = (ctx: ExtensionContext) => ctx.hasUI && !process.env.PI_SUBAGENT_DEPTH;

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", () => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	pi.registerTool({
		name: "clipboard",
		label: "Clipboard",
		description:
			"Read or write the system clipboard of the user's machine (Linux or macOS). action read returns what it holds: " +
			"text, an image (a copied screenshot, for one), and on macOS the paths of files copied in Finder; format text " +
			"or image asks for one of them only. The user may be asked to allow each read and may decline it. Text over " +
			`${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines is cut, the full text saved to a temp file. ` +
			"action write replaces the clipboard with text (over SSH it goes to the user's terminal by OSC 52).",
		promptSnippet: "Read and write the system clipboard (text and images)",
		promptGuidelines: [
			"clipboard: read it when the user refers to what they copied (the clipboard, a copied screenshot, \"what I just copied\"); never read it on your own initiative.",
			"clipboard: write to it only when the user asks for something to be copied; it replaces what they had copied.",
		],
		parameters: Type.Object({
			action: StringEnum(["read", "write"] as const, { description: "read the clipboard, or write text to it" }),
			text: Type.Optional(Type.String({ description: "The text to put on the clipboard (write)" })),
			format: Type.Optional(
				StringEnum(["text", "image"] as const, { description: "read only the text or only the image (default: both)" }),
			),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },

		async execute(_id, params, signal, _onUpdate, ctx) {
			if (params.action === "write") {
				if (params.text === undefined) throw new Error("write needs text");
				await copyToClipboard(params.text);
				const text = params.text;
				return {
					content: [
						{
							type: "text",
							text: `Copied ${plural(text.length, "character")} (${plural(text.split("\n").length, "line")}) to the clipboard.`,
						},
					],
					details: undefined,
				};
			}

			const config = loadConfig();
			if (config.problem && ctx.hasUI) ctx.ui.notify(`clipboard: ${config.problem}`, "warning");
			if (config.confirmRead && !trustedUI(ctx)) {
				throw new Error(
					"reading the clipboard needs the user's consent, and this session cannot ask for it; " +
						`{"confirmRead": false} in ${CONFIG_FILE} allows reading without asking`,
				);
			}
			const want = params.format as Format | undefined;
			const contents = await readClipboard(want, signal);
			const summary = describe(contents);
			const nothing = !contents.text && !contents.image && !contents.files;
			if (nothing) {
				const what = want === "text" ? "no text" : want === "image" ? "no image" : "nothing";
				return { content: [{ type: "text", text: `The clipboard holds ${what}.` }], details: undefined };
			}
			if (config.confirmRead) {
				const provider = ctx.model?.provider ? `the model's provider (${ctx.model.provider})` : "the model's provider";
				const allowed = await ctx.ui.confirm(
					"Read the clipboard?",
					`The model wants to read the clipboard: ${summary}. What it reads goes to ${provider}.`,
					{ signal },
				);
				if (!allowed) throw new Error("the user declined to let the clipboard be read; ask them to paste what you need instead");
			}

			const content: Content[] = [];
			if (contents.files) content.push({ type: "text", text: `Files copied:\n${contents.files.join("\n")}` });
			if (contents.text) content.push({ type: "text", text: textBlock(contents.text) });
			if (contents.image) content.push(...(await imageBlocks(contents.image, pi, ctx)));
			return { content, details: undefined };
		},

		renderCall(args, theme) {
			const text = args.text as string | undefined;
			const detail =
				args.action === "write" && text !== undefined
					? `write · ${plural(text.split("\n").length, "line")}, ${plural(text.length, "character")}`
					: `${args.action ?? "read"}${args.format ? ` · ${args.format}` : ""}`;
			return new Text(theme.fg("toolTitle", theme.bold("clipboard ")) + theme.fg("muted", detail), 0, 0);
		},
	});
}
