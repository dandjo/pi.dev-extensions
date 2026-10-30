/**
 * Statusline extension — mirrors the Claude Code status line
 * (https://github.com/dandjo/claude-code-cli-status-line), for any provider.
 *
 * Line 1: [model · thinking level]  📂 working dir  🌿 git branch
 * Line 2: context-window usage bar, tokens in context, session cost, elapsed time
 * Then: the rows other extensions add as sections (claude-usage.ts: the Claude subscription limits)
 * Last line (optional): statuses other extensions set via ctx.ui.setStatus()
 *
 * Sections come through the event bus, whatever the load order: an extension emits "statusline:section" with a
 * StatuslineSection at load and again on every "statusline:section-request"; "statusline:changed" asks for a render.
 * A section's render() runs at every render of the footer, so it must return at once and never wait for anything.
 * In fullscreen mode a click on an extension status in the last line emits "statusline:status-click" with its key
 * ({ key }); the extension that set the status decides what happens (scheduled-tasks.ts opens its task manager).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as os from "node:os";
import { meter, separator } from "./lib/meter.ts";

const INDENT = " ";
const TICK_MS = 10_000;

/** Rows another extension adds below line 2 ("statusline:section" on the event bus). */
export interface StatuslineSection {
	/** Sections appear in the order of their ids; one emitted again under the same id replaces the earlier one. */
	id: string;
	/** The rows, without indent: the status line indents them and cuts them to the terminal width. */
	render(theme: Theme): string[];
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${n}`;
}

function fmtElapsed(ms: number): string {
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	const s = Math.floor((ms % 60_000) / 1000);
	return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

function tildify(dir: string): string {
	const home = os.homedir();
	return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

export default function (pi: ExtensionAPI) {
	const startedAt = Date.now();
	const sections = new Map<string, StatuslineSection>();

	pi.events.on("statusline:section", (section) => {
		const s = section as StatuslineSection | undefined;
		if (typeof s?.id === "string" && typeof s.render === "function") sections.set(s.id, s);
	});
	pi.events.emit("statusline:section-request", undefined);

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const rerender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(rerender);
			const unsubChanged = pi.events.on("statusline:changed", rerender);
			const timer = setInterval(rerender, TICK_MS);
			const sep = separator(theme);
			/** Where each extension status sits in the last render, for a click on it. */
			let statusLine = -1;
			let statusSpans: { key: string; from: number; to: number }[] = [];

			return {
				dispose() {
					unsubBranch();
					unsubChanged();
					clearInterval(timer);
				},
				invalidate() {},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					if (event.button !== "left" || (event.type !== "press" && event.type !== "click") || event.y !== statusLine) return undefined;
					const span = statusSpans.find((s) => event.x >= s.from && event.x < s.to);
					if (!span) return undefined;
					if (event.type === "click") pi.events.emit("statusline:status-click", { key: span.key });
					return { handled: true };
				},
				render(width: number): string[] {
					// --- Line 1: model, dir, branch -------------------------------
					const modelName = ctx.model?.name ?? ctx.model?.id ?? "no model";
					const level = ctx.thinkingLevel;
					const modelFmt =
						theme.fg("accent", `[${modelName}`) +
						(level && level !== "off" ? theme.fg("dim", " · ") + theme.fg("warning", level) : "") +
						theme.fg("accent", "]");

					const dir = theme.fg("mdLink", tildify(ctx.cwd));
					const branch = footerData.getGitBranch();
					const branchFmt = branch ? sep + `🌿 ${theme.fg("success", branch)}` : "";

					const lines = [`${modelFmt} 📂 ${dir}${branchFmt}`];

					// --- Line 2: context bar, tokens, cost, time ------------------
					let cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							cost += (e.message as AssistantMessage).usage.cost.total;
						}
					}
					const ctxUsage = ctx.getContextUsage();
					const tokens = ctxUsage?.tokens ?? null;
					lines.push(
						meter(theme, "Context", ctxUsage?.percent ?? null) +
							sep +
							`🪙 Tokens ${theme.fg("accent", tokens === null ? "?" : fmtTokens(tokens))}` +
							` (${theme.fg("warning", `$${cost.toFixed(2)}`)})` +
							sep +
							`⏳ ${fmtElapsed(Date.now() - startedAt)}`,
					);

					// --- Sections of other extensions ----------------------------
					for (const id of [...sections.keys()].sort()) {
						try {
							lines.push(...sections.get(id)!.render(theme));
						} catch {
							// a failing section must not take the footer down
						}
					}

					// --- Statuses from other extensions --------------------------
					const statuses = [...footerData.getExtensionStatuses().entries()];
					statusLine = -1;
					statusSpans = [];
					if (statuses.length > 0) {
						let x = INDENT.length;
						for (const [key, text] of statuses) {
							if (statusSpans.length > 0) x += 3; // " · "
							const w = visibleWidth(text);
							statusSpans.push({ key, from: x, to: x + w });
							x += w;
						}
						statusLine = lines.length;
						lines.push(statuses.map(([, text]) => text).join(theme.fg("dim", " · ")));
					}

					return lines.map((l) => truncateToWidth(INDENT + l, width));
				},
			};
		});
	});
}
