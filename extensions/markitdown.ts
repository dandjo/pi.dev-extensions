/**
 * markitdown: documents as Markdown for the model, after Microsoft's markitdown (https://github.com/microsoft/markitdown),
 * written anew in TypeScript, without Python and without dependencies.
 *
 * - The tool markitdown reads a document as Markdown: PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), EPUB, HTML,
 *   CSV and TSV, Jupyter notebooks, RSS and Atom feeds, and ZIP archives of these, under a heading per file. offset and
 *   limit page through the Markdown's lines as read pages through a file, cut at the same 2000 lines or 50 KB; saveTo
 *   writes the whole Markdown to a file instead.
 * - read returns PDF, Office, EPUB, and ZIP files as the same Markdown, offset and limit counting its lines, so the
 *   model gets text where it would get bytes, whichever of the two tools it picks. Other files read as before.
 * - The Markdown follows markitdown's: headings, lists, tables, links, footnotes, and equations (as LaTeX) of Word
 *   documents; titles, text, tables, charts as tables, picture placeholders, and notes of slides; a table per sheet;
 *   the article of a page saved from Wikipedia or another MediaWiki site. Pictures stay placeholders, their bytes are
 *   never read.
 * - PDF goes through pdftotext from Poppler, which has to be on the PATH (poppler-utils on Linux, brew install poppler
 *   on macOS): its text page by page, a marker before each page, and pages laid out as forms or borderless tables as
 *   Markdown tables, as markitdown finds them. A scan without a text layer has no text; there is no OCR.
 * - Not converted: the old binary Office formats (.doc, .xls, .ppt), OpenDocument, and Outlook messages; the tool says
 *   how to save them in a format it reads. Unlike markitdown, no images, audio, YouTube, and no cloud services.
 * - Limits: files up to 256 MB, ZIP archives unpacking to at most 512 MB, archives in archives two levels deep,
 *   pdftotext two minutes per PDF. The last eight documents stay converted while their size and time stay the same.
 */

import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	type TruncationResult,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** Larger files are not converted. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** What the entries of a ZIP archive may unpack to together, against archives that inflate a thousandfold. */
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
/** ZIP archives in ZIP archives are opened this many levels deep. */
const MAX_ZIP_DEPTH = 2;
const ZIP_TOO_LARGE = `the ZIP archive unpacks to more than ${formatSize(MAX_UNPACKED_BYTES)}`;
const ZIP_TOO_DEEP = `not opened: ZIP archives in ZIP archives are opened ${MAX_ZIP_DEPTH} levels deep`;
/** pdftotext's text beyond this is not taken. */
const MAX_PDF_TEXT_BYTES = 64 * 1024 * 1024;
/** pdftotext's word layout is some twenty times as long as the text; a larger one leaves the PDF to plain text. */
const MAX_PDF_LAYOUT_BYTES = 128 * 1024 * 1024;
const PDF_TIMEOUT_MS = 120_000;
/** Conversions kept, so that paging through a document with offset converts it once. */
const CACHE_SIZE = 8;

/** A failure the model can act on: its message goes to the model as it is. */
class ConvertError extends Error {}

// ---------------------------------------------------------------------------------------------------------------------
// Text

/** The named entities of HTML 4: Latin-1 (U+00A0 to U+00FF, in order) and the common typographic ones. */
const LATIN1 =
	"nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro " +
	"para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil " +
	"Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave " +
	"Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml " +
	"igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute " +
	"thorn yuml";

const ENTITIES: Record<string, string> = {
	...Object.fromEntries(LATIN1.split(" ").map((name, i) => [name, String.fromCharCode(0xa0 + i)])),
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ",
	fnof: "ƒ", circ: "ˆ", tilde: "˜", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", zwnj: "\u200c", zwj: "\u200d",
	lrm: "\u200e", rlm: "\u200f", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”",
	bdquo: "„", dagger: "†", Dagger: "‡", bull: "•", hellip: "…", permil: "‰", prime: "′", Prime: "″", lsaquo: "‹",
	rsaquo: "›", oline: "‾", frasl: "⁄", euro: "€", trade: "™", larr: "←", uarr: "↑", rarr: "→", darr: "↓", harr: "↔",
	minus: "−", le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞",
};

function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, entity: string) => {
		if (entity[0] !== "#") return ENTITIES[entity] ?? whole;
		const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});
}

/**
 * Bytes as text: by their byte order mark, else in the charset the caller found declared, else as UTF-8 where they
 * are valid UTF-8, else as Shift JIS where that gives mostly Japanese, else as Windows-1252.
 */
function decodeText(buf: Uint8Array, declared?: string): string {
	if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder("utf-8").decode(buf.subarray(3));
	if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
	if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
	if (declared) {
		try {
			return new TextDecoder(declared).decode(buf);
		} catch {
			// A charset TextDecoder does not know: guess as without one.
		}
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		// Not UTF-8.
	}
	try {
		const text = new TextDecoder("shift_jis", { fatal: true }).decode(buf);
		const japanese = text.match(/[\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9f]/g)?.length ?? 0;
		const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
		if (japanese > 0 && japanese >= (japanese + latin) * 0.3) return text;
	} catch {
		// Not Shift JIS.
	}
	return new TextDecoder("windows-1252").decode(buf);
}

/** Code page 437, the charset of ZIP entry names without the UTF-8 flag: its upper half. */
const CP437 =
	"ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
	"αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

function decodeZipName(raw: Buffer, utf8Flag: boolean): string {
	if (utf8Flag) return raw.toString("utf8");
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(raw);
	} catch {
		return Array.from(raw, (b) => (b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80])).join("");
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// ZIP

interface ZipEntry {
	method: number;
	flags: number;
	compressedSize: number;
	size: number;
	offset: number;
}

/** A ZIP archive in memory: its directory read at once, an entry unpacked when asked for. */
class Zip {
	readonly entries = new Map<string, ZipEntry>();
	private readonly lower = new Map<string, string>();

	constructor(
		private readonly buf: Buffer,
		readonly budget = { left: MAX_UNPACKED_BYTES },
	) {
		try {
			this.readDirectory();
		} catch (error) {
			if (error instanceof ConvertError) throw error;
			throw new ConvertError("the ZIP archive is damaged");
		}
	}

	private readDirectory(): void {
		const buf = this.buf;
		let end = -1;
		for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
			if (buf.readUInt32LE(i) === 0x06054b50) {
				end = i;
				break;
			}
		}
		if (end < 0) throw new ConvertError("not a ZIP archive, or a damaged one (no central directory)");
		let count = buf.readUInt16LE(end + 10);
		let offset = buf.readUInt32LE(end + 16);
		if ((count === 0xffff || offset === 0xffffffff) && end >= 20 && buf.readUInt32LE(end - 20) === 0x07064b50) {
			const zip64 = Number(buf.readBigUInt64LE(end - 12));
			if (buf.readUInt32LE(zip64) === 0x06064b50) {
				count = Number(buf.readBigUInt64LE(zip64 + 32));
				offset = Number(buf.readBigUInt64LE(zip64 + 48));
			}
		}
		let p = offset;
		for (let n = 0; n < count; n++) {
			if (buf.readUInt32LE(p) !== 0x02014b50) throw new ConvertError("the ZIP archive is damaged (central directory)");
			const flags = buf.readUInt16LE(p + 8);
			const method = buf.readUInt16LE(p + 10);
			let compressedSize = buf.readUInt32LE(p + 20);
			let size = buf.readUInt32LE(p + 24);
			const nameLength = buf.readUInt16LE(p + 28);
			const extraLength = buf.readUInt16LE(p + 30);
			const commentLength = buf.readUInt16LE(p + 32);
			let entryOffset = buf.readUInt32LE(p + 42);
			const name = decodeZipName(buf.subarray(p + 46, p + 46 + nameLength), (flags & 0x800) !== 0);
			for (let e = p + 46 + nameLength; e + 4 <= p + 46 + nameLength + extraLength; ) {
				const id = buf.readUInt16LE(e);
				const length = buf.readUInt16LE(e + 2);
				if (id === 0x0001) {
					let q = e + 4;
					if (size === 0xffffffff) (size = Number(buf.readBigUInt64LE(q))), (q += 8);
					if (compressedSize === 0xffffffff) (compressedSize = Number(buf.readBigUInt64LE(q))), (q += 8);
					if (entryOffset === 0xffffffff) entryOffset = Number(buf.readBigUInt64LE(q));
				}
				e += 4 + length;
			}
			this.entries.set(name, { method, flags, compressedSize, size, offset: entryOffset });
			this.lower.set(name.toLowerCase(), name);
			p += 46 + nameLength + extraLength + commentLength;
		}
	}

	/** The entry's name as stored, found also where its case differs: Office part names ignore case. */
	name(name: string): string | undefined {
		const plain = name.replace(/^\/+/, "");
		return this.entries.has(plain) ? plain : this.lower.get(plain.toLowerCase());
	}

	bytes(name: string): Buffer | undefined {
		const stored = this.name(name);
		const entry = stored === undefined ? undefined : this.entries.get(stored);
		if (!entry) return undefined;
		if (entry.flags & 1) throw new ConvertError(`${stored} in the ZIP archive is encrypted`);
		const buf = this.buf;
		const p = entry.offset;
		if (buf.readUInt32LE(p) !== 0x04034b50) throw new ConvertError("the ZIP archive is damaged (local header)");
		const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
		const raw = buf.subarray(start, start + entry.compressedSize);
		// The size the directory declares is checked before unpacking, and unpacking stops beyond it.
		if (entry.size > this.budget.left) throw this.tooLarge();
		let data: Buffer;
		if (entry.method === 0) data = raw;
		else if (entry.method === 8) {
			try {
				data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
					throw new ConvertError(`${stored} in the ZIP archive unpacks to more than it declares`);
				}
				throw new ConvertError(`${stored} in the ZIP archive is damaged`);
			}
		} else throw new ConvertError(`${stored} in the ZIP archive is compressed with method ${entry.method}; only deflate is read`);
		if (data.length > this.budget.left) throw this.tooLarge();
		this.budget.left -= data.length;
		return data;
	}

	/** A ZIP archive inside this one, sharing its budget. */
	zip(name: string): Zip | undefined {
		const data = this.bytes(name);
		return data && new Zip(data, this.budget);
	}

	text(name: string): string | undefined {
		const data = this.bytes(name);
		return data && decodeText(data);
	}

	xml(name: string): El | undefined {
		const text = this.text(name);
		return text === undefined ? undefined : parseXml(text);
	}

	private tooLarge(): ConvertError {
		return new ConvertError(ZIP_TOO_LARGE);
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// XML and HTML

type Attrs = Record<string, string>;
interface El {
	name: string;
	attrs: Attrs;
	children: Node[];
	parent: El | null;
}
type Node = El | string;

interface MarkupHandler {
	open(name: string, attrs: Attrs, selfClosing: boolean): void;
	close(name: string): void;
	text(text: string): void;
}

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;

/** A start tag at src[lt]; null where "<" starts no tag ("a < b" in HTML). */
function readTag(src: string, lt: number): { name: string; attrs: Attrs; selfClosing: boolean; end: number } | null {
	const n = src.length;
	let i = lt + 1;
	const first = src.charCodeAt(i);
	if (!((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a) || first === 0x5f || first === 0x3a)) return null;
	while (i < n && !isSpace(src.charCodeAt(i)) && src[i] !== ">" && src[i] !== "/") i++;
	const name = src.slice(lt + 1, i);
	const attrs: Attrs = {};
	for (;;) {
		while (i < n && isSpace(src.charCodeAt(i))) i++;
		if (i >= n) return null;
		if (src[i] === ">") return { name, attrs, selfClosing: false, end: i + 1 };
		if (src[i] === "/") {
			if (src[i + 1] === ">") return { name, attrs, selfClosing: true, end: i + 2 };
			i++;
			continue;
		}
		const start = i;
		while (i < n && !isSpace(src.charCodeAt(i)) && src[i] !== "=" && src[i] !== ">" && src[i] !== "/") i++;
		const key = src.slice(start, i);
		while (i < n && isSpace(src.charCodeAt(i))) i++;
		if (src[i] !== "=") {
			if (key) attrs[key] = "";
			if (i === start) i++;
			continue;
		}
		i++;
		while (i < n && isSpace(src.charCodeAt(i))) i++;
		let value: string;
		if (src[i] === '"' || src[i] === "'") {
			const close = src.indexOf(src[i], i + 1);
			if (close < 0) return null;
			value = src.slice(i + 1, close);
			i = close + 1;
		} else {
			const from = i;
			while (i < n && !isSpace(src.charCodeAt(i)) && src[i] !== ">") i++;
			value = src.slice(from, i);
		}
		if (key) attrs[key] = decodeEntities(value);
	}
}

/** Walks markup: tags, text with its entities resolved, CDATA; comments, doctypes, and processing instructions skipped. */
function scanMarkup(src: string, handler: MarkupHandler, rawText?: Set<string>): void {
	const n = src.length;
	let i = 0;
	while (i < n) {
		const lt = src.indexOf("<", i);
		if (lt < 0) {
			handler.text(decodeEntities(src.slice(i)));
			break;
		}
		if (lt > i) handler.text(decodeEntities(src.slice(i, lt)));
		const next = src[lt + 1];
		if (src.startsWith("<!--", lt)) {
			const end = src.indexOf("-->", lt + 4);
			i = end < 0 ? n : end + 3;
		} else if (src.startsWith("<![CDATA[", lt)) {
			const end = src.indexOf("]]>", lt + 9);
			handler.text(src.slice(lt + 9, end < 0 ? n : end));
			i = end < 0 ? n : end + 3;
		} else if (next === "!" || next === "?") {
			const end = src.indexOf(">", lt + 2);
			i = end < 0 ? n : end + 1;
		} else if (next === "/") {
			const end = src.indexOf(">", lt + 2);
			if (end < 0) {
				handler.text(decodeEntities(src.slice(lt)));
				break;
			}
			const name = src.slice(lt + 2, end).trim().split(/\s/)[0];
			if (name) handler.close(name);
			i = end + 1;
		} else {
			const tag = readTag(src, lt);
			if (!tag) {
				handler.text("<");
				i = lt + 1;
				continue;
			}
			handler.open(tag.name, tag.attrs, tag.selfClosing);
			i = tag.end;
			if (rawText && !tag.selfClosing && rawText.has(tag.name.toLowerCase())) {
				const close = new RegExp(`</${tag.name}\\s*>`, "ig");
				close.lastIndex = i;
				const match = close.exec(src);
				handler.text(src.slice(i, match ? match.index : n));
				handler.close(tag.name);
				i = match ? match.index + match[0].length : n;
			}
		}
	}
}

const localName = (name: string) => name.slice(name.indexOf(":") + 1);

/**
 * An XML document, elements named without their namespace prefix. Whitespace between elements is left out, except
 * in the elements that hold text (t in all the Office formats).
 */
function parseXml(src: string): El {
	const root: El = { name: "#document", attrs: {}, children: [], parent: null };
	let current = root;
	scanMarkup(src, {
		open(name, attrs, selfClosing) {
			const el: El = { name: localName(name), attrs, children: [], parent: current };
			current.children.push(el);
			if (!selfClosing) current = el;
		},
		close(name) {
			const local = localName(name);
			for (let e: El | null = current; e && e !== root; e = e.parent) {
				if (e.name === local) {
					current = e.parent ?? root;
					return;
				}
			}
		},
		text(text) {
			if (current.name === "t" || /\S/.test(text)) current.children.push(text);
		},
	});
	return root;
}

const VOID_ELEMENTS = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp"]);
const CLOSES_P = new Set(
	("address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 " +
		"header hgroup hr main menu nav ol p pre section table ul").split(" "),
);

/** An HTML document, as forgiving as needed for the HTML that is out there: unclosed p, li, td, and the like. */
function parseHtml(src: string): El {
	const root: El = { name: "#document", attrs: {}, children: [], parent: null };
	let current = root;
	const closeOpen = (names: string[], stopAt: string[]) => {
		for (let e: El | null = current; e && e !== root; e = e.parent) {
			if (stopAt.includes(e.name)) return;
			if (names.includes(e.name)) {
				current = e.parent ?? root;
				return;
			}
		}
	};
	scanMarkup(
		src,
		{
			open(raw, attrs, selfClosing) {
				const name = raw.toLowerCase();
				if (CLOSES_P.has(name)) closeOpen(["p"], ["table", "td", "th", "caption", "button", "li"]);
				if (name === "li") closeOpen(["li"], ["ul", "ol", "table"]);
				if (name === "dt" || name === "dd") closeOpen(["dt", "dd"], ["dl", "table"]);
				if (name === "tr") closeOpen(["tr"], ["table"]);
				if (name === "td" || name === "th") closeOpen(["td", "th"], ["tr", "table"]);
				if (name === "thead" || name === "tbody" || name === "tfoot") closeOpen(["thead", "tbody", "tfoot"], ["table"]);
				const lowered: Attrs = {};
				for (const key in attrs) lowered[key.toLowerCase()] = attrs[key];
				const el: El = { name, attrs: lowered, children: [], parent: current };
				current.children.push(el);
				if (!selfClosing && !VOID_ELEMENTS.has(name)) current = el;
			},
			close(raw) {
				const name = raw.toLowerCase();
				for (let e: El | null = current; e && e !== root; e = e.parent) {
					if (e.name === name) {
						current = e.parent ?? root;
						return;
					}
				}
			},
			text(text) {
				current.children.push(text);
			},
		},
		RAW_TEXT_ELEMENTS,
	);
	return root;
}

function elements(el: El, name?: string): El[] {
	const out: El[] = [];
	for (const c of el.children) if (typeof c !== "string" && (name === undefined || c.name === name)) out.push(c);
	return out;
}

function child(el: El | undefined, name: string): El | undefined {
	if (!el) return undefined;
	for (const c of el.children) if (typeof c !== "string" && c.name === name) return c;
	return undefined;
}

function find(el: El | undefined, name: string): El | undefined {
	if (!el) return undefined;
	for (const c of el.children) {
		if (typeof c === "string") continue;
		if (c.name === name) return c;
		const deeper = find(c, name);
		if (deeper) return deeper;
	}
	return undefined;
}

function findAll(el: El | undefined, name: string, out: El[] = []): El[] {
	if (!el) return out;
	for (const c of el.children) {
		if (typeof c === "string") continue;
		if (c.name === name) out.push(c);
		else findAll(c, name, out);
	}
	return out;
}

function textOf(node: Node | undefined): string {
	if (node === undefined) return "";
	if (typeof node === "string") return node;
	let s = "";
	for (const c of node.children) s += textOf(c);
	return s;
}

/** An attribute by its local name: "val" finds w:val. */
function attr(el: El | undefined, local: string): string | undefined {
	if (!el) return undefined;
	if (local in el.attrs) return el.attrs[local];
	for (const key in el.attrs) if (key.endsWith(`:${local}`) && !key.startsWith("xmlns")) return el.attrs[key];
	return undefined;
}

/** An attribute of the relationships namespace by its local name: r:id beside the id of a p:sldId. */
function relAttr(el: El | undefined, local: string): string | undefined {
	if (!el) return undefined;
	for (const key in el.attrs) {
		const colon = key.indexOf(":");
		if (colon < 0 || key.slice(colon + 1) !== local || key.startsWith("xmlns")) continue;
		const prefix = key.slice(0, colon);
		for (let e: El | null = el; e; e = e.parent) {
			const uri = e.attrs[`xmlns:${prefix}`];
			if (uri === undefined) continue;
			if (uri.endsWith("/relationships")) return el.attrs[key];
			break;
		}
	}
	return undefined;
}

/** On unless set to 0, false, or off: OOXML's toggles, <w:b/> as much as <w:b w:val="true"/>. */
function toggle(el: El | undefined): boolean {
	if (!el) return false;
	const value = attr(el, "val");
	return value === undefined || !/^(0|false|off|none)$/i.test(value);
}

// ---------------------------------------------------------------------------------------------------------------------
// Office packages

interface Rel {
	type: string;
	target: string;
	external: boolean;
}

function resolvePart(dir: string, target: string): string {
	let decoded = target;
	try {
		decoded = decodeURIComponent(target);
	} catch {
		// Not percent-encoded after all.
	}
	const joined = decoded.startsWith("/") ? decoded : path.posix.join(dir, decoded);
	return path.posix.normalize(joined).replace(/^\/+/, "");
}

/** A part's relationships by id: the target resolved against the part's folder, unless external. */
function relationships(zip: Zip, part: string): Map<string, Rel> {
	const map = new Map<string, Rel>();
	const dir = path.posix.dirname(part);
	const folder = dir === "." ? "" : `${dir}/`;
	const doc = zip.xml(`${folder}_rels/${path.posix.basename(part)}.rels`);
	for (const r of findAll(doc, "Relationship")) {
		const id = attr(r, "Id");
		if (!id) continue;
		const type = attr(r, "Type") ?? "";
		const external = attr(r, "TargetMode") === "External";
		const target = attr(r, "Target") ?? "";
		map.set(id, {
			type: type.slice(type.lastIndexOf("/") + 1),
			target: external ? target : resolvePart(dir === "." ? "" : dir, target),
			external,
		});
	}
	return map;
}

function relOfType(rels: Map<string, Rel>, type: string): Rel | undefined {
	for (const rel of rels.values()) if (rel.type === type) return rel;
	return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// HTML to Markdown, as markdownify writes it for markitdown

const BLOCK_ELEMENTS = new Set("p blockquote article div section ol ul li dl dt dd table thead tbody tfoot tr td th".split(" "));
const isHeading = (name: string) => /^h\d/.test(name);
const isEl = (node: Node | undefined): node is El => typeof node === "object" && node !== null;
/** Whitespace just inside these elements is dropped. */
const dropsInside = (node: Node | undefined) => isEl(node) && (isHeading(node.name) || BLOCK_ELEMENTS.has(node.name));
/** Whitespace just outside these elements is dropped. */
const dropsOutside = (node: Node | undefined) => dropsInside(node) || (isEl(node) && node.name === "pre");

/** An element for a tree built in code, its children's parents set. */
function h(name: string, attrs: Attrs = {}, children: Node[] = []): El {
	const el: El = { name, attrs, children: [], parent: null };
	for (const c of children) {
		el.children.push(c);
		if (typeof c !== "string") c.parent = el;
	}
	return el;
}

/** The Markdown of an HTML tree: of its body if it has one. */
function htmlTreeToMarkdown(root: El): string {
	return mdElement(find(root, "body") ?? root, new Set()).trim();
}

function htmlToMarkdown(html: string): string {
	return htmlTreeToMarkdown(parseHtml(html));
}

function mdElement(el: El, tags: Set<string>): string {
	const kids = el.children;
	const inside = dropsInside(el);
	const childTags = new Set(tags).add(el.name);
	if (isHeading(el.name) || el.name === "td" || el.name === "th") childTags.add("_inline");
	if (el.name === "pre" || el.name === "code" || el.name === "kbd" || el.name === "samp" || el.name === "#math") {
		childTags.add("_noformat");
	}
	const parts: string[] = [];
	for (let i = 0; i < kids.length; i++) {
		const c = kids[i];
		if (typeof c === "string" && !/\S/.test(c)) {
			if (inside && (i === 0 || i === kids.length - 1)) continue;
			if (dropsOutside(kids[i - 1]) || dropsOutside(kids[i + 1])) continue;
		}
		const s = typeof c === "string" ? mdText(el, i, c, childTags) : mdElement(c, childTags);
		if (s) parts.push(s);
	}
	let text: string;
	if (el.name === "pre" || tags.has("pre")) text = parts.join("");
	else {
		// Newlines where two children meet: the larger run of the two, at most two.
		const out = [""];
		for (const s of parts) {
			const m = /^(\n*)((?:[\s\S]*[^\n])?)(\n*)$/.exec(s) as RegExpExecArray;
			let lead = m[1];
			if (out[out.length - 1] && lead) {
				const trail = out.pop() as string;
				lead = "\n".repeat(Math.min(2, Math.max(trail.length, lead.length)));
			}
			out.push(lead, m[2], m[3]);
		}
		text = out.join("");
	}
	return mdConvert(el, text, tags);
}

function mdText(parent: El, i: number, raw: string, tags: Set<string>): string {
	let text = raw;
	if (!tags.has("pre")) text = text.replace(/(?<![\t \r\n])[\t \r\n]*[\r\n][\t \r\n]*/g, "\n").replace(/[\t ]+/g, " ");
	if (!tags.has("_noformat")) text = text.replace(/\*/g, "\\*").replace(/_/g, "\\_");
	const kids = parent.children;
	if (dropsOutside(kids[i - 1]) || (dropsInside(parent) && i === 0)) text = text.replace(/^[ \t\r\n]+/, "");
	if (dropsOutside(kids[i + 1]) || (dropsInside(parent) && i === kids.length - 1)) text = text.trimEnd();
	return text;
}

/** A space at either end moves outside the markup: "<b> x</b>" is " **x**". */
function chomp(text: string): [string, string, string] {
	return [text.startsWith(" ") ? " " : "", text.endsWith(" ") ? " " : "", text.trim()];
}

function mdInline(markup: string, text: string, tags: Set<string>): string {
	if (tags.has("_noformat")) return text;
	const [prefix, suffix, t] = chomp(text);
	return t ? `${prefix}${markup}${t}${markup}${suffix}` : "";
}

/** The path of a URL percent-encoded as Python's quote does it, %XX kept; scheme, host, query, and fragment as they are. */
function quoteUrlPath(href: string): string {
	const m = /^((?:[a-zA-Z][a-zA-Z0-9+.-]*:)?(?:\/\/[^/?#]*)?)([^?#]*)([\s\S]*)$/.exec(href);
	if (!m) return href;
	const [, start, pathPart, rest] = m;
	const semicolon = pathPart.indexOf(";", pathPart.lastIndexOf("/") + 1);
	const p = semicolon < 0 ? pathPart : pathPart.slice(0, semicolon);
	const params = semicolon < 0 ? "" : pathPart.slice(semicolon);
	let quoted = "";
	for (let i = 0; i < p.length; ) {
		const cp = p.codePointAt(i) as number;
		const ch = String.fromCodePoint(cp);
		if (/[A-Za-z0-9_.\-~/]/.test(ch)) quoted += ch;
		else if (ch === "%" && /^[0-9A-Fa-f]{2}$/.test(p.slice(i + 1, i + 3))) quoted += "%";
		else for (const b of Buffer.from(ch, "utf8")) quoted += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
		i += ch.length;
	}
	return start + quoted + params + rest;
}

const previousElementSibling = (el: El) => {
	const kids = el.parent?.children ?? [];
	for (let i = kids.indexOf(el) - 1; i >= 0; i--) if (isEl(kids[i])) return kids[i] as El;
	return undefined;
};
/** The next sibling with content: an element, or text that is not just whitespace. */
const nextContentSibling = (el: El) => {
	const kids = el.parent?.children ?? [];
	for (let i = kids.indexOf(el) + 1; i < kids.length; i++) {
		const c = kids[i];
		if (isEl(c) || /\S/.test(c)) return c;
	}
	return undefined;
};

/** All descendants with one of the names, nested ones included. */
function descendants(el: El | undefined, names: string[], out: El[] = []): El[] {
	if (!el) return out;
	for (const c of el.children) {
		if (!isEl(c)) continue;
		if (names.includes(c.name)) out.push(c);
		descendants(c, names, out);
	}
	return out;
}

const colspan = (cell: El) => (/^\d+$/.test(cell.attrs.colspan ?? "") ? Math.max(1, Math.min(1000, Number(cell.attrs.colspan))) : 1);
const indentLines = (text: string, indent: string) => text.replace(/^(.*)$/gm, (_, line: string) => (line ? indent + line : ""));

function mdConvert(el: El, text: string, tags: Set<string>): string {
	const inline = tags.has("_inline");
	switch (el.name) {
		case "#document":
			return text.replace(/^\n+|\n+$/g, "");
		case "#math":
			return text;
		case "a": {
			const [prefix, suffix, t] = chomp(text);
			if (!t) return "";
			if (tags.has("pre")) return t;
			let href = el.attrs.href;
			const title = el.attrs.title;
			if (href) {
				const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)?.[1].toLowerCase();
				if (scheme && scheme !== "http" && scheme !== "https" && scheme !== "file") return prefix + t + suffix;
				href = quoteUrlPath(href);
			}
			if (href && t.replace(/\\_/g, "_") === href && !title) return `<${href}>`;
			const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
			return href ? `${prefix}[${t}](${href}${titlePart})${suffix}` : t;
		}
		case "b":
		case "strong":
			return mdInline("**", text, tags);
		case "i":
		case "em":
			return mdInline("*", text, tags);
		case "del":
		case "s":
		case "strike":
			return mdInline("~~", text, tags);
		case "sub":
		case "sup":
			return mdInline("", text, tags);
		case "u": {
			if (!/\S/.test(text)) return text;
			const [prefix, suffix, t] = chomp(text);
			return t ? `${prefix}<u>${t}</u>${suffix}` : "";
		}
		case "q":
			return `"${text}"`;
		case "code":
		case "kbd":
		case "samp": {
			if (tags.has("_noformat")) return text;
			const [prefix, suffix, t] = chomp(text);
			if (!t) return "";
			const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((run) => run.length));
			const fence = "`".repeat(longest + 1);
			return `${prefix}${fence}${longest ? ` ${t} ` : t}${fence}${suffix}`;
		}
		case "pre": {
			if (!text) return "";
			return `\n\n\`\`\`\n${text.replace(/^[ \n]*\n/, "").replace(/[ \n]*$/, "")}\n\`\`\`\n\n`;
		}
		case "blockquote": {
			const t = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
			if (inline) return ` ${t} `;
			if (!t) return "\n";
			return `\n${t.replace(/^(.*)$/gm, (_, line: string) => (line ? `> ${line}` : ">"))}\n\n`;
		}
		case "br":
			return inline ? (text ? `${text} ` : " ") : `  \n${text}`;
		case "hr":
			return "\n\n---\n\n";
		case "p": {
			const t = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
			if (inline) return ` ${t} `;
			return t ? `\n\n${t}\n\n` : "";
		}
		case "div":
		case "article":
		case "section":
		case "dl": {
			if (inline) return ` ${text.trim()} `;
			const t = text.trim();
			return t ? `\n\n${t}\n\n` : "";
		}
		case "ul":
		case "ol": {
			const next = nextContentSibling(el);
			const beforeParagraph = next !== undefined && !(isEl(next) && (next.name === "ul" || next.name === "ol"));
			if (tags.has("li")) return `\n${text.trimEnd()}`;
			return `\n\n${text}${beforeParagraph ? "\n" : ""}`;
		}
		case "li": {
			const t = text.trim();
			if (!t) return "\n";
			let bullet: string;
			if (el.parent?.name === "ol") {
				const start = /^\d+$/.test(el.parent.attrs.start ?? "") ? Number(el.parent.attrs.start) : 1;
				const kids = el.parent.children;
				let before = 0;
				for (let i = kids.indexOf(el) - 1; i >= 0; i--) if (isEl(kids[i]) && (kids[i] as El).name === "li") before++;
				bullet = `${start + before}.`;
			} else {
				let depth = -1;
				for (let e: El | null = el; e; e = e.parent) if (e.name === "ul") depth++;
				bullet = "*+-"[((depth % 3) + 3) % 3];
			}
			bullet += " ";
			const indented = indentLines(t, " ".repeat(bullet.length));
			return `${bullet}${indented.slice(bullet.length)}\n`;
		}
		case "img": {
			const alt = (el.attrs.alt ?? "").replace(/\n/g, " ");
			let src = el.attrs.src ?? "";
			const dataSrc = el.attrs["data-src"] ?? "";
			if (dataSrc && (!src || src.slice(0, 5).toLowerCase() === "data:")) src = dataSrc;
			if (src.slice(0, 5).toLowerCase() === "data:") src = `${src.split(",")[0]}...`;
			const title = el.attrs.title ? ` "${el.attrs.title.replace(/"/g, '\\"')}"` : "";
			return `![${alt}](${src}${title})`;
		}
		case "input":
			return el.attrs.type === "checkbox" ? ("checked" in el.attrs ? "[x] " : "[ ] ") : "";
		case "table":
			return `\n\n${text.trim()}\n\n`;
		case "caption":
			return `${text.trim()}\n\n`;
		case "figcaption":
			return `\n\n${text.trim()}\n\n`;
		case "td":
		case "th":
			return ` ${text.trim().replace(/\n/g, " ").replace(/(?<!\\)\|/g, "\\|")}${" |".repeat(colspan(el))}`;
		case "tr":
			return mdRow(el, text);
		case "dt": {
			const t = text.trim().replace(/[\t \r\n]+/g, " ");
			if (inline) return ` ${t} `;
			return t ? `\n\n${t}\n` : "\n";
		}
		case "dd": {
			const t = text.trim();
			if (inline) return ` ${t} `;
			if (!t) return "\n";
			return `:${indentLines(t, "    ").slice(1)}\n`;
		}
		case "video": {
			if (inline) return text;
			const src = el.attrs.src || descendants(el, ["source"]).find((s) => s.attrs.src)?.attrs.src || "";
			const poster = el.attrs.poster ?? "";
			if (src && poster) return `[![${text}](${poster})](${src})`;
			if (src) return `[${text}](${src})`;
			if (poster) return `![${text}](${poster})`;
			return text;
		}
		case "script":
		case "style":
			return "";
		default:
			if (isHeading(el.name)) {
				if (inline) return text;
				const n = Math.max(1, Math.min(6, Number(el.name.slice(1)) || 1));
				const t = text.trim().replace(/[\t \r\n]+/g, " ");
				return t ? `\n\n${"#".repeat(n)} ${t}\n\n` : "";
			}
			return text;
	}
}

/** A table row; the first one gets the separator below it, or an empty header row above it when it is no header. */
function mdRow(el: El, text: string): string {
	const cells = descendants(el, ["td", "th"]);
	const parent = el.parent;
	const firstRow = previousElementSibling(el) === undefined;
	const headRow =
		cells.every((c) => c.name === "th") || (parent?.name === "thead" && descendants(parent, ["tr"]).length === 1);
	const headRowMissing =
		(firstRow && parent?.name !== "tbody") ||
		(firstRow && parent?.name === "tbody" && descendants(parent.parent ?? undefined, ["thead"]).length < 1);
	const width = cells.reduce((sum, c) => sum + colspan(c), 0);
	let overline = "";
	let underline = "";
	if (headRow && firstRow) underline = `| ${Array(width).fill("---").join(" | ")} |\n`;
	else if (headRowMissing || (firstRow && (parent?.name === "table" || (parent?.name === "tbody" && !previousElementSibling(parent))))) {
		overline = `| ${Array(width).fill("").join(" | ")} |\n| ${Array(width).fill("---").join(" | ")} |\n`;
	}
	return `${overline}|${text}\n${underline}`;
}

/** A Markdown table written directly, its cells as markdownify writes them: for tables of many rows. */
function markdownTable(rows: string[][], withHeader: boolean): string {
	if (!rows.length) return "";
	const width = Math.max(...rows.map((r) => r.length));
	const cell = (s: string) =>
		s
			.replace(/(?<![\t \r\n])[\t \r\n]*[\r\n][\t \r\n]*/g, "\n")
			.replace(/[\t ]+/g, " ")
			.replace(/\*/g, "\\*")
			.replace(/_/g, "\\_")
			.trim()
			.replace(/\n/g, " ")
			.replace(/(?<!\\)\|/g, "\\|");
	const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? "")).join(" | ")} |`;
	const separator = `| ${Array(width).fill("---").join(" | ")} |`;
	const out = withHeader ? [line(rows[0]), separator, ...rows.slice(1).map(line)] : [line([]), separator, ...rows.map(line)];
	return out.join("\n");
}
/** The first element below a node that passes the test. */
function findWhere(el: El | undefined, test: (e: El) => boolean): El | undefined {
	if (!el) return undefined;
	for (const c of el.children) {
		if (typeof c === "string") continue;
		if (test(c)) return c;
		const deeper = findWhere(c, test);
		if (deeper) return deeper;
	}
	return undefined;
}

const hasClass = (el: El, name: string) => (el.attrs.class ?? "").split(/\s+/).includes(name);

/**
 * An HTML page as Markdown; a page saved from a MediaWiki site, Wikipedia among them, as its title and article only,
 * without the menus, language links, and sidebars around them.
 */
function htmlPageToMarkdown(html: string): string {
	const tree = parseHtml(html);
	const article = findWhere(tree, (e) => e.name === "div" && e.attrs.id === "mw-content-text");
	if (!article) return htmlTreeToMarkdown(tree);
	const heading =
		findWhere(tree, (e) => e.name === "span" && hasClass(e, "mw-page-title-main")) ??
		findWhere(tree, (e) => e.attrs.id === "firstHeading") ??
		find(tree, "title");
	const title = textOf(heading).trim();
	const body = mdElement(article, new Set()).trim();
	return title ? `# ${title}\n\n${body}` : body;
}

// ---------------------------------------------------------------------------------------------------------------------
// RSS and Atom feeds

/** A title or date on one line: each line trimmed, empty ones left out. */
const flatten = (text: string) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" ");

/** Text with the indentation all its lines share taken away, as Python's textwrap.dedent does it. */
function dedent(text: string): string {
	const indents = text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => /^[ \t]*/.exec(line)?.[0] ?? "");
	if (!indents.length) return text;
	let common = indents[0];
	for (const indent of indents) while (!indent.startsWith(common)) common = common.slice(0, -1);
	return text
		.split("\n")
		.map((line) => (line.trim() ? line.slice(common.length) : line.replace(/^[ \t]+$/, "")))
		.join("\n");
}

/** An Atom text construct: plain text as it is, HTML and XHTML as Markdown, other media types left out. */
function atomText(el: El | undefined): string {
	if (!el) return "";
	const type = (el.attrs.type ?? "text").toLowerCase();
	if (type === "text" || (type.startsWith("text/") && type !== "text/html" && type !== "text/xml")) return dedent(textOf(el));
	if (type === "html" || type === "text/html") return htmlToMarkdown(textOf(el));
	if (type === "xhtml" || type.endsWith("+xml") || type.endsWith("/xml")) {
		return htmlTreeToMarkdown(h("#document", {}, el.children.map((c) => (typeof c === "string" ? c : cloneEl(c)))));
	}
	return "";
}

function cloneEl(el: El): El {
	return h(el.name, { ...el.attrs }, el.children.map((c) => (typeof c === "string" ? c : cloneEl(c))));
}

/** An RSS or Atom feed as Markdown: its title, then each item with its date and text; undefined for other XML. */
function feedToMarkdown(xml: string): string | undefined {
	let root: El | undefined;
	try {
		root = parseXml(xml).children.find((c): c is El => typeof c !== "string");
	} catch {
		return undefined;
	}
	if (!root) return undefined;
	let md = "";
	const add = (body: string[]) => {
		const parts = body.filter((s) => s.trim());
		if (!parts.length) return;
		if (md && !md.endsWith("\n")) md += "\n\n";
		md += parts.join("\n\n");
	};
	if (root.name === "rss" || root.name === "RDF") {
		const channel = child(root, "channel");
		const title = flatten(textOf(child(channel, "title")));
		if (title) md += `# ${title}\n`;
		const description = textOf(child(channel, "description"));
		if (description.trim()) md += `${description}\n`;
		for (const item of [...elements(channel ?? h("channel"), "item"), ...elements(root, "item")]) {
			const itemTitle = flatten(textOf(child(item, "title")));
			if (itemTitle) md += `\n## ${itemTitle}\n`;
			const date = flatten(textOf(child(item, "pubDate") ?? child(item, "date")));
			if (date) md += `Published on: ${date}\n`;
			add([child(item, "description"), child(item, "encoded")].map((e) => (e ? htmlToMarkdown(textOf(e)) : "")));
		}
		return md;
	}
	if (root.name === "feed" && elements(root, "entry").length) {
		const title = flatten(textOf(child(root, "title")));
		if (title) md += `# ${title}\n`;
		const subtitle = flatten(textOf(child(root, "subtitle")));
		if (subtitle) md += `${subtitle}\n`;
		for (const entry of elements(root, "entry")) {
			const entryTitle = flatten(textOf(child(entry, "title")));
			if (entryTitle) md += `\n## ${entryTitle}\n`;
			const updated = flatten(textOf(child(entry, "updated")));
			if (updated) md += `Updated on: ${updated}\n`;
			add([atomText(child(entry, "summary")), atomText(child(entry, "content"))]);
		}
		return md;
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Word, as mammoth reads it for markitdown

/**
 * A node of the HTML that mammoth builds. Elements that are not fresh merge into an equal element just before them, so
 * that runs of the same formatting, or the paragraphs of one list, become one element; alts are the tag names an
 * existing element may have for that.
 */
interface HNode {
	tag: string;
	alts: string[];
	attrs: Attrs;
	fresh: boolean;
	children: (HNode | string)[];
	/** Kept even without children. */
	keep?: boolean;
}

const hn = (tag: string, attrs: Attrs = {}, children: (HNode | string)[] = [], fresh = true, alts = [tag], keep = false): HNode => ({
	tag,
	alts,
	attrs,
	fresh,
	children,
	keep,
});
const VOID_TAGS = new Set(["img", "br", "input", "hr"]);

/** Children wrapped in the path, outermost first. */
function wrap(path: HNode[], children: (HNode | string)[]): (HNode | string)[] {
	let nodes = children;
	for (let i = path.length - 1; i >= 0; i--) nodes = [{ ...path[i], children: nodes }];
	return nodes;
}

function stripEmpty(nodes: (HNode | string)[]): (HNode | string)[] {
	const out: (HNode | string)[] = [];
	for (const n of nodes) {
		if (typeof n === "string") {
			if (n) out.push(n);
			continue;
		}
		const children = stripEmpty(n.children);
		if (children.length || n.keep || VOID_TAGS.has(n.tag)) out.push({ ...n, children });
	}
	return out;
}

const sameAttrs = (a: Attrs, b: Attrs) => {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

function collapse(nodes: (HNode | string)[]): (HNode | string)[] {
	const out: (HNode | string)[] = [];
	for (const n of nodes) collapsingAdd(out, n);
	return out;
}

function collapsingAdd(out: (HNode | string)[], node: HNode | string): void {
	const n = typeof node === "string" ? node : { ...node, children: collapse(node.children) };
	const last = out[out.length - 1];
	if (
		typeof n !== "string" &&
		!n.fresh &&
		!VOID_TAGS.has(n.tag) &&
		last !== undefined &&
		typeof last !== "string" &&
		n.alts.includes(last.tag) &&
		sameAttrs(last.attrs, n.attrs)
	) {
		for (const c of n.children) collapsingAdd(last.children, c);
	} else out.push(n);
}

function toEl(node: HNode | string): Node {
	return typeof node === "string" ? node : h(node.tag, node.attrs, node.children.map(toEl));
}

interface Numbering {
	/** Whether the list of numId at level ilvl is numbered, by "numId:ilvl"; absent where it is no list. */
	ordered: Map<string, boolean>;
}

function readNumbering(doc: El | undefined): Numbering {
	const abstract = new Map<string, Map<string, string>>();
	for (const a of findAll(doc, "abstractNum")) {
		const levels = new Map<string, string>();
		for (const lvl of elements(a, "lvl")) levels.set(attr(lvl, "ilvl") ?? "0", attr(child(lvl, "numFmt"), "val") ?? "decimal");
		abstract.set(attr(a, "abstractNumId") ?? "", levels);
	}
	const ordered = new Map<string, boolean>();
	for (const num of findAll(doc, "num")) {
		const numId = attr(num, "numId") ?? "";
		const levels = abstract.get(attr(child(num, "abstractNumId"), "val") ?? "");
		for (const [ilvl, format] of levels ?? []) ordered.set(`${numId}:${ilvl}`, format !== "bullet");
		for (const override of elements(num, "lvlOverride")) {
			const format = attr(child(child(override, "lvl"), "numFmt"), "val");
			if (format) ordered.set(`${numId}:${attr(override, "ilvl") ?? "0"}`, format !== "bullet");
		}
	}
	return { ordered };
}

interface DocxStyle {
	name: string;
	numId?: string;
	ilvl?: string;
}

interface Docx {
	zip: Zip;
	types: (part: string) => string | undefined;
	styles: Map<string, DocxStyle>;
	numbering: Numbering;
	notes: Map<string, { el: El; rels: Map<string, Rel> }>;
	noteRefs: { type: string; id: string }[];
}

interface DocxPart {
	doc: Docx;
	rels: Map<string, Rel>;
}

/** The content types of a package's parts: by name, else by extension. */
function contentTypes(zip: Zip): (part: string) => string | undefined {
	const doc = zip.xml("[Content_Types].xml");
	const byName = new Map<string, string>();
	const byExtension = new Map<string, string>();
	for (const o of findAll(doc, "Override")) byName.set((attr(o, "PartName") ?? "").replace(/^\/+/, "").toLowerCase(), attr(o, "ContentType") ?? "");
	for (const d of findAll(doc, "Default")) byExtension.set((attr(d, "Extension") ?? "").toLowerCase(), attr(d, "ContentType") ?? "");
	return (part) => byName.get(part.toLowerCase()) ?? byExtension.get(path.posix.extname(part).slice(1).toLowerCase());
}

async function docxToMarkdown(zip: Zip, main: string): Promise<Converted> {
	const types = contentTypes(zip);
	const rels = relationships(zip, main);
	const part = (type: string) => relOfType(rels, type)?.target;
	const styles = new Map<string, DocxStyle>();
	const stylesPart = part("styles");
	for (const s of findAll(stylesPart ? zip.xml(stylesPart) : undefined, "style")) {
		const id = attr(s, "styleId");
		if (!id) continue;
		const numPr = child(child(s, "pPr"), "numPr");
		styles.set(id, {
			name: attr(child(s, "name"), "val") ?? id,
			numId: attr(child(numPr, "numId"), "val"),
			ilvl: attr(child(numPr, "ilvl"), "val"),
		});
	}
	const numberingPart = part("numbering");
	const doc: Docx = {
		zip,
		types,
		styles,
		numbering: readNumbering(numberingPart ? zip.xml(numberingPart) : undefined),
		notes: new Map(),
		noteRefs: [],
	};
	for (const type of ["footnote", "endnote"]) {
		const notesPart = part(`${type}s`);
		if (!notesPart) continue;
		const notesRels = relationships(zip, notesPart);
		for (const note of findAll(zip.xml(notesPart), type)) doc.notes.set(`${type}:${attr(note, "id")}`, { el: note, rels: notesRels });
	}
	const body = find(zip.xml(main), "body");
	const nodes = docxBlocks(body, { doc, rels });
	// The notes, in the order of their references, after the text.
	const items: (HNode | string)[] = [];
	for (const ref of doc.noteRefs) {
		const note = doc.notes.get(`${ref.type}:${ref.id}`);
		if (!note) continue;
		const back = hn("p", {}, [" ", hn("a", { href: `#${ref.type}-ref-${ref.id}` }, ["↑"])], false);
		items.push(hn("li", { id: `${ref.type}-${ref.id}` }, [...docxBlocks(note.el, { doc, rels: note.rels }), back]));
	}
	nodes.push(hn("ol", {}, items));
	const tree = h("#document", {}, collapse(stripEmpty(nodes)).map(toEl));
	return { label: "Word document", markdown: htmlTreeToMarkdown(tree) };
}

/** The blocks of a body, a table cell, a note, or a content control: paragraphs and tables. */
function docxBlocks(container: El | undefined, part: DocxPart): (HNode | string)[] {
	const out: (HNode | string)[] = [];
	for (const c of container?.children ?? []) {
		if (typeof c === "string") continue;
		switch (c.name) {
			case "p":
				out.push(...docxParagraph(c, part));
				break;
			case "tbl":
				out.push(docxTable(c, part));
				break;
			case "sdt":
				out.push(...docxBlocks(child(c, "sdtContent"), part));
				break;
			case "customXml":
			case "ins":
			case "moveTo":
				out.push(...docxBlocks(c, part));
				break;
			case "AlternateContent":
				out.push(...docxBlocks(child(c, "Fallback") ?? child(c, "Choice"), part));
				break;
		}
	}
	return out;
}

/** A paragraph with the HTML path its style and numbering give it, then the paragraphs of text boxes in it. */
function docxParagraph(p: El, part: DocxPart): (HNode | string)[] {
	const pPr = child(p, "pPr");
	const styleId = attr(child(pPr, "pStyle"), "val");
	const style = styleId ? part.doc.styles.get(styleId) : undefined;
	const extra: (HNode | string)[] = [];
	const content = docxInline(p, part, { fields: [], extra });
	const heading =
		/^Heading([1-6])$/.exec(styleId ?? "")?.[1] ??
		/^heading ([1-6])$/i.exec(style?.name ?? "")?.[1] ??
		(styleId === "Heading" || style?.name === "Heading" ? "1" : undefined);
	const numPr = child(pPr, "numPr");
	const numId = attr(child(numPr, "numId"), "val") ?? style?.numId;
	const ilvl = attr(child(numPr, "ilvl"), "val") ?? (attr(child(numPr, "numId"), "val") ? "0" : (style?.ilvl ?? "0"));
	const ordered = numId && numId !== "0" ? part.doc.numbering.ordered.get(`${numId}:${ilvl}`) : undefined;
	let path: HNode[];
	if (heading) path = [hn(`h${heading}`)];
	else if (ordered !== undefined) {
		const level = Math.min(5, Number(ilvl) + 1);
		path = [];
		for (let i = 1; i < level; i++) path.push(hn("ul", {}, [], false, ["ul", "ol"]), hn("li", {}, [], false));
		path.push(hn(ordered ? "ol" : "ul", {}, [], false), hn("li"));
	} else path = [hn("p")];
	return [...wrap(path, content), ...extra];
}

interface InlineState {
	/** Complex fields open around the runs: their instruction, then whether their result is being read. */
	fields: { instruction: string; result: boolean; checkbox?: boolean }[];
	/** Paragraphs of text boxes, put after the paragraph. */
	extra: (HNode | string)[];
}

function docxInline(container: El, part: DocxPart, state: InlineState): (HNode | string)[] {
	const out: (HNode | string)[] = [];
	for (const c of container.children) {
		if (typeof c === "string") continue;
		switch (c.name) {
			case "r":
				out.push(...docxRun(c, part, state));
				break;
			case "hyperlink": {
				const rel = relAttr(c, "id");
				const target = rel ? part.rels.get(rel)?.target : undefined;
				const anchor = attr(c, "anchor");
				const href = anchor ? `${(target ?? "").split("#")[0]}#${anchor}` : target;
				const inner = docxInline(c, part, state);
				out.push(...(href ? [hn("a", { href }, inner, false)] : inner));
				break;
			}
			case "sdt": {
				const checkbox = find(child(c, "sdtPr"), "checkbox");
				if (checkbox) {
					const checked = attr(child(checkbox, "checked"), "val");
					out.push(hn("input", checked === "1" || checked === "true" ? { type: "checkbox", checked: "checked" } : { type: "checkbox" }));
				} else out.push(...docxInline(child(c, "sdtContent") ?? c, part, state));
				break;
			}
			case "ins":
			case "moveTo":
			case "smartTag":
			case "customXml":
			case "fldSimple":
			case "dir":
			case "bdo":
				out.push(...docxInline(c, part, state));
				break;
			case "AlternateContent":
				out.push(...docxInline(child(c, "Fallback") ?? child(c, "Choice") ?? c, part, state));
				break;
			case "oMathPara":
				for (const m of elements(c, "oMath")) state.extra.push(hn("p", {}, [hn("#math", {}, [`$$${omml(m)}$$`], false)]));
				break;
			case "oMath":
				out.push(hn("#math", {}, [`$${omml(c)}$`], false));
				break;
		}
	}
	return out;
}

function docxRun(r: El, part: DocxPart, state: InlineState): (HNode | string)[] {
	const nodes: (HNode | string)[] = [];
	for (const c of r.children) {
		if (typeof c === "string") continue;
		const field = state.fields[state.fields.length - 1];
		switch (c.name) {
			case "t":
				if (!field || field.result) nodes.push(textOf(c));
				break;
			case "tab":
			case "ptab":
				nodes.push("\t");
				break;
			case "br": {
				const type = attr(c, "type");
				if (!type || type === "textWrapping") nodes.push(hn("br"));
				break;
			}
			case "cr":
				nodes.push(hn("br"));
				break;
			case "noBreakHyphen":
				nodes.push("\u2011");
				break;
			case "softHyphen":
				nodes.push("\u00ad");
				break;
			case "fldChar": {
				const type = attr(c, "fldCharType");
				if (type === "begin") {
					const box = find(child(c, "ffData"), "checkBox");
					const checked = box && (child(box, "checked") ?? child(box, "default"));
					state.fields.push({ instruction: "", result: false, checkbox: box ? toggle(checked) : undefined });
				} else if (type === "separate" && field) field.result = true;
				else if (type === "end") {
					const ended = state.fields.pop();
					if (ended?.checkbox !== undefined && /^\s*FORMCHECKBOX/.test(ended.instruction)) {
						nodes.push(hn("input", ended.checkbox ? { type: "checkbox", checked: "checked" } : { type: "checkbox" }));
					}
				}
				break;
			}
			case "instrText":
				if (field && !field.result) field.instruction += textOf(c);
				break;
			case "footnoteReference":
			case "endnoteReference": {
				const type = c.name === "footnoteReference" ? "footnote" : "endnote";
				const id = attr(c, "id") ?? "";
				part.doc.noteRefs.push({ type, id });
				const n = part.doc.noteRefs.length;
				nodes.push(hn("sup", {}, [hn("a", { href: `#${type}-${id}`, id: `${type}-ref-${id}` }, [`[${n}]`])]));
				break;
			}
			case "drawing":
				nodes.push(...docxImages(c, part));
				break;
			case "pict":
			case "object": {
				nodes.push(...docxImages(c, part));
				for (const box of findAll(c, "txbxContent")) state.extra.push(...docxBlocks(box, part));
				break;
			}
			case "AlternateContent": {
				const branch = child(c, "Fallback") ?? child(c, "Choice");
				if (branch) nodes.push(...docxRun({ ...branch, name: "r" }, part, state));
				break;
			}
			case "ruby":
				nodes.push(...docxRun({ ...(child(c, "rubyBase") ?? c), name: "r" }, part, state).filter((n) => typeof n === "string"));
				break;
		}
	}
	if (!nodes.length) return [];
	// Formatting, outermost first, as mammoth nests it.
	const rPr = child(r, "rPr");
	const path: HNode[] = [];
	const href = docxFieldHref(state);
	if (href) path.push(hn("a", { href }, [], false));
	const rStyle = attr(child(rPr, "rStyle"), "val");
	if (rStyle && part.doc.styles.get(rStyle)?.name === "Strong") path.push(hn("strong", {}, [], false));
	if (toggle(child(rPr, "b"))) path.push(hn("strong", {}, [], false));
	if (toggle(child(rPr, "i"))) path.push(hn("em", {}, [], false));
	const vertAlign = attr(child(rPr, "vertAlign"), "val");
	if (vertAlign === "superscript") path.push(hn("sup", {}, [], false));
	if (vertAlign === "subscript") path.push(hn("sub", {}, [], false));
	const u = child(rPr, "u");
	if (u && attr(u, "val") !== "none") path.push(hn("u", {}, [], false));
	if (toggle(child(rPr, "strike")) || toggle(child(rPr, "dstrike"))) path.push(hn("s", {}, [], false));
	return wrap(path, nodes);
}

/** The target of the innermost HYPERLINK field whose result the runs are part of. */
function docxFieldHref(state: InlineState): string | undefined {
	for (let i = state.fields.length - 1; i >= 0; i--) {
		const field = state.fields[i];
		if (!field.result) continue;
		const anchor = /^\s*HYPERLINK\s+\\l\s+"([^"]*)"/.exec(field.instruction)?.[1];
		if (anchor) return `#${anchor}`;
		const url = /^\s*HYPERLINK\s+"([^"]*)"/.exec(field.instruction)?.[1];
		if (url) return url;
	}
	return undefined;
}

/** Pictures as images with a data URI, which the Markdown cuts after its media type: the bytes are never read. */
function docxImages(el: El, part: DocxPart): HNode[] {
	const out: HNode[] = [];
	const image = (id: string | undefined, alt: string | undefined) => {
		const rel = id ? part.rels.get(id) : undefined;
		if (!rel || rel.external) return;
		const type = part.doc.types(rel.target) ?? "image/png";
		out.push(hn("img", alt ? { alt, src: `data:${type};base64,` } : { src: `data:${type};base64,` }));
	};
	for (const frame of [...findAll(el, "inline"), ...findAll(el, "anchor")]) {
		const docPr = child(frame, "docPr");
		const alt = attr(docPr, "descr") || attr(docPr, "title");
		for (const blip of findAll(frame, "blip")) image(relAttr(blip, "embed"), alt);
	}
	for (const data of findAll(el, "imagedata")) image(relAttr(data, "id"), attr(data, "title"));
	return out;
}

function docxTable(tbl: El, part: DocxPart): HNode {
	const rows = elements(tbl, "tr");
	let headerRows = 0;
	while (headerRows < rows.length && toggle(child(child(rows[headerRows], "trPr"), "tblHeader"))) headerRows++;
	const row = (tr: El, header: boolean) =>
		hn("tr", {}, elements(tr, "tc").map((tc) => {
			const tcPr = child(tc, "tcPr");
			const span = Number(attr(child(tcPr, "gridSpan"), "val") ?? 1);
			const merge = child(tcPr, "vMerge");
			// A cell that continues the one above stays, empty, so that the columns keep their places.
			const continued = merge !== undefined && attr(merge, "val") !== "restart";
			return hn(header ? "th" : "td", span > 1 ? { colspan: String(span) } : {}, continued ? [] : docxBlocks(tc, part), true, [header ? "th" : "td"], true);
		}), true, ["tr"], true);
	const children =
		headerRows === 0
			? rows.map((tr) => row(tr, false))
			: [hn("thead", {}, rows.slice(0, headerRows).map((tr) => row(tr, true))), hn("tbody", {}, rows.slice(headerRows).map((tr) => row(tr, false)))];
	return hn("table", {}, children, true, ["table"], true);
}

// Office Math as LaTeX, as markitdown's port of dwml writes it.

const MATH_ACCENTS: Record<string, string> = {
	"\u0300": "grave", "\u0301": "acute", "\u0302": "hat", "\u0303": "tilde", "\u0304": "bar", "\u0305": "overbar",
	"\u0306": "breve", "\u0307": "dot", "\u0308": "ddot", "\u030c": "check", "\u20d7": "vec", "\u20d6": "overleftarrow",
	"\u20e1": "overleftrightarrow",
};
const MATH_OPERATORS: Record<string, string> = {
	"∑": "\\sum", "∏": "\\prod", "∐": "\\coprod", "∫": "\\int", "∬": "\\iint", "∭": "\\iiint", "∮": "\\oint",
	"⋀": "\\bigwedge", "⋁": "\\bigvee", "⋂": "\\bigcap", "⋃": "\\bigcup", "⨀": "\\bigodot", "⨁": "\\bigoplus",
	"⨂": "\\bigotimes",
};
const MATH_SYMBOLS: Record<string, string> = {
	"←": "\\leftarrow ", "↑": "\\uparrow ", "→": "\\rightarrow ", "↓": "\\downarrow ", "↔": "\\leftrightarrow ",
	"⋮": "\\vdots ", "⋯": "\\cdots ", "⋱": "\\ddots ", "≠": "\\ne ", "≤": "\\leq ", "≥": "\\geq ", "≪": "\\ll ",
	"≫": "\\gg ", "∈": "\\in ", "∉": "\\notin ", "∋": "\\ni ", "∞": "\\infty ", "±": "\\pm ", "∓": "\\mp ",
	"∂": "\\partial ", "≈": "\\approx ", "×": "\\times ", "÷": "\\div ", "·": "\\cdot ", "∙": "\\cdot ",
};
const GREEK = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho varsigma sigma tau upsilon phi chi psi omega".split(" ");
const MATH_FUNCTIONS = new Set(
	"sin cos tan arcsin arccos arctan sinh cosh tanh coth sec csc cot log ln exp det gcd lim max min sup inf dim ker hom deg arg".split(" "),
);

/** A character of math text in LaTeX: italic math letters as plain ones, symbols by name, LaTeX's specials escaped. */
function mathChar(ch: string, previous: string): string {
	const cp = ch.codePointAt(0) as number;
	if (cp >= 0x1d434 && cp <= 0x1d467) return String.fromCharCode(cp < 0x1d44e ? 0x41 + cp - 0x1d434 : 0x61 + cp - 0x1d44e);
	if (cp === 0x210e) return "h";
	if (cp >= 0x1d6fc && cp <= 0x1d714) return `\\${GREEK[cp - 0x1d6fc]} `;
	if (MATH_SYMBOLS[ch]) return MATH_SYMBOLS[ch];
	if ("{}_^#&$%~".includes(ch) && previous !== "\\") return `\\${ch}`;
	return ch;
}

function omml(el: El | undefined): string {
	if (!el) return "";
	let out = "";
	for (const c of el.children) if (typeof c !== "string") out += ommlElement(c);
	return out;
}

function ommlElement(el: El): string {
	const pr = (name: string) => child(el, `${el.name}Pr`) && attr(child(child(el, `${el.name}Pr`), name), "val");
	const sub = () => omml(child(el, "sub"));
	const sup = () => omml(child(el, "sup"));
	const e = () => omml(child(el, "e"));
	switch (el.name) {
		case "r": {
			let text = "";
			for (const t of findAll(el, "t")) for (const ch of textOf(t)) text += mathChar(ch, text.slice(-1));
			return text;
		}
		case "f": {
			const num = omml(child(el, "num"));
			const den = omml(child(el, "den"));
			switch (pr("type")) {
				case "skw":
					return `^{${num}}/_{${den}}`;
				case "noBar":
					return `\\genfrac{}{}{0pt}{}{${num}}{${den}}`;
				case "lin":
					return `{${num}}/{${den}}`;
				default:
					return `\\frac{${num}}{${den}}`;
			}
		}
		case "sSub":
			return `${e()}_{${sub()}}`;
		case "sSup":
			return `${e()}^{${sup()}}`;
		case "sSubSup":
			return `${e()}_{${sub()}}^{${sup()}}`;
		case "sPre":
			return `{}_{${sub()}}^{${sup()}}${e()}`;
		case "rad": {
			const deg = omml(child(el, "deg"));
			return deg ? `\\sqrt[${deg}]{${e()}}` : `\\sqrt{${e()}}`;
		}
		case "d": {
			const delim = (value: string | undefined, fallback: string) => {
				const ch = value ?? fallback;
				return ch === "" ? "." : ch === "{" || ch === "}" ? `\\${ch}` : ch;
			};
			const dPr = child(el, "dPr");
			const begin = delim(attr(child(dPr, "begChr"), "val"), "(");
			const end = delim(attr(child(dPr, "endChr"), "val"), ")");
			const separator = attr(child(dPr, "sepChr"), "val") ?? "|";
			return `\\left${begin}${elements(el, "e").map(omml).join(separator)}\\right${end}`;
		}
		case "nary": {
			const chr = attr(child(child(el, "naryPr"), "chr"), "val") ?? "∫";
			const s = sub();
			const p = sup();
			return `${MATH_OPERATORS[chr] ?? chr}${s ? `_{${s}}` : ""}${p ? `^{${p}}` : ""}{${e()}}`;
		}
		case "func": {
			const name = omml(child(el, "fName"));
			return MATH_FUNCTIONS.has(name) ? `\\${name}{${e()}}` : `${name}{${e()}}`;
		}
		case "acc": {
			const chr = attr(child(child(el, "accPr"), "chr"), "val") ?? "\u0302";
			return `\\${MATH_ACCENTS[chr] ?? "hat"}{${e()}}`;
		}
		case "bar":
			return pr("pos") === "top" ? `\\overline{${e()}}` : `\\underline{${e()}}`;
		case "groupChr": {
			const chr = attr(child(child(el, "groupChrPr"), "chr"), "val") ?? "\u23df";
			const name = { "\u23de": "overbrace", "\u23df": "underbrace", "\u23dc": "overparen", "\u23dd": "underparen" }[chr] ?? "underbrace";
			return `\\${name}{${e()}}`;
		}
		case "limLow": {
			const base = e();
			const lim = omml(child(el, "lim"));
			return ["lim", "max", "min"].includes(base) ? `\\${base}_{${lim}}` : `${base}_{${lim}}`;
		}
		case "limUpp":
			return `\\overset{${omml(child(el, "lim"))}}{${e()}}`;
		case "m":
			return `\\begin{matrix}${elements(el, "mr").map((row) => elements(row, "e").map(omml).join("&")).join("\\\\")}\\end{matrix}`;
		case "eqArr":
			return `\\begin{array}{c}${elements(el, "e").map(omml).join("\\\\")}\\end{array}`;
		case "box":
		case "borderBox":
		case "phant":
		case "e":
		case "oMath":
			return e() || omml(el);
		default:
			return el.name.endsWith("Pr") ? "" : omml(el);
	}
}
// ---------------------------------------------------------------------------------------------------------------------
// PowerPoint, as python-pptx reads it for markitdown

interface Placeholders {
	byIdx: Map<string, El>;
	byType: Map<string, El>;
}

function placeholders(tree: El | undefined): Placeholders {
	const byIdx = new Map<string, El>();
	const byType = new Map<string, El>();
	for (const shape of elements(find(tree, "spTree") ?? h("spTree"))) {
		const ph = find(shape, "ph");
		if (!ph) continue;
		const idx = attr(ph, "idx") ?? "0";
		const type = attr(ph, "type") ?? "obj";
		if (!byIdx.has(idx)) byIdx.set(idx, shape);
		if (!byType.has(type)) byType.set(type, shape);
	}
	return { byIdx, byType };
}

const ownOffset = (shape: El) => {
	const xfrm = find(child(shape, "spPr") ?? child(shape, "grpSpPr") ?? shape, "xfrm") ?? child(shape, "xfrm");
	const off = child(xfrm, "off");
	return off ? { x: Number(attr(off, "x")), y: Number(attr(off, "y")) } : undefined;
};

/** A shape's position: its own, else a placeholder's, inherited from the layout (by idx), then the master (by type). */
function shapeOffset(shape: El, layout: Placeholders, master: Placeholders): { x: number; y: number } | undefined {
	const own = ownOffset(shape);
	if (own) return own;
	const ph = find(child(shape, "nvSpPr") ?? child(shape, "nvPicPr") ?? shape, "ph");
	if (!ph) return undefined;
	const onLayout = layout.byIdx.get(attr(ph, "idx") ?? "0");
	const fromLayout = onLayout && ownOffset(onLayout);
	if (fromLayout) return fromLayout;
	const type = attr(find(onLayout, "ph"), "type") ?? attr(ph, "type") ?? "obj";
	const onMaster = master.byType.get({ ctrTitle: "title", subTitle: "body", obj: "body" }[type] ?? type);
	return onMaster && ownOffset(onMaster);
}

/** The shapes in reading order: by top, then left, a shape without a position first. */
function sortShapes(shapes: El[], at: (shape: El) => { x: number; y: number } | undefined): El[] {
	return shapes
		.map((shape, i) => ({ shape, i, at: at(shape) }))
		.sort((a, b) => (a.at?.y ?? -Infinity) - (b.at?.y ?? -Infinity) || (a.at?.x ?? -Infinity) - (b.at?.x ?? -Infinity) || a.i - b.i)
		.map((s) => s.shape);
}

/** A text frame's text: paragraphs on lines of their own, line breaks too. */
function frameText(txBody: El | undefined): string {
	return elements(txBody ?? h("txBody"), "p")
		.map((p) => {
			let s = "";
			for (const c of p.children) {
				if (typeof c === "string") continue;
				if (c.name === "r" || c.name === "fld") s += textOf(child(c, "t"));
				else if (c.name === "br") s += "\n";
			}
			return s;
		})
		.join("\n");
}

/** A number as Python's str() writes a float: 10.0, 0.25, 1e-05. */
function pythonFloat(x: number): string {
	if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
	if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
	const [mantissa, exp] = x.toExponential().split("e");
	const e = Number(exp);
	if (e < -4 || e >= 16) return `${mantissa}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
	const s = String(x);
	return /[.e]/.test(s) ? s : `${s}.0`;
}

const SHAPE_TAGS = new Set(["sp", "pic", "graphicFrame", "grpSp", "cxnSp"]);

async function pptxToMarkdown(zip: Zip, main: string): Promise<Converted> {
	const rels = relationships(zip, main);
	const presentation = zip.xml(main);
	let md = "";
	let number = 0;
	for (const id of findAll(find(presentation, "sldIdLst"), "sldId")) {
		const rel = rels.get(relAttr(id, "id") ?? "");
		if (!rel || rel.external) continue;
		number++;
		const slideRels = relationships(zip, rel.target);
		const slide = zip.xml(rel.target);
		const layoutPart = relOfType(slideRels, "slideLayout")?.target;
		const layout = placeholders(layoutPart ? zip.xml(layoutPart) : undefined);
		const masterPart = layoutPart ? relOfType(relationships(zip, layoutPart), "slideMaster")?.target : undefined;
		const master = placeholders(masterPart ? zip.xml(masterPart) : undefined);
		md += `\n\n<!-- Slide number: ${number} -->\n`;
		const tree = find(slide, "spTree");
		const top = elements(tree ?? h("spTree")).filter((s) => SHAPE_TAGS.has(s.name));
		const title = top.find((s) => s.name === "sp" && ["title", "ctrTitle"].includes(attr(find(child(s, "nvSpPr"), "ph"), "type") ?? ""));
		const visit = (shape: El) => {
			if (shape.name === "pic" && !find(child(shape, "nvPicPr"), "videoFile") && !find(child(shape, "nvPicPr"), "audioFile")) {
				const cNvPr = find(child(shape, "nvPicPr"), "cNvPr");
				const name = attr(cNvPr, "name") ?? "";
				const alt = ((attr(cNvPr, "descr") ?? "").trim() ? (attr(cNvPr, "descr") as string) : name)
					.replace(/[\r\n[\]]/g, " ")
					.replace(/\s+/g, " ")
					.trim();
				md += `\n![${alt}](${name.replace(/[^\p{L}\p{N}_]/gu, "")}.jpg)\n`;
			}
			if (shape.name === "graphicFrame") {
				const data = find(shape, "graphicData");
				const tbl = child(data, "tbl");
				if (tbl) {
					const rows = elements(tbl, "tr").map((tr) => elements(tr, "tc").map((tc) => frameText(child(tc, "txBody"))));
					md += `${markdownTable(rows, true)}\n`;
				}
				const chart = child(data, "chart");
				if (chart) {
					const chartRel = slideRels.get(relAttr(chart, "id") ?? "");
					md += chartRel && !chartRel.external ? chartMarkdown(zip.xml(chartRel.target)) : "\n\n[unsupported chart]\n\n";
				}
			} else if (child(shape, "txBody")) {
				const text = frameText(child(shape, "txBody"));
				if (shape === title) {
					if (text.trim()) md += `# ${text.trimStart()}\n`;
				} else md += `${text}\n`;
			}
			if (shape.name === "grpSp") {
				for (const s of sortShapes(elements(shape).filter((c) => SHAPE_TAGS.has(c.name)), ownOffset)) visit(s);
			}
		};
		for (const shape of sortShapes(top, (s) => shapeOffset(s, layout, master))) visit(shape);
		md = md.trim();
		const notesPart = relOfType(slideRels, "notesSlide")?.target;
		if (notesPart) {
			const notesTree = find(zip.xml(notesPart), "spTree");
			const body = elements(notesTree ?? h("spTree")).find((s) => attr(find(child(s, "nvSpPr"), "ph"), "type") === "body");
			const notes = body ? frameText(child(body, "txBody")) : "";
			if (notes.trim()) md = `${md}\n\n### Notes:\n${notes}`.trim();
		}
	}
	return { label: "PowerPoint presentation", markdown: md.trim() };
}

const PLOTS = new Set(["areaChart", "area3DChart", "barChart", "bar3DChart", "bubbleChart", "doughnutChart", "lineChart", "line3DChart", "pieChart", "pie3DChart", "ofPieChart", "radarChart", "scatterChart"]);

/** The points of a chart data reference or literal, by index, as long as its point count says. */
function chartPoints(source: El | undefined): (string | undefined)[] {
	const cache =
		find(source, "strCache") ?? find(source, "numCache") ?? child(source, "strLit") ?? child(source, "numLit") ?? child(find(source, "multiLvlStrCache"), "lvl");
	if (!cache) return [];
	const values: (string | undefined)[] = [];
	const count = Number(attr(child(cache, "ptCount"), "val") ?? 0);
	for (const pt of elements(cache, "pt")) values[Number(attr(pt, "idx") ?? 0)] = textOf(child(pt, "v"));
	values.length = Math.max(values.length, count);
	return values;
}

/** A chart's title and its data as a table, categories down, series across. */
function chartMarkdown(chartSpace: El | undefined): string {
	try {
		const chart = find(chartSpace, "chart");
		const plotArea = child(chart, "plotArea");
		const plots = elements(plotArea ?? h("plotArea")).filter((p) => p.name.endsWith("Chart"));
		if (!plots.length || !PLOTS.has(plots[0].name)) return "\n\n[unsupported chart]\n\n";
		const rich = child(child(child(chart, "title"), "tx"), "rich");
		let md = "\n\n### Chart";
		if (rich) md += `: ${elements(rich, "p").map((p) => findAll(p, "t").map(textOf).join("")).join("\n")}`;
		md += "\n\n";
		const series = plots
			.flatMap((p) => elements(p, "ser"))
			.map((ser, i) => ({ ser, i, order: Number(attr(child(ser, "order"), "val") ?? 0) }))
			.sort((a, b) => a.order - b.order || a.i - b.i)
			.map((s) => s.ser);
		const categories = chartPoints(child(elements(plots[0], "ser")[0], "cat"));
		const names = series.map((ser) => {
			const tx = child(ser, "tx");
			return find(tx, "pt") ? textOf(child(find(tx, "pt"), "v")) : textOf(child(tx, "v"));
		});
		const values = series.map((ser) => chartPoints(child(ser, "val") ?? child(ser, "yVal")));
		const rows = [["Category", ...names]];
		for (let i = 0; i < categories.length; i++) {
			rows.push([categories[i] ?? "", ...values.map((v) => (i < v.length && v[i] !== undefined ? pythonFloat(Number(v[i])) : "None"))]);
		}
		const lines = rows.map((r) => `| ${r.join(" | ")} |`);
		// A line break after the table, unlike markitdown, whose next shape's text runs on in the table's last row.
		return `${md}${[lines[0], `|${rows[0].map(() => "---").join("|")}|`, ...lines.slice(1)].join("\n")}\n`;
	} catch {
		return "\n\n[unsupported chart]\n\n";
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Excel

/** Built-in number formats that show a date or a time. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(code: string): boolean {
	const plain = code
		.replace(/"[^"]*"/g, "")
		.replace(/\\./g, "")
		.replace(/\[(?![hms]+\])[^\]]*\]/gi, "")
		.split(";")[0];
	return /[dmyhs]/i.test(plain) && !/^general$/i.test(plain.trim());
}

/** An Excel serial date as text: the date alone at midnight, the time alone before day one. */
function excelDate(serial: number, date1904: boolean): string {
	const days = date1904 ? serial + 1462 : serial;
	const ms = Math.round((days - 25569) * 86_400_000);
	const iso = new Date(ms).toISOString();
	if (days < 1 && !date1904) return iso.slice(11, 19);
	return ms % 86_400_000 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** A column's index from a cell reference: A1 is 0, AB7 is 27. */
function columnIndex(ref: string): number {
	let n = 0;
	for (const ch of ref.toUpperCase()) {
		const code = ch.charCodeAt(0);
		if (code < 65 || code > 90) break;
		n = n * 26 + code - 64;
	}
	return n - 1;
}

async function xlsxToMarkdown(zip: Zip, main: string): Promise<Converted> {
	const rels = relationships(zip, main);
	const workbook = zip.xml(main);
	const date1904 = /^(1|true)$/i.test(attr(find(workbook, "workbookPr"), "date1904") ?? "");
	const sharedPart = relOfType(rels, "sharedStrings")?.target;
	const shared = findAll(sharedPart ? zip.xml(sharedPart) : undefined, "si").map((si) =>
		findAll(si, "t")
			.filter((t) => t.parent?.name !== "rPh")
			.map(textOf)
			.join(""),
	);
	const stylesPart = relOfType(rels, "styles")?.target;
	const styles = stylesPart ? zip.xml(stylesPart) : undefined;
	const customFormats = new Map<number, string>();
	for (const f of findAll(find(styles, "numFmts"), "numFmt")) customFormats.set(Number(attr(f, "numFmtId")), attr(f, "formatCode") ?? "");
	const dateStyles = elements(find(styles, "cellXfs") ?? h("cellXfs"), "xf").map((xf) => {
		const id = Number(attr(xf, "numFmtId") ?? 0);
		return DATE_FORMATS.has(id) || (customFormats.has(id) && isDateFormat(customFormats.get(id) as string));
	});
	let md = "";
	for (const sheet of findAll(find(workbook, "sheets"), "sheet")) {
		const rel = rels.get(relAttr(sheet, "id") ?? "");
		if (!rel || rel.external) continue;
		const rows: string[][] = [];
		let first = Infinity;
		let last = -1;
		for (const row of findAll(find(zip.xml(rel.target), "sheetData"), "row")) {
			const cells: string[] = [];
			let next = 0;
			for (const c of elements(row, "c")) {
				const ref = attr(c, "r");
				const col = ref ? columnIndex(ref) : next;
				next = col + 1;
				const type = attr(c, "t") ?? "n";
				const v = textOf(child(c, "v"));
				let value: string;
				if (type === "s") value = shared[Number(v)] ?? "";
				else if (type === "inlineStr") value = findAll(child(c, "is"), "t").map(textOf).join("");
				else if (type === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : v;
				else if (type === "str" || type === "e" || type === "d") value = v;
				else if (v === "") value = "";
				else {
					const x = Number(v);
					value = Number.isNaN(x) ? v : dateStyles[Number(attr(c, "s") ?? 0)] ? excelDate(x, date1904) : String(Number(x.toPrecision(15)));
				}
				if (value === "") continue;
				cells[col] = value;
				first = Math.min(first, col);
				last = Math.max(last, col);
			}
			if (cells.length) rows.push(cells);
		}
		const table = rows.map((r) => Array.from({ length: last - first + 1 }, (_, i) => r[first + i] ?? ""));
		md += `## ${attr(sheet, "name") ?? ""}\n${markdownTable(table, true)}\n\n`;
	}
	return { label: "Excel workbook", markdown: md.trim() };
}

// ---------------------------------------------------------------------------------------------------------------------
// EPUB

async function epubToMarkdown(zip: Zip): Promise<Converted> {
	const rootfile = attr(find(zip.xml("META-INF/container.xml"), "rootfile"), "full-path");
	const opfPart = rootfile ? resolvePart("", rootfile) : undefined;
	const opf = opfPart ? zip.xml(opfPart) : undefined;
	if (!opf || !opfPart) throw new ConvertError("the EPUB has no package document (META-INF/container.xml)");
	const metadata = find(opf, "metadata");
	const meta = (name: string) => elements(metadata ?? h("metadata"), name).map((e) => textOf(e).trim()).filter(Boolean);
	const fields: [string, string | undefined][] = [
		["Title", meta("title")[0]],
		["Authors", meta("creator").join(", ") || undefined],
		["Language", meta("language")[0]],
		["Publisher", meta("publisher")[0]],
		["Date", meta("date")[0]],
		["Description", meta("description")[0]],
		["Identifier", meta("identifier")[0]],
	];
	const head = fields
		.filter(([, value]) => value)
		.map(([key, value]) => `**${key}:** ${value}`)
		.join("\n");
	const dir = path.posix.dirname(opfPart);
	const manifest = new Map<string, string>();
	for (const item of findAll(find(opf, "manifest"), "item")) manifest.set(attr(item, "id") ?? "", attr(item, "href") ?? "");
	const chapters: string[] = [];
	for (const ref of findAll(find(opf, "spine"), "itemref")) {
		const href = manifest.get(attr(ref, "idref") ?? "");
		if (!href) continue;
		const text = zip.text(resolvePart(dir === "." ? "" : dir, href.split("#")[0]));
		if (text !== undefined) chapters.push(htmlToMarkdown(text));
	}
	return { label: "EPUB", markdown: [head, ...chapters].join("\n\n") };
}

// ---------------------------------------------------------------------------------------------------------------------
// CSV, notebooks, text

/** Rows of CSV as Python's csv module reads them: quotes doubled inside quotes, an empty line an empty row. */
function parseCsv(text: string, delimiter: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	let started = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i++;
				} else quoted = false;
			} else cell += ch;
		} else if (ch === '"' && cell === "") {
			quoted = true;
			started = true;
		} else if (ch === delimiter) {
			row.push(cell);
			cell = "";
			started = true;
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			if (started || cell) row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			started = false;
		} else {
			cell += ch;
			started = true;
		}
	}
	if (started || cell) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

function csvToMarkdown(text: string, delimiter: string): string {
	const rows = parseCsv(text.replace(/^\uFEFF+/, ""), delimiter);
	// No empty rows before the header, right after it, or at the end.
	let start = 0;
	while (start < rows.length && !rows[start].length) start++;
	if (start === rows.length) return "";
	const headerRow = rows[start];
	let body = start + 1;
	while (body < rows.length && !rows[body].length) body++;
	let end = rows.length;
	while (end > body && !rows[end - 1].length) end--;
	const table = [headerRow, ...rows.slice(body, end)];
	const width = Math.max(...table.map((r) => r.length));
	const cell = (s: string) => s.replace(/(?<!\\)(\\*)\|/g, (_, slashes: string) => `${slashes}${slashes}\\|`).replace(/\r\n|\n|\r/g, " ");
	const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? "")).join(" | ")} |`;
	return [line(table[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...table.slice(1).map(line)].join("\n");
}

function notebookToMarkdown(text: string): string {
	let notebook: { cells?: { cell_type?: string; source?: string | string[] }[] };
	try {
		notebook = JSON.parse(text.replace(/^\uFEFF+/, ""));
	} catch {
		throw new ConvertError("the notebook is not valid JSON");
	}
	const blocks: string[] = [];
	for (const cell of notebook.cells ?? []) {
		const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
		if (cell.cell_type === "markdown") blocks.push(source);
		else if (cell.cell_type === "code") blocks.push(`\`\`\`python\n${source}\n\`\`\``);
		else if (cell.cell_type === "raw") blocks.push(`\`\`\`\n${source}\n\`\`\``);
	}
	return blocks.join("\n\n");
}

const TEXT_EXTENSIONS = new Set(
	".txt .text .md .markdown .json .jsonl .xml .yaml .yml .toml .ini .cfg .conf .log .rst .tex .srt .vtt .svg .eml".split(" "),
);
const FEED_EXTENSIONS = new Set([".rss", ".atom"]);
const IMAGE_EXTENSIONS = new Set(".png .jpg .jpeg .gif .webp .bmp .tif .tiff .heic .avif".split(" "));

/** Whether bytes are text: no NUL in their first 8 KB, and UTF-8 where they claim nothing else. */
function looksLikeText(buf: Buffer): boolean {
	const head = buf.subarray(0, 8192);
	if (head.includes(0) && !(head[0] === 0xff && head[1] === 0xfe) && !(head[0] === 0xfe && head[1] === 0xff)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 4)));
		return true;
	} catch {
		return false;
	}
}

/** The charset an HTML page declares in its first kilobytes. */
const declaredCharset = (buf: Buffer) => /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString("latin1"))?.[1];

async function bufferToMarkdown(buf: Buffer, name: string, kind: Kind | undefined): Promise<Converted> {
	const ext = path.extname(name).toLowerCase();
	switch (kind) {
		case "html":
			return { label: "HTML page", markdown: htmlPageToMarkdown(decodeText(buf, declaredCharset(buf))) };
		case "csv":
			return { label: "CSV file", markdown: csvToMarkdown(decodeText(buf), ",") };
		case "tsv":
			return { label: "TSV file", markdown: csvToMarkdown(decodeText(buf), "\t") };
		case "ipynb":
			return { label: "Jupyter notebook", markdown: notebookToMarkdown(decodeText(buf)) };
	}
	if (TEXT_EXTENSIONS.has(ext) || FEED_EXTENSIONS.has(ext) || (!IMAGE_EXTENSIONS.has(ext) && looksLikeText(buf))) {
		const text = decodeText(buf);
		const feed = FEED_EXTENSIONS.has(ext) || ext === ".xml" ? feedToMarkdown(text) : undefined;
		if (feed !== undefined) return { label: "feed", markdown: feed };
		return { label: "text file", markdown: text };
	}
	if (IMAGE_EXTENSIONS.has(ext)) throw new ConvertError(`${name} is an image; read shows images to the model`);
	throw new ConvertError(`${name} is in no format this tool converts`);
}

// ---------------------------------------------------------------------------------------------------------------------
// ZIP packages: Office documents, EPUB, and plain archives

async function zipToMarkdown(zip: Zip, name: string, depth: number, signal?: AbortSignal): Promise<Converted> {
	const main = relOfType(relationships(zip, ""), "officeDocument");
	if (main && !main.external) {
		const type = contentTypes(zip)(main.target) ?? "";
		if (type.includes("wordprocessingml")) return docxToMarkdown(zip, main.target);
		if (type.includes("presentationml")) return pptxToMarkdown(zip, main.target);
		if (type.includes("spreadsheetml")) return xlsxToMarkdown(zip, main.target);
	}
	if (zip.name("META-INF/container.xml") && (zip.text("mimetype") ?? "").trim().startsWith("application/epub")) {
		return epubToMarkdown(zip);
	}
	if (zip.name("META-INF/container.xml") && path.extname(name).toLowerCase() === ".epub") return epubToMarkdown(zip);
	let md = `Content from the zip file \`${name}\`:\n\n`;
	for (const entry of zip.entries.keys()) {
		if (entry.endsWith("/")) continue;
		signal?.throwIfAborted();
		try {
			const doc = await entryToMarkdown(zip, entry, depth, signal);
			md += `## File: ${entry}\n\n${tidy(doc.markdown)}\n\n`;
		} catch (error) {
			// A member that cannot be read is left out, as markitdown leaves it out; an archive too large for the budget
			// ends the conversion.
			if (error instanceof ConvertError && error.message === ZIP_TOO_LARGE) throw error;
			if (error instanceof ConvertError && error.message === ZIP_TOO_DEEP) md += `## File: ${entry}\n\n[${ZIP_TOO_DEEP}]\n\n`;
			if (signal?.aborted) throw error;
		}
	}
	return { label: "ZIP archive", markdown: md.trim() };
}

async function entryToMarkdown(zip: Zip, entry: string, depth: number, signal?: AbortSignal): Promise<Converted> {
	const base = path.posix.basename(entry);
	const ext = path.extname(base).toLowerCase();
	const buf = zip.bytes(entry) as Buffer;
	const kind = KINDS[ext] ?? (buf.subarray(0, 5).toString("latin1") === "%PDF-" ? "pdf" : buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50 ? "zip" : undefined);
	if (kind === "unsupported") throw unsupported(base);
	if (kind === "zip") {
		if (depth >= MAX_ZIP_DEPTH) throw new ConvertError(ZIP_TOO_DEEP);
		return zipToMarkdown(new Zip(buf, zip.budget), base, depth + 1, signal);
	}
	if (kind === "pdf") {
		const dir = mkdtempSync(path.join(os.tmpdir(), "markitdown-"));
		try {
			const file = path.join(dir, "member.pdf");
			writeFileSync(file, buf);
			return { label: "PDF", markdown: await pdfToMarkdown(file, signal) };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	return bufferToMarkdown(buf, base, kind);
}

// ---------------------------------------------------------------------------------------------------------------------
// Files

/** What a file is, by its extension or, without a known one, by its first bytes. */
type Kind = "pdf" | "zip" | "html" | "csv" | "tsv" | "ipynb" | "unsupported";

const KINDS: Record<string, Kind> = {
	".pdf": "pdf",
	".docx": "zip", ".docm": "zip", ".dotx": "zip", ".dotm": "zip",
	".pptx": "zip", ".pptm": "zip", ".ppsx": "zip", ".ppsm": "zip", ".potx": "zip", ".potm": "zip",
	".xlsx": "zip", ".xlsm": "zip", ".xltx": "zip", ".xltm": "zip",
	".epub": "zip", ".zip": "zip",
	".html": "html", ".htm": "html", ".xhtml": "html",
	".csv": "csv", ".tsv": "tsv", ".tab": "tsv",
	".ipynb": "ipynb",
	".doc": "unsupported", ".dot": "unsupported", ".xls": "unsupported", ".xlt": "unsupported", ".xlsb": "unsupported",
	".ppt": "unsupported", ".pps": "unsupported", ".pot": "unsupported", ".msg": "unsupported",
	".odt": "unsupported", ".ods": "unsupported", ".odp": "unsupported",
};

/** What a file the read tool reads becomes instead: the binary formats, whose bytes read as text help nobody. */
const READ_KINDS = new Set<Kind>(["pdf", "zip", "unsupported"]);

/** The format to save a file in that is not converted, by its extension. */
const SAVE_AS: Record<string, string> = {
	".doc": "docx", ".dot": "docx", ".odt": "docx", ".xls": "xlsx", ".xlt": "xlsx", ".xlsb": "xlsx", ".ods": "xlsx",
	".ppt": "pptx", ".pps": "pptx", ".pot": "pptx", ".odp": "pptx",
};

function head(file: string, length: number): Buffer {
	const buf = Buffer.alloc(length);
	const fd = openSync(file, "r");
	try {
		return buf.subarray(0, readSync(fd, buf, 0, length, 0));
	} finally {
		closeSync(fd);
	}
}

function sniff(file: string): Kind | undefined {
	let bytes: Buffer;
	try {
		bytes = head(file, 8);
	} catch {
		return undefined;
	}
	if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
	if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return "zip";
	if (bytes.length === 8 && bytes.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "unsupported";
	return undefined;
}

function unsupported(name: string): ConvertError {
	const ext = path.extname(name).toLowerCase();
	const target = SAVE_AS[ext];
	if (ext === ".msg") return new ConvertError(`${name} is an Outlook message, which is not converted; save it as PDF or .eml`);
	if (target) {
		return new ConvertError(
			`${name} is a format that is not converted; save it as .${target} first ` +
				`(LibreOffice: soffice --headless --convert-to ${target} ${JSON.stringify(name)})`,
		);
	}
	return new ConvertError(`${name} is an old binary Office file, which is not converted; save it as .docx, .xlsx, or .pptx first`);
}

interface Converted {
	/** What the file is, for the model: "PDF", "Word document", ... */
	label: string;
	markdown: string;
}

/** Final touches as markitdown makes them: no trailing blanks, at most one empty line in a row. */
function tidy(markdown: string): string {
	return markdown
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function convertFile(file: string, signal?: AbortSignal): Promise<Converted> {
	const name = path.basename(file);
	const kind = KINDS[path.extname(file).toLowerCase()] ?? sniff(file);
	if (kind === "unsupported") throw unsupported(name);
	if (kind === "pdf") return { label: "PDF", markdown: await pdfToMarkdown(file, signal) };
	const buf = readFileSync(file);
	if (kind === "zip") return zipToMarkdown(new Zip(buf), name, 0, signal);
	return bufferToMarkdown(buf, name, kind);
}

const cache = new Map<string, Converted & { stamp: string }>();

/** A file's Markdown, from the cache while the file keeps its size and modification time. */
async function convertCached(file: string, signal?: AbortSignal): Promise<Converted> {
	const stat = statSync(file);
	if (!stat.isFile()) throw new ConvertError(`${file} is not a file`);
	const stamp = `${stat.size}:${stat.mtimeMs}`;
	const hit = cache.get(file);
	if (hit?.stamp === stamp) {
		cache.delete(file);
		cache.set(file, hit);
		return hit;
	}
	if (stat.size > MAX_FILE_BYTES) {
		throw new ConvertError(`${path.basename(file)} has ${formatSize(stat.size)}; files over ${formatSize(MAX_FILE_BYTES)} are not converted`);
	}
	const converted = await convertFile(file, signal);
	const entry = { ...converted, markdown: tidy(converted.markdown), stamp };
	cache.set(file, entry);
	while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
	return entry;
}

// ---------------------------------------------------------------------------------------------------------------------
// PDF

function pdftotextMissing(): ConvertError {
	const install =
		process.platform === "darwin"
			? "brew install poppler"
			: process.platform === "win32"
				? "scoop install poppler, or choco install poppler"
				: "the package poppler-utils (apt, dnf, zypper; poppler on Arch)";
	return new ConvertError(`a PDF needs pdftotext from Poppler, which is not on the PATH; install it with ${install}`);
}

/** pdftotext's output; null where it exceeds limit and over is "null". */
function pdftotext(args: string[], limit: number, over: "error" | "null", signal?: AbortSignal): Promise<string | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error: Error | null, text?: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (child.exitCode === null) child.kill();
			if (error) reject(error);
			else resolve(text ?? null);
		};
		const child = spawn("pdftotext", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const timer = setTimeout(() => finish(new ConvertError(`pdftotext took longer than ${PDF_TIMEOUT_MS / 1000} s`)), PDF_TIMEOUT_MS);
		const onAbort = () => finish(new Error("aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		const out: Buffer[] = [];
		let size = 0;
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size <= limit) out.push(chunk);
			else if (over === "null") finish(null, null);
			else finish(new ConvertError(`the PDF's text exceeds ${formatSize(limit)}`));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 8192) stderr += chunk.toString("utf8");
		});
		child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? pdftotextMissing() : error));
		child.on("close", (code) => {
			if (code === 0) return finish(null, Buffer.concat(out).toString("utf8"));
			const reason = stderr
				.split("\n")
				.filter((line) => /error/i.test(line) && !/^Syntax (Error|Warning)/.test(line))
				.slice(-3)
				.join("; ");
			const cause =
				code === 1
					? "it is damaged, no PDF, or locked with a password"
					: code === 3
						? "its permissions do not allow copying its text"
						: `exit code ${code}`;
			finish(new ConvertError(`pdftotext could not read the PDF: ${reason || cause}`));
		});
	});
}

/**
 * A PDF's text through pdftotext, page by page, a page marker before each page where there are several. The text is
 * built from the words and lines pdftotext finds (-bbox-layout), so that a hyphen at the end of a line stays, as in
 * markitdown, instead of joining the line to the next. Pages laid out as forms or borderless tables become tables, as
 * markitdown finds them. Where the layout is too large, pdftotext's plain text stands in.
 */
async function pdfToMarkdown(file: string, signal?: AbortSignal): Promise<string> {
	const input = path.resolve(file);
	const layout = await pdftotext(["-bbox-layout", "-enc", "UTF-8", input, "-"], MAX_PDF_LAYOUT_BYTES, "null", signal).catch(
		(error: unknown) => {
			if (signal?.aborted) throw error;
			return null;
		},
	);
	let pages: { text: string; form: string | null }[];
	if (layout !== null) pages = pdfLayout(layout);
	else {
		const plain = (await pdftotext(["-enc", "UTF-8", "-eol", "unix", input, "-"], MAX_PDF_TEXT_BYTES, "error", signal)) ?? "";
		pages = plain.split("\f").map((text) => ({ text, form: null }));
		if (pages.length > 1 && !pages[pages.length - 1].text.trim()) pages.pop();
	}
	const anyForm = pages.some((page) => page.form !== null);
	const texts = pages.map((page) => (anyForm ? (page.form ?? page.text.trim()) : page.text));
	const markdown =
		texts.length > 1
			? texts
					.map((text, i) => ({ text: text.trim(), i }))
					.filter((page) => page.text)
					.map((page) => `<!-- Page ${page.i + 1} -->\n${page.text}`)
					.join("\n\n")
			: (texts[0] ?? "");
	return mergePartialNumbering(markdown);
}

const PARTIAL_NUMBERING = /^\.\d+$/;

/** ".1" on a line of its own joins the next line with text, as MasterFormat specifications number paragraphs. */
function mergePartialNumbering(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const stripped = lines[i].trim();
		if (!PARTIAL_NUMBERING.test(stripped)) {
			out.push(lines[i]);
			continue;
		}
		let j = i + 1;
		while (j < lines.length && !lines[j].trim()) j++;
		if (j < lines.length) {
			out.push(`${stripped} ${lines[j].trim()}`);
			i = j;
		} else out.push(lines[i]);
	}
	return out.join("\n");
}

interface PdfWord {
	x0: number;
	x1: number;
	top: number;
	text: string;
}

/** Python's round(): halves to the even neighbour. */
function roundHalfEven(x: number): number {
	const r = Math.round(x);
	return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * Per page of pdftotext -bbox-layout output, its text, as pdftotext writes it but without joining hyphenated lines,
 * and the page as a form or table, or null where it reads better as running text. markitdown's words run on across
 * spaces; the words of one of pdftotext's lines stand for them, since pdftotext starts a new line, in a new block, where
 * a gap is wide enough for a new column.
 */
function pdfLayout(xhtml: string): { text: string; form: string | null }[] {
	const pages: { text: string; form: string | null }[] = [];
	const wordPattern = /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="[\d.-]+">([^<]*)<\/word>/g;
	for (const page of xhtml.split(/<page\s/).slice(1)) {
		const width = Number(/width="([\d.]+)"/.exec(page)?.[1] ?? 612);
		const words: PdfWord[] = [];
		const blocks: string[] = [];
		for (const block of page.split(/<block\s/).slice(1)) {
			const lines: string[] = [];
			for (const line of block.split(/<line\s/).slice(1)) {
				const parts: PdfWord[] = [];
				for (const m of line.matchAll(wordPattern)) {
					parts.push({ x0: Number(m[1]), x1: Number(m[3]), top: Number(m[2]), text: decodeEntities(m[4]) });
				}
				if (!parts.length) continue;
				const text = parts.map((w) => w.text).join(" ");
				lines.push(text);
				words.push({ x0: parts[0].x0, x1: parts[parts.length - 1].x1, top: parts[0].top, text });
			}
			if (lines.length) blocks.push(lines.join("\n"));
		}
		pages.push({ text: blocks.join("\n\n"), form: words.length ? pdfFormPage(words, width) : null });
	}
	return pages;
}

/** markitdown's form detection: rows of words that line up in at least two columns of the page become tables. */
function pdfFormPage(words: PdfWord[], pageWidth: number): string | null {
	const byRow = new Map<number, PdfWord[]>();
	for (const w of words) {
		const key = roundHalfEven(w.top / 5) * 5;
		byRow.set(key, [...(byRow.get(key) ?? []), w]);
	}
	const rows = [...byRow.keys()]
		.sort((a, b) => a - b)
		.map((key) => {
			const rowWords = (byRow.get(key) as PdfWord[]).sort((a, b) => a.x0 - b.x0);
			const text = rowWords.map((w) => w.text).join(" ");
			const xGroups: number[] = [];
			for (const x of rowWords.map((w) => w.x0).sort((a, b) => a - b)) {
				if (!xGroups.length || x - xGroups[xGroups.length - 1] > 50) xGroups.push(x);
			}
			return {
				words: rowWords,
				text,
				xGroups,
				paragraph: rowWords[rowWords.length - 1].x1 - rowWords[0].x0 > pageWidth * 0.55 && text.length > 60,
				partialNumbering: PARTIAL_NUMBERING.test(rowWords[0].text.trim()),
				tableRow: false,
			};
		});
	const positions = rows.filter((r) => r.xGroups.length >= 3 && !r.paragraph).flatMap((r) => r.xGroups);
	if (!positions.length) return null;
	positions.sort((a, b) => a - b);
	const gaps: number[] = [];
	for (let i = 0; i < positions.length - 1; i++) if (positions[i + 1] - positions[i] > 5) gaps.push(positions[i + 1] - positions[i]);
	let tolerance = 35;
	if (gaps.length >= 3) {
		gaps.sort((a, b) => a - b);
		tolerance = Math.max(25, Math.min(50, gaps[Math.floor(gaps.length * 0.7)]));
	}
	const columns: number[] = [];
	for (const x of positions) if (!columns.length || x - columns[columns.length - 1] > tolerance) columns.push(x);
	if (columns.length <= 1) return null;
	const contentWidth = columns[columns.length - 1] - columns[0];
	if (contentWidth / columns.length < 30) return null;
	if (columns.length / (contentWidth / 72) > 10) return null;
	if (columns.length > Math.max(15, Math.floor(20 * (pageWidth / 612)))) return null;
	for (const row of rows) {
		if (row.paragraph || row.partialNumbering) continue;
		const aligned = new Set<number>();
		for (const w of row.words) {
			const col = columns.findIndex((x) => Math.abs(w.x0 - x) < 40);
			if (col >= 0) aligned.add(col);
		}
		row.tableRow = aligned.size >= 2;
	}
	if (rows.filter((r) => r.tableRow).length / rows.length < 0.2) return null;
	const cellsOf = (row: (typeof rows)[number]) => {
		const cells = columns.map(() => "");
		for (const w of row.words) {
			let col = columns.length - 1;
			for (let c = 0; c < columns.length - 1; c++) {
				if (w.x0 < columns[c + 1] - 20) {
					col = c;
					break;
				}
			}
			cells[col] = cells[col] ? `${cells[col]} ${w.text}` : w.text;
		}
		return cells;
	};
	const out: string[] = [];
	for (let i = 0; i < rows.length; ) {
		if (!rows[i].tableRow) {
			out.push(rows[i].text);
			i++;
			continue;
		}
		const table: string[][] = [];
		while (i < rows.length && rows[i].tableRow) table.push(cellsOf(rows[i++]));
		const widths = columns.map((_, c) => Math.max(3, ...table.map((r) => r[c].length)));
		const line = (r: string[]) => `| ${r.map((cell, c) => cell.padEnd(widths[c])).join(" | ")} |`;
		out.push(line(table[0]), `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`, ...table.slice(1).map(line));
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Paging

/** Pi's read path rules: a leading @ dropped, ~ for the home folder, relative to the working directory. */
function resolvePath(input: string, cwd: string): string {
	let p = input.trim().replace(/^@/, "");
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(2));
	const resolved = path.resolve(cwd, p);
	if (!existsSync(resolved) && existsSync(resolved.normalize("NFD"))) return resolved.normalize("NFD");
	return resolved;
}

const displayPath = (p: string) => {
	const home = os.homedir();
	return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
};

/** A stretch of the Markdown, cut and announced as read cuts and announces a text file. */
function page(markdown: string, offset?: number, limit?: number): { text: string; truncation?: TruncationResult } {
	const lines = markdown.split("\n");
	const total = lines.length;
	const start = offset && offset > 1 ? Math.floor(offset) - 1 : 0;
	if (start >= total) throw new ConvertError(`Offset ${offset} is beyond the end of the Markdown (${total} lines total)`);
	const end = limit !== undefined && limit >= 1 ? Math.min(total, start + Math.floor(limit)) : total;
	const truncation = truncateHead(lines.slice(start, end).join("\n"));
	const first = start + 1;
	if (truncation.firstLineExceedsLimit) {
		let cut = lines[start];
		while (Buffer.byteLength(cut, "utf8") > DEFAULT_MAX_BYTES) cut = cut.slice(0, Math.floor(cut.length * 0.9));
		const next = first + 1 <= total ? ` Use offset=${first + 1} to continue.` : "";
		return {
			text: `${cut}\n\n[Line ${first} is longer than ${formatSize(DEFAULT_MAX_BYTES)} and was cut; saveTo of the markitdown tool writes it whole.${next}]`,
			truncation,
		};
	}
	if (truncation.truncated) {
		const last = first + truncation.outputLines - 1;
		const limitNote = truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
		return {
			text: `${truncation.content}\n\n[Showing lines ${first}-${last} of ${total}${limitNote}. Use offset=${last + 1} to continue.]`,
			truncation,
		};
	}
	if (end < total) return { text: `${truncation.content}\n\n[${total - end} more lines. Use offset=${end + 1} to continue.]` };
	return { text: truncation.content };
}

const asNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function errorText(error: unknown): string {
	if (error instanceof ConvertError) return error.message;
	const e = error as NodeJS.ErrnoException;
	if (e?.code === "ENOENT") return "no such file";
	if (e?.code === "EACCES" || e?.code === "EPERM") return "permission denied";
	if (e?.code === "EISDIR") return "a directory, not a file";
	return e?.message ?? String(error);
}

// ---------------------------------------------------------------------------------------------------------------------
// Extension

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "markitdown",
		label: "markitdown",
		description:
			"Read a document as Markdown: PDF, Word .docx, PowerPoint .pptx, Excel .xlsx, EPUB, HTML, CSV and TSV, " +
			"Jupyter notebooks, RSS and Atom feeds, and ZIP archives of these. Headings, lists, tables, links, and slide " +
			`notes are kept. Like read, the Markdown is cut at ${DEFAULT_MAX_LINES} lines or ` +
			`${formatSize(DEFAULT_MAX_BYTES)}; continue with offset, a line of the Markdown. saveTo writes the whole ` +
			"Markdown to a file instead.",
		promptSnippet: "Read documents (PDF, Word, PowerPoint, Excel, EPUB, HTML, CSV, notebooks, feeds) as Markdown",
		promptGuidelines: [
			"markitdown: use it whenever the content of a document is to be read, extracted, summarized, or compared (PDF, Word, PowerPoint, Excel, EPUB, HTML, CSV, notebooks, feeds), instead of bash with pdftotext, unzip, pandoc, or a Python script.",
			"markitdown: for a long document, saveTo writes its Markdown to a file that grep and read can search; read returns PDF, Office, EPUB, and ZIP files as the same Markdown.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the document (relative or absolute)" }),
			offset: Type.Optional(Type.Number({ description: "Line of the Markdown to start from (1-indexed)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return" })),
			saveTo: Type.Optional(Type.String({ description: "Write the whole Markdown to this file instead of returning it" })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },

		async execute(_id, params, signal, _onUpdate, ctx) {
			const file = resolvePath(params.path, ctx.cwd);
			let doc: Converted;
			try {
				doc = await convertCached(file, signal);
			} catch (error) {
				throw new Error(`${params.path}: ${errorText(error)}`);
			}
			const lines = doc.markdown ? doc.markdown.split("\n").length : 0;
			if (params.saveTo) {
				const target = resolvePath(params.saveTo, ctx.cwd);
				if (target === file) throw new Error("saveTo names the document itself; choose another file");
				await withFileMutationQueue(target, async () => {
					mkdirSync(path.dirname(target), { recursive: true });
					writeFileSync(target, doc.markdown ? `${doc.markdown}\n` : "");
				});
				const size = formatSize(Buffer.byteLength(doc.markdown, "utf8"));
				return {
					content: [{ type: "text", text: `Wrote the Markdown of ${params.path} (${doc.label}, ${lines} lines, ${size}) to ${params.saveTo}.` }],
					details: undefined,
				};
			}
			if (!doc.markdown) return { content: [{ type: "text", text: emptyNote(doc) }], details: undefined };
			return { content: [{ type: "text", text: page(doc.markdown, params.offset, params.limit).text }], details: undefined };
		},

		renderCall(args, theme) {
			const offset = asNumber(args.offset);
			const limit = asNumber(args.limit);
			const range =
				offset !== undefined || limit !== undefined
					? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
					: "";
			const target = typeof args.saveTo === "string" ? theme.fg("muted", " → ") + theme.fg("accent", args.saveTo) : "";
			const where = typeof args.path === "string" ? displayPath(args.path) : "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("markitdown"))} ${theme.fg("accent", where)}${theme.fg("warning", range)}${target}`,
				0,
				0,
			);
		},
	});

	// read returns the binary documents as Markdown.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return;
		const input = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
		if (typeof input.path !== "string") return;
		const file = resolvePath(input.path, ctx.cwd);
		const kind = KINDS[path.extname(file).toLowerCase()] ?? sniff(file);
		if (!kind || !READ_KINDS.has(kind)) return;
		let text: string;
		let details: { truncation: TruncationResult } | undefined;
		try {
			const doc = await convertCached(file, ctx.signal);
			if (!doc.markdown) text = emptyNote(doc);
			else {
				const part = page(doc.markdown, asNumber(input.offset), asNumber(input.limit));
				text = `[${doc.label} as Markdown; offset and limit count its lines]\n\n${part.text}`;
				if (part.truncation) details = { truncation: part.truncation };
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
			text = `${input.path}: ${errorText(error)}`;
			return { content: [{ type: "text", text }], details: undefined, isError: true };
		}
		return { content: [{ type: "text", text }], details, isError: false };
	});
}

function emptyNote(doc: Converted): string {
	return doc.label === "PDF"
		? "The PDF holds no text, a scan without a text layer perhaps. pdftoppm -png renders its pages as images, " +
				"which read shows."
		: `The ${doc.label} holds no text.`;
}
