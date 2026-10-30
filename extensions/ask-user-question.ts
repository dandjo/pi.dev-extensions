/**
 * AskUserQuestion: Claude Code's multiple-choice question tool, with its name, parameters, and answer format, so skills
 * written for Claude Code (setup wizards, …) work in Pi unchanged.
 *
 * - One to four questions per call, each with a short header, two to four options (label, description, optional
 *   preview), and multiSelect. Every question also offers "Other" for an answer in the user's own words.
 * - Interactive terminal: the questions replace the editor; several questions (or a multi-select one) get a tab per
 *   question and a Submit tab. Up/Down or the digit keys pick, Space toggles in a multi-select, Enter confirms,
 *   Tab/Left/Right move between questions, Esc dismisses. The highlighted option has the selection background, as in
 *   Claude Code. In fullscreen mode the mouse works too: the highlight follows the pointer, a tab under the pointer
 *   gets a lighter background, a click on an option picks it as Enter does (toggles it in a multi-select), a click on a
 *   tab opens it, a click on the submit line on the Submit tab submits, and the wheel moves the highlight.
 * - RPC clients get one select dialog per question. Without any UI the call fails with a note to decide alone.
 * - `answers` (question -> answer), as a PreToolUse hook can supply it through updatedInput, skips the dialog.
 * - Answers from elsewhere: while the dialog is open, the event ask-user-question:open (QuestionsOpen) offers the
 *   questions to other extensions — claude-remote-control.ts puts them in the Claude app. The first answer wins, from
 *   the terminal or from there, and closes the other side; ask-user-question:close (QuestionsClose) tells how the
 *   questions ended. Interrupting the run withdraws them.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const OTHER = "Other";
const QUESTIONS_OPEN = "ask-user-question:open";
const QUESTIONS_CLOSE = "ask-user-question:close";

const OptionSchema = Type.Object({
	label: Type.String({ description: "The display text for this option, 1-5 words." }),
	description: Type.String({ description: "What this option means or what happens if it is chosen." }),
	preview: Type.Optional(
		Type.String({ description: "Optional preview shown while the option is focused, such as a code snippet or a mockup." }),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({
		description: "The complete question to ask the user. Clear, specific, and ending with a question mark.",
	}),
	header: Type.String({
		description: 'Very short label shown as a chip/tag (max 12 chars), e.g. "Auth method", "Library", "Approach".',
	}),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 4,
		description: "The available choices, 2-4 options. Do not add an 'Other' option; it is always offered.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set to true to allow the user to select multiple options instead of just one." }),
	),
});

const Params = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4, description: "Questions to ask the user (1-4 questions)." }),
	answers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Filled in by hooks to answer programmatically. Leave it out.",
		}),
	),
});

interface QuestionOption {
	label: string;
	description: string;
	preview?: string;
}

interface Question {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect?: boolean;
}

interface Answer {
	labels: string[];
	custom?: string;
}

interface Details {
	questions: Question[];
	answers: Record<string, string>;
	custom: string[];
	cancelled: boolean;
}

/** How the questions ended: answers by question index, or none when dismissed, with what the user wrote instead. */
interface Outcome {
	answers?: Map<number, Answer>;
	message?: string;
}

/** ask-user-question:open. answer and decline return false once the questions were settled otherwise. */
interface QuestionsOpen {
	toolCallId: string;
	questions: Question[];
	/** Answers by question text, multi-select labels joined with ", "; annotations as Claude Code's (notes per question). */
	answer(answers: Record<string, string>, annotations?: Record<string, { notes?: string }>): boolean;
	decline(message?: string): boolean;
}

/** ask-user-question:close: answers by question text, absent when the questions were dismissed or withdrawn. */
interface QuestionsClose {
	toolCallId: string;
	answers?: Record<string, string>;
}

const DESCRIPTION = [
	"Asks the user multiple-choice questions to gather information, clarify ambiguity, understand preferences, make decisions, or offer choices.",
	"",
	"Use this tool when you need to ask the user questions during execution. This allows you to:",
	"1. Gather user preferences or requirements",
	"2. Clarify ambiguous instructions",
	"3. Get decisions on implementation choices as you work",
	"4. Offer choices to the user about what direction to take",
	"",
	"Usage notes:",
	'- Users will always be able to select "Other" to provide custom text input',
	"- Use multiSelect: true to allow multiple answers to be selected for a question",
	'- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
].join("\n");

function answerText(answer: Answer): string {
	return [...answer.labels, ...(answer.custom ? [answer.custom] : [])].join(", ");
}

function resultText(details: Details): string {
	const pairs = details.questions.map((q) => `"${q.question}"="${details.answers[q.question] ?? ""}"`).join(", ");
	const note =
		details.custom.length > 0
			? " Answers the user typed in their own words are quoted as written; follow them as written, including a request to wait or explain first."
			: "";
	return `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.${note}`;
}

/** Answers by question text, as another extension hands them over, by question index. */
function fromRecord(questions: Question[], answers: Record<string, unknown>, annotations?: Record<string, { notes?: unknown }>): Map<number, Answer> {
	const result = new Map<number, Answer>();
	questions.forEach((q, i) => {
		const raw = answers[q.question];
		const value = typeof raw === "string" ? raw.trim() : "";
		const labels = q.options.map((o) => o.label);
		let answer: Answer;
		if (labels.includes(value)) answer = { labels: [value] };
		else if (q.multiSelect) {
			const parts = value.split(", ").filter(Boolean);
			const custom = parts.filter((part) => !labels.includes(part)).join(", ");
			answer = { labels: parts.filter((part) => labels.includes(part)), ...(custom && { custom }) };
		} else answer = value ? { labels: [], custom: value } : { labels: [] };
		const notes = annotations?.[q.question]?.notes;
		if (typeof notes === "string" && notes.trim()) answer.custom = answer.custom ? `${answer.custom}; ${notes.trim()}` : notes.trim();
		result.set(i, answer);
	});
	return result;
}

/** What a rendered line of the terminal dialog is, for the mouse. */
type LineHit =
	| { kind: "option"; index: number }
	| { kind: "tabs"; spans: { from: number; to: number; tab: number }[] }
	| { kind: "submit" };

/** Interactive terminal dialog. Resolves to the answers by question index, or undefined when dismissed or closed. */
function askInTerminal(ctx: ExtensionContext, questions: Question[], signal: AbortSignal): Promise<Map<number, Answer> | undefined> {
	return ctx.ui.custom<Map<number, Answer> | undefined>((tui, theme, _keybindings, done) => {
		if (signal.aborted) done(undefined);
		else signal.addEventListener("abort", () => done(undefined), { once: true });
		const tabbed = questions.length > 1 || questions.some((q) => q.multiSelect);
		const submitTab = questions.length;
		let tab = 0;
		const cursor = questions.map(() => 0);
		const toggled = questions.map(() => new Set<number>());
		const answers = new Map<number, Answer>();
		let typing = false;
		let cache: string[] | undefined;
		/** What each line of the last render is, by line index. */
		let hits: (LineHit | undefined)[] = [];
		/** The tab under the pointer. */
		let hoverTab: number | undefined;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		const refresh = () => {
			cache = undefined;
			tui.requestRender();
		};
		const rows = (q: number) => questions[q].options.length + 1;
		const allAnswered = () => questions.every((_, i) => answers.has(i));

		const advance = () => {
			if (!tabbed) {
				done(answers);
				return;
			}
			const next = questions.findIndex((_, i) => i > tab && !answers.has(i));
			tab = next >= 0 ? next : allAnswered() ? submitTab : questions.findIndex((_, i) => !answers.has(i));
			refresh();
		};

		const confirmMulti = (q: number) => {
			const labels = [...toggled[q]].sort((a, b) => a - b).map((i) => questions[q].options[i].label);
			const custom = answers.get(q)?.custom;
			if (labels.length === 0 && !custom) return false;
			answers.set(q, { labels, custom });
			return true;
		};

		editor.onSubmit = (value) => {
			const text = value.trim();
			typing = false;
			editor.setText("");
			if (!text) {
				refresh();
				return;
			}
			const q = tab;
			if (questions[q].multiSelect) {
				answers.set(q, { labels: answers.get(q)?.labels ?? [], custom: text });
				confirmMulti(q);
			} else {
				answers.set(q, { labels: [], custom: text });
			}
			advance();
		};

		const choose = (q: number, index: number) => {
			cursor[q] = index;
			if (index === questions[q].options.length) {
				typing = true;
				editor.setText(answers.get(q)?.custom ?? "");
				refresh();
				return;
			}
			if (questions[q].multiSelect) {
				if (toggled[q].has(index)) toggled[q].delete(index);
				else toggled[q].add(index);
				if (!confirmMulti(q)) answers.delete(q);
				refresh();
				return;
			}
			answers.set(q, { labels: [questions[q].options[index].label] });
			advance();
		};

		function handleInput(data: string): void {
			if (typing) {
				if (matchesKey(data, Key.escape)) {
					typing = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}
			if (tabbed && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
				tab = (tab + 1) % (questions.length + 1);
				refresh();
				return;
			}
			if (tabbed && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
				tab = (tab + questions.length) % (questions.length + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}
			if (tab === submitTab) {
				if (matchesKey(data, Key.enter) && allAnswered()) done(answers);
				return;
			}
			const q = tab;
			if (matchesKey(data, Key.up)) {
				cursor[q] = (cursor[q] + rows(q) - 1) % rows(q);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursor[q] = (cursor[q] + 1) % rows(q);
				refresh();
				return;
			}
			if (/^[1-9]$/.test(data) && Number(data) <= rows(q)) {
				choose(q, Number(data) - 1);
				return;
			}
			if (questions[q].multiSelect && matchesKey(data, Key.space)) {
				choose(q, cursor[q]);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (questions[q].multiSelect && cursor[q] < questions[q].options.length) {
					if (toggled[q].size === 0 && !answers.get(q)?.custom) choose(q, cursor[q]);
					if (confirmMulti(q)) advance();
					return;
				}
				choose(q, cursor[q]);
			}
		}

		/** The mouse: a click picks an option, opens a tab, or submits; the wheel moves the highlight. */
		function handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (!cache) render(event.width);
			if (event.type === "move") {
				// Hover: a tab under the pointer lights up, and the highlight follows the pointer over the options, so Enter
				// picks what the pointer is on.
				const hit = hits[event.y];
				const overTab = hit?.kind === "tabs" ? hit.spans.find((s) => event.x >= s.from && event.x < s.to)?.tab : undefined;
				let changed = overTab !== hoverTab;
				hoverTab = overTab;
				if (!typing && tab !== submitTab && hit?.kind === "option" && cursor[tab] !== hit.index) {
					cursor[tab] = hit.index;
					changed = true;
				}
				if (!changed) return undefined;
				refresh();
				return { handled: true, render: true };
			}
			if (event.type === "wheel" && event.wheelDelta) {
				if (typing || tab === submitTab) return undefined;
				const q = tab;
				cursor[q] = Math.max(0, Math.min(rows(q) - 1, cursor[q] + (event.wheelDelta < 0 ? -1 : 1)));
				refresh();
				return { handled: true };
			}
			if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
			const hit = hits[event.y];
			if (!hit) return undefined;
			if (hit.kind === "tabs") {
				const span = hit.spans.find((s) => event.x >= s.from && event.x < s.to);
				if (!span) return undefined;
				if (event.type === "click" && span.tab !== tab) {
					typing = false;
					editor.setText("");
					tab = span.tab;
					refresh();
				}
				return { handled: true };
			}
			if (hit.kind === "submit") {
				if (event.type === "click" && allAnswered()) done(answers);
				return { handled: true };
			}
			const q = tab;
			if (event.type === "press") {
				if (cursor[q] !== hit.index) {
					cursor[q] = hit.index;
					refresh();
				}
				return { handled: true };
			}
			if (typing) {
				typing = false;
				editor.setText("");
			}
			choose(q, hit.index);
			return { handled: true };
		}

		function render(width: number): string[] {
			if (cache) return cache;
			const w = Math.max(10, width);
			const lines: string[] = [];
			const lineHits: (LineHit | undefined)[] = [];
			const push = (line: string, hit?: LineHit) => {
				lines.push(line);
				lineHits[lines.length - 1] = hit;
			};
			/** Wrapped lines; highlighted ones get the selection background across the full width. */
			const wrap = (text: string, indent = "", hit?: LineHit, highlight = false) =>
				wrapTextWithAnsi(text, Math.max(1, w - indent.length)).forEach((line) => {
					const full = indent + line;
					push(highlight ? theme.bg("selectedBg", full + " ".repeat(Math.max(0, w - visibleWidth(full)))) : full, hit);
				});

			push(theme.fg("accent", "─".repeat(w)));
			if (tabbed) {
				// The open tab has the selection background, the one under the pointer a lighter one.
				const chip = (i: number, label: string, color: "success" | "muted" | "dim") =>
					i === tab
						? theme.bg("selectedBg", theme.fg("text", label))
						: i === hoverTab
							? theme.bg("userMessageBg", theme.fg("text", label))
							: theme.fg(color, label);
				const chips = questions.map((q, i) => chip(i, ` ${answers.has(i) ? "■" : "□"} ${q.header} `, answers.has(i) ? "success" : "muted"));
				chips.push(chip(submitTab, " ✓ Submit ", allAnswered() ? "success" : "dim"));
				// Laid out chip by chip, so a click finds its tab: a chip that does not fit starts the next line.
				let line = " ";
				let spans: { from: number; to: number; tab: number }[] = [];
				chips.forEach((chip, i) => {
					const chipWidth = visibleWidth(chip);
					if (spans.length > 0 && visibleWidth(line) + 1 + chipWidth > w) {
						push(truncateToWidth(line, w), { kind: "tabs", spans });
						line = " ";
						spans = [];
					}
					if (spans.length > 0) line += " ";
					const from = visibleWidth(line);
					line += chip;
					spans.push({ from, to: from + chipWidth, tab: i });
				});
				push(truncateToWidth(line, w), { kind: "tabs", spans });
				push("");
			}

			if (tab === submitTab) {
				wrap(theme.fg("accent", theme.bold("Review your answers")), " ");
				push("");
				questions.forEach((q, i) => {
					const answer = answers.get(i);
					wrap(`${theme.fg("muted", `${q.header}: `)}${answer ? answerText(answer) : theme.fg("warning", "(unanswered)")}`, " ");
				});
				push("");
				if (allAnswered()) wrap(theme.fg("success", "Enter submits, or a click here"), " ", { kind: "submit" });
				else wrap(theme.fg("warning", "Answer every question to submit"), " ");
			} else {
				const q = questions[tab];
				if (!tabbed) wrap(theme.fg("muted", q.header), " ");
				wrap(theme.bold(q.question), " ");
				push("");
				const custom = answers.get(tab)?.custom;
				[...q.options, { label: OTHER, description: custom ? `"${custom}"` : "Type your own answer" }].forEach((option, i) => {
					const focused = i === cursor[tab];
					const isOther = i === q.options.length;
					const mark = q.multiSelect ? (isOther ? (custom ? "[x] " : "[ ] ") : toggled[tab].has(i) ? "[x] " : "[ ] ") : "";
					const chosen = !q.multiSelect && answers.get(tab)?.labels[0] === option.label;
					const label = `${focused ? theme.fg("accent", "> ") : "  "}${i + 1}. ${mark}${option.label}${chosen ? " ✓" : ""}`;
					wrap(focused ? theme.fg("accent", label) : label, " ", { kind: "option", index: i }, focused);
					if (option.description) wrap(theme.fg("muted", option.description), "       ", { kind: "option", index: i }, focused);
				});
				// The preview area is as tall as the question's longest preview, whichever option is highlighted: a dialog
				// that changed height under a hovering pointer would move the options away from it and back.
				const previewLines = (option: QuestionOption | undefined) => option?.preview?.split("\n").slice(0, 20) ?? [];
				const previewHeight = Math.max(0, ...q.options.map((option) => previewLines(option).length));
				if (previewHeight > 0 && !typing) {
					push("");
					const preview = previewLines(q.options[cursor[tab]]);
					for (const line of preview) push(` ${theme.fg("dim", "│")} ${truncateToWidth(line, w - 4)}`);
					for (let i = preview.length; i < previewHeight; i++) push("");
				}
				if (typing) {
					push("");
					wrap(theme.fg("muted", "Your answer:"), " ");
					for (const line of editor.render(Math.max(1, w - 2))) push(` ${line}`);
				}
			}

			push("");
			const help = typing
				? "Enter submit · Esc back to the options"
				: tab === submitTab
					? "Enter submit · Tab/←→ questions · Esc dismiss"
					: questions[tab].multiSelect
						? "↑↓ move · Space toggle · Enter confirm · Tab/←→ questions · Esc dismiss"
						: `↑↓ move · Enter select${tabbed ? " · Tab/←→ questions" : ""} · Esc dismiss`;
			wrap(theme.fg("dim", help), " ");
			push(theme.fg("accent", "─".repeat(w)));
			cache = lines;
			hits = lineHits;
			return lines;
		}

		return {
			render,
			handleInput,
			handleMouse,
			invalidate: () => {
				cache = undefined;
			},
		};
	});
}

/** RPC clients: one select per question, "Other…" opens a text input. */
async function askWithDialogs(ctx: ExtensionContext, questions: Question[], signal: AbortSignal): Promise<Map<number, Answer> | undefined> {
	const answers = new Map<number, Answer>();
	for (const [i, q] of questions.entries()) {
		if (signal.aborted) return undefined;
		const labels = q.options.map((o) => `${o.label} — ${o.description}`);
		const choice = await ctx.ui.select(`${q.header}: ${q.question}${q.multiSelect ? " (one choice here)" : ""}`, [...labels, `${OTHER}…`], { signal });
		if (choice === undefined) return undefined;
		const index = labels.indexOf(choice);
		if (index >= 0) {
			answers.set(i, { labels: [q.options[index].label] });
			continue;
		}
		const text = (await ctx.ui.input(q.question, "Your answer", { signal }))?.trim();
		if (!text) return undefined;
		answers.set(i, { labels: [], custom: text });
	}
	return answers;
}

/**
 * The dialog, open to an answer from elsewhere at the same time (see the header): the first answer settles the
 * questions and closes the dialog; an aborted run withdraws them.
 */
async function ask(pi: ExtensionAPI, ctx: ExtensionContext, toolCallId: string, questions: Question[], signal: AbortSignal | undefined): Promise<Outcome> {
	const close = new AbortController();
	let settled = false;
	let resolve!: (outcome: Outcome) => void;
	let reject!: (error: unknown) => void;
	const outcome = new Promise<Outcome>((ok, fail) => {
		resolve = ok;
		reject = fail;
	});
	const settle = (result: Outcome): boolean => {
		if (settled) return false;
		settled = true;
		resolve(result);
		return true;
	};
	const withdraw = () => settle({});
	if (signal?.aborted) return {};
	signal?.addEventListener("abort", withdraw, { once: true });
	const open: QuestionsOpen = {
		toolCallId,
		questions,
		answer: (answers, annotations) => settle({ answers: fromRecord(questions, answers, annotations) }),
		decline: (message) => settle({ message: message?.trim() || undefined }),
	};
	pi.events.emit(QUESTIONS_OPEN, open);
	(ctx.mode === "tui" ? askInTerminal(ctx, questions, close.signal) : askWithDialogs(ctx, questions, close.signal)).then(
		(answers) => settle({ answers }),
		(error) => {
			if (settled) return;
			settled = true;
			reject(error);
		},
	);
	try {
		const result = await outcome;
		const answers = result.answers;
		const closed: QuestionsClose = { toolCallId, ...(answers && { answers: Object.fromEntries(questions.map((q, i) => [q.question, answerText(answers.get(i) ?? { labels: [] })])) }) };
		pi.events.emit(QUESTIONS_CLOSE, closed);
		return result;
	} catch (error) {
		pi.events.emit(QUESTIONS_CLOSE, { toolCallId } satisfies QuestionsClose);
		throw error;
	} finally {
		close.abort();
		signal?.removeEventListener("abort", withdraw);
	}
}

export default function (pi: ExtensionAPI) {
	if (Number(process.env.PI_SUBAGENT_DEPTH || 0) > 0) return;

	pi.registerTool<typeof Params, Details>({
		name: "AskUserQuestion",
		label: "Ask user",
		description: DESCRIPTION,
		promptSnippet: "AskUserQuestion: ask the user 1-4 multiple-choice questions and wait for the answers",
		parameters: Params,
		exposure: "model-only",
		executionMode: "sequential",

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const questions = params.questions as Question[];
			const preset = params.answers && Object.keys(params.answers).length > 0 ? params.answers : undefined;
			let answers: Map<number, Answer> | undefined;
			let message: string | undefined;
			if (preset) {
				answers = new Map(questions.map((q, i) => [i, { labels: [], custom: preset[q.question] ?? "" }]));
			} else if (ctx.hasUI) {
				({ answers, message } = await ask(pi, ctx, toolCallId, questions, signal));
			} else {
				throw new Error(
					"No user can answer questions in this mode (non-interactive run). Decide on your own judgment, state the assumption you made, and continue.",
				);
			}
			if (!answers && message) {
				throw new Error(`The user declined the questions and wrote instead: "${message}". Follow that as written; do not assume an answer.`);
			}
			if (!answers) {
				throw new Error(
					"The user dismissed the questions without answering. Do not assume an answer: ask in plain text or wait for the user's instructions.",
				);
			}
			const details: Details = { questions, answers: {}, custom: [], cancelled: false };
			questions.forEach((q, i) => {
				const answer = answers.get(i) ?? { labels: [] };
				details.answers[q.question] = answerText(answer);
				if (answer.custom && !preset) details.custom.push(q.question);
			});
			return { content: [{ type: "text", text: resultText(details) }], details };
		},

		renderCall(args, theme) {
			const qs = (args.questions ?? []) as Question[];
			const headers = qs.map((q) => q.header).filter(Boolean).join(", ");
			return new Text(
				theme.fg("toolTitle", theme.bold("AskUserQuestion ")) +
					theme.fg("muted", `${qs.length} question${qs.length === 1 ? "" : "s"}`) +
					(headers ? theme.fg("dim", ` (${headers})`) : ""),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details;
			if (!details?.questions) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			const lines = details.questions.map((q) => {
				const custom = details.custom.includes(q.question) ? theme.fg("muted", " (own words)") : "";
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", q.header)}: ${details.answers[q.question] ?? ""}${custom}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
