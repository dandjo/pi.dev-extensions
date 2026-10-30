/**
 * Framed, scrollable boxes for the extensions that show more than a notification can hold: overlays for /hooks,
 * /agents, and /cron, and the frame and scrolling of the boxes /btw and the /diff dialog show above the prompt.
 *
 * Pi does not load this file as an extension: it sits in a subdirectory without index.ts. Extensions import it.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const OVERLAY_OPTIONS = { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 } as const;

/** Rows the body of an overlay may use: the overlay's height cap minus the frame and help lines. */
export function bodyRows(tui: TUI): number {
	return Math.max(3, Math.floor(tui.terminal.rows * 0.9) - 4);
}

/** Draws a rounded frame around `body`, with `title` in the top edge and `help` under it. */
export function frame(theme: Theme, width: number, title: string, body: string[], help: string): string[] {
	const inner = Math.max(1, width - 4);
	const border = (s: string) => theme.fg("border", s);
	const head = truncateToWidth(` ${title} `, Math.max(1, width - 4), "…");
	const lines = [border("╭─") + theme.fg("accent", head) + border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(head)))}╮`)];
	for (const line of body) lines.push(`${border("│")} ${truncateToWidth(line, inner, "…", true)} ${border("│")}`);
	lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
	lines.push(truncateToWidth(theme.fg("dim", ` ${help}`), width));
	return lines;
}

/** Moves `offset` for the scroll keys; returns the new offset, or undefined when `data` is no scroll key. */
export function scrollKey(data: string, offset: number, total: number, rows: number): number | undefined {
	const max = Math.max(0, total - rows);
	if (matchesKey(data, Key.up) || data === "k") return Math.max(0, offset - 1);
	if (matchesKey(data, Key.down) || data === "j") return Math.min(max, offset + 1);
	if (matchesKey(data, Key.pageUp)) return Math.max(0, offset - rows);
	if (matchesKey(data, Key.pageDown) || data === " ") return Math.min(max, offset + rows);
	if (matchesKey(data, Key.home) || data === "g") return 0;
	if (matchesKey(data, Key.end) || data === "G") return max;
	return undefined;
}

/** The visible slice of `lines`, padded to `rows` so the frame keeps its height while scrolling. */
export function viewport(lines: string[], offset: number, rows: number): string[] {
	const visible = lines.slice(offset, offset + rows);
	return lines.length > rows ? [...visible, ...Array(Math.max(0, rows - visible.length)).fill("")] : visible;
}

/**
 * Shows read-only text in a scrollable overlay until Esc, q, or Enter. `build` renders the body lines for a width;
 * longer lines are wrapped. Outside the interactive terminal the text goes out as a notification instead.
 */
export async function showText(
	ctx: ExtensionContext,
	title: string,
	build: (width: number, theme: Theme) => string[],
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(build(100, ctx.ui.theme).join("\n"), "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let offset = 0;
			let cache: { width: number; lines: string[] } | undefined;
			const body = (width: number) => {
				if (!cache || cache.width !== width) {
					const inner = Math.max(1, width - 4);
					cache = { width, lines: build(inner, theme).flatMap((line) => (line ? wrapTextWithAnsi(line, inner) : [""])) };
				}
				return cache.lines;
			};
			return {
				render(width: number): string[] {
					const lines = body(width);
					const rows = Math.min(bodyRows(tui), Math.max(1, lines.length));
					offset = Math.min(offset, Math.max(0, lines.length - rows));
					const more = lines.length > rows ? `  ${offset + 1}–${Math.min(lines.length, offset + rows)}/${lines.length}` : "";
					return frame(theme, width, title, viewport(lines, offset, rows), `↑↓ PgUp PgDn scroll · Esc close${more}`);
				},
				handleInput(data: string): void {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
						done();
						return;
					}
					const lines = body(cache?.width ?? 80);
					const next = scrollKey(data, offset, lines.length, Math.min(bodyRows(tui), lines.length));
					if (next !== undefined && next !== offset) {
						offset = next;
						tui.requestRender();
					}
				},
				invalidate(): void {
					cache = undefined;
				},
			};
		},
		{ overlay: true, overlayOptions: OVERLAY_OPTIONS },
	);
}
