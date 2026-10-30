/**
 * QR code encoder for the terminal: byte mode, any error correction level, versions 1–40, mask chosen by the standard
 * penalty score. A port of the public-domain algorithm of Project Nayuki's QR Code generator, reduced to what the
 * extensions need (the session link of /remote-control).
 *
 * Pi does not load this file as an extension: it sits in a subdirectory without index.ts. Extensions import it.
 */

export type EccLevel = "L" | "M" | "Q" | "H";

const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Indexed by version (index 0 unused), per error correction level.
const ECC_CODEWORDS_PER_BLOCK: Record<EccLevel, number[]> = {
	L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
	Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const NUM_ERROR_CORRECTION_BLOCKS: Record<EccLevel, number[]> = {
	L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
	M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
	Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
	H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** A QR symbol: `modules[y][x]` is true for a dark module. */
export interface QrCode {
	version: number;
	size: number;
	mask: number;
	modules: boolean[][];
}

function numRawDataModules(version: number): number {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const numAlign = Math.floor(version / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (version >= 7) result -= 36;
	}
	return result;
}

function numDataCodewords(version: number, ecl: EccLevel): number {
	return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][version] * NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
}

// --- Reed–Solomon over GF(2^8) with the QR polynomial 0x11D -------------------------------------------------------

function gfMultiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

function rsDivisor(degree: number): number[] {
	const result = new Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = gfMultiply(result[j], root);
			if (j + 1 < result.length) result[j] ^= result[j + 1];
		}
		root = gfMultiply(root, 0x02);
	}
	return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
	const result = divisor.map(() => 0);
	for (const b of data) {
		const factor = b ^ (result.shift() as number);
		result.push(0);
		divisor.forEach((coef, i) => {
			result[i] ^= gfMultiply(coef, factor);
		});
	}
	return result;
}

function addEccAndInterleave(data: number[], version: number, ecl: EccLevel): number[] {
	const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
	const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][version];
	const rawCodewords = Math.floor(numRawDataModules(version) / 8);
	const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
	const shortBlockLen = Math.floor(rawCodewords / numBlocks);

	const blocks: number[][] = [];
	const divisor = rsDivisor(blockEccLen);
	for (let i = 0, k = 0; i < numBlocks; i++) {
		const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
		k += dat.length;
		const ecc = rsRemainder(dat, divisor);
		if (i < numShortBlocks) dat.push(0);
		blocks.push(dat.concat(ecc));
	}

	const result: number[] = [];
	for (let i = 0; i < blocks[0].length; i++) {
		blocks.forEach((block, j) => {
			if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
		});
	}
	return result;
}

// --- Symbol construction ------------------------------------------------------------------------------------------

function alignmentPatternPositions(version: number, size: number): number[] {
	if (version === 1) return [];
	const numAlign = Math.floor(version / 7) + 2;
	const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
	const result = [6];
	for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
	return result;
}

class Builder {
	readonly size: number;
	readonly modules: boolean[][];
	readonly isFunction: boolean[][];

	constructor(
		readonly version: number,
		readonly ecl: EccLevel,
	) {
		this.size = version * 4 + 17;
		this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
		this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
	}

	setFunction(x: number, y: number, dark: boolean): void {
		this.modules[y][x] = dark;
		this.isFunction[y][x] = true;
	}

	drawFunctionPatterns(): void {
		for (let i = 0; i < this.size; i++) {
			this.setFunction(6, i, i % 2 === 0);
			this.setFunction(i, 6, i % 2 === 0);
		}
		this.drawFinder(3, 3);
		this.drawFinder(this.size - 4, 3);
		this.drawFinder(3, this.size - 4);

		const positions = alignmentPatternPositions(this.version, this.size);
		const last = positions.length - 1;
		for (let i = 0; i < positions.length; i++) {
			for (let j = 0; j < positions.length; j++) {
				if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
				this.drawAlignment(positions[i], positions[j]);
			}
		}
		this.drawFormatBits(0);
		this.drawVersion();
	}

	private drawFinder(x: number, y: number): void {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const xx = x + dx;
				const yy = y + dy;
				if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunction(xx, yy, dist !== 2 && dist !== 4);
			}
		}
	}

	private drawAlignment(x: number, y: number): void {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
	}

	drawFormatBits(mask: number): void {
		const data = (ECC_FORMAT_BITS[this.ecl] << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((data << 10) | rem) ^ 0x5412;
		const bit = (i: number) => ((bits >>> i) & 1) !== 0;

		for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
		this.setFunction(8, 7, bit(6));
		this.setFunction(8, 8, bit(7));
		this.setFunction(7, 8, bit(8));
		for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));

		for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
		this.setFunction(8, this.size - 8, true);
	}

	private drawVersion(): void {
		if (this.version < 7) return;
		let rem = this.version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const bits = (this.version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const bit = ((bits >>> i) & 1) !== 0;
			const a = this.size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			this.setFunction(a, b, bit);
			this.setFunction(b, a, bit);
		}
	}

	drawCodewords(data: number[]): void {
		let i = 0;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < this.size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? this.size - 1 - vert : vert;
					if (!this.isFunction[y][x] && i < data.length * 8) {
						this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
						i++;
					}
				}
			}
		}
	}

	applyMask(mask: number): void {
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				let invert: boolean;
				switch (mask) {
					case 0:
						invert = (x + y) % 2 === 0;
						break;
					case 1:
						invert = y % 2 === 0;
						break;
					case 2:
						invert = x % 3 === 0;
						break;
					case 3:
						invert = (x + y) % 3 === 0;
						break;
					case 4:
						invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
						break;
					case 5:
						invert = ((x * y) % 2) + ((x * y) % 3) === 0;
						break;
					case 6:
						invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
						break;
					default:
						invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
				}
				if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
			}
		}
	}

	penaltyScore(): number {
		let result = 0;
		const size = this.size;
		const m = this.modules;

		for (let y = 0; y < size; y++) {
			let runColor = false;
			let runX = 0;
			const history = new Array<number>(7).fill(0);
			for (let x = 0; x < size; x++) {
				if (m[y][x] === runColor) {
					runX++;
					if (runX === 5) result += PENALTY_N1;
					else if (runX > 5) result++;
				} else {
					finderPenaltyAddHistory(runX, history, size);
					if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
					runColor = m[y][x];
					runX = 1;
				}
			}
			result += finderPenaltyTerminateAndCount(runColor, runX, history, size) * PENALTY_N3;
		}
		for (let x = 0; x < size; x++) {
			let runColor = false;
			let runY = 0;
			const history = new Array<number>(7).fill(0);
			for (let y = 0; y < size; y++) {
				if (m[y][x] === runColor) {
					runY++;
					if (runY === 5) result += PENALTY_N1;
					else if (runY > 5) result++;
				} else {
					finderPenaltyAddHistory(runY, history, size);
					if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
					runColor = m[y][x];
					runY = 1;
				}
			}
			result += finderPenaltyTerminateAndCount(runColor, runY, history, size) * PENALTY_N3;
		}

		for (let y = 0; y < size - 1; y++) {
			for (let x = 0; x < size - 1; x++) {
				const color = m[y][x];
				if (color === m[y][x + 1] && color === m[y + 1][x] && color === m[y + 1][x + 1]) result += PENALTY_N2;
			}
		}

		let dark = 0;
		for (const row of m) for (const cell of row) if (cell) dark++;
		const total = size * size;
		const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
		result += k * PENALTY_N4;
		return result;
	}
}

function finderPenaltyCountPatterns(history: number[]): number {
	const n = history[1];
	const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
	return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
}

function finderPenaltyTerminateAndCount(currentRunColor: boolean, currentRunLength: number, history: number[], size: number): number {
	if (currentRunColor) {
		finderPenaltyAddHistory(currentRunLength, history, size);
		currentRunLength = 0;
	}
	currentRunLength += size;
	finderPenaltyAddHistory(currentRunLength, history, size);
	return finderPenaltyCountPatterns(history);
}

function finderPenaltyAddHistory(currentRunLength: number, history: number[], size: number): void {
	if (history[0] === 0) currentRunLength += size;
	history.pop();
	history.unshift(currentRunLength);
}

/**
 * Encodes `text` (as UTF-8 bytes) at the smallest version that holds it with error correction `ecl`. `mask` forces a
 * mask pattern (0–7); otherwise the pattern with the lowest penalty score is used.
 */
export function encodeQr(text: string, ecl: EccLevel = "M", mask = -1): QrCode {
	const bytes = [...Buffer.from(text, "utf8")];
	let version = 1;
	for (; ; version++) {
		const capacityBits = numDataCodewords(version, ecl) * 8;
		const countBits = version <= 9 ? 8 : 16;
		if (4 + countBits + bytes.length * 8 <= capacityBits) break;
		if (version >= 40) throw new Error("Text too long for a QR code");
	}

	const bits: number[] = [];
	const push = (value: number, length: number) => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	push(0x4, 4);
	push(bytes.length, version <= 9 ? 8 : 16);
	for (const b of bytes) push(b, 8);

	const capacityBits = numDataCodewords(version, ecl) * 8;
	push(0, Math.min(4, capacityBits - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let b = 0;
		for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
		data.push(b);
	}

	const builder = new Builder(version, ecl);
	builder.drawFunctionPatterns();
	builder.drawCodewords(addEccAndInterleave(data, version, ecl));

	if (mask < 0 || mask > 7) {
		let best = Number.POSITIVE_INFINITY;
		for (let i = 0; i < 8; i++) {
			builder.applyMask(i);
			builder.drawFormatBits(i);
			const penalty = builder.penaltyScore();
			if (penalty < best) {
				best = penalty;
				mask = i;
			}
			builder.applyMask(i);
		}
	}
	builder.applyMask(mask);
	builder.drawFormatBits(mask);

	return { version, size: builder.size, mask, modules: builder.modules };
}

/**
 * The code as terminal lines, two modules per row with half blocks, light modules white on black so that it reads
 * on any terminal theme. `quiet` is the border in modules on each side.
 */
export function renderQr(code: QrCode, quiet = 2): string[] {
	const size = code.size + quiet * 2;
	const dark = (x: number, y: number): boolean => {
		const mx = x - quiet;
		const my = y - quiet;
		if (mx < 0 || my < 0 || mx >= code.size || my >= code.size) return false;
		return code.modules[my][mx];
	};
	const lines: string[] = [];
	for (let y = 0; y < size; y += 2) {
		let line = "";
		for (let x = 0; x < size; x++) {
			const top = dark(x, y);
			const bottom = y + 1 < size ? dark(x, y + 1) : true;
			line += top ? (bottom ? " " : "▄") : bottom ? "▀" : "█";
		}
		lines.push(`\x1b[97;40m${line}\x1b[0m`);
	}
	return lines;
}
