// The dialog that asks the user about an ask-level match. Only gate.ts uses it.
import { clip, type Outcome, type RuleName, userDenied } from "./verdict.ts";

type DialogOptions = { signal?: AbortSignal };

/** The dialog methods the bouncer needs; Pi's `ctx.ui` satisfies it. */
export type AskUI = {
	select(
		title: string,
		options: string[],
		opts?: DialogOptions,
	): Promise<string | undefined>;
	input(
		title: string,
		placeholder?: string,
		opts?: DialogOptions,
	): Promise<string | undefined>;
};

/** One ask-level match: the rule and the invocation it caught. */
export type Ask = {
	readonly rule: RuleName;
	readonly summary: string;
	readonly source: string;
};

const ALLOW_ONCE = "Allow once";
const ALLOW_FOR_SESSION = "Allow for this session";
const DENY_WITH_REASON = "Deny with reason";
const DENY_AND_STOP = "Deny and stop";
// `select` takes plain strings, so an emoji marks it rather than colour.
const ALLOW_ALL = "⚠️ Allow all (YOLO)";
const CHOICES: readonly string[] = [
	ALLOW_ONCE,
	ALLOW_FOR_SESSION,
	"Deny",
	DENY_WITH_REASON,
	DENY_AND_STOP,
];

/** The auto-mode choice's labels: turning auto mode on, or resuming it. */
export const AUTO_CHOICE = "🤖 Auto mode";
export const RESUME_AUTO_CHOICE = "🤖 Auto mode (resume)";

// The auto-mode choice, when offered, sits just before the YOLO choice.
function choices(autoChoice: string | undefined): string[] {
	return autoChoice
		? [...CHOICES, autoChoice, ALLOW_ALL]
		: [...CHOICES, ALLOW_ALL];
}
const REASON_PROMPT = "Reason for denying (sent to the model)";

function title(
	ask: Ask,
	index: number,
	count: number,
	note: string | undefined,
): string {
	const counter = count > 1 ? ` — ${index + 1} of ${count}` : "";
	const line = note === undefined ? "" : `\n${note}`;
	return `Bouncer: ${ask.summary} (rule: ${ask.rule})${counter}${line}\n${clip(ask.source)}`;
}

/** The typed reason, trimmed; blank or cancelled means none. */
async function typedReason(
	ui: AskUI,
	opts: DialogOptions,
): Promise<string | undefined> {
	const text = await ui.input(REASON_PROMPT, "", opts);
	return text?.trim() || undefined;
}

/** What happened to one ask: the log's `asks` shape. */
export type AskAnswer = {
	readonly rule: RuleName;
	readonly source: string;
	readonly answer:
		| "session-allowed"
		| "allow-once"
		| "allow-session"
		| "deny"
		| "deny-with-reason"
		| "deny-and-stop"
		| "escape"
		| "aborted"
		| "allow-all"
		| "yolo"
		| "auto"
		| "auto-deny"
		| "allow-auto";
	readonly userReason?: string;
};

/** One dialog's answer, and the outcome when the user denied it. */
type Answered = { readonly answer: AskAnswer; readonly denied?: Outcome };

// A dismissed select is Escape, unless the turn's signal was aborted.
function dismissal(opts: DialogOptions): AskAnswer["answer"] {
	return opts.signal?.aborted ? "aborted" : "escape";
}

async function answer(
	ask: Ask,
	choice: string | undefined,
	ui: AskUI,
	opts: DialogOptions,
): Promise<Answered> {
	const { rule, source } = ask;
	if (choice === ALLOW_ONCE)
		return { answer: { rule, source, answer: "allow-once" } };
	if (choice === ALLOW_FOR_SESSION) {
		return { answer: { rule, source, answer: "allow-session" } };
	}
	if (choice === ALLOW_ALL) {
		return { answer: { rule, source, answer: "allow-all" } };
	}
	if (choice === DENY_AND_STOP) {
		const reason = userDenied(rule, source, { stop: true });
		return {
			answer: { rule, source, answer: "deny-and-stop" },
			denied: { kind: "block", reason, stop: true },
		};
	}
	if (choice === DENY_WITH_REASON) {
		const userReason = await typedReason(ui, opts);
		const said = userReason ? { userReason } : {};
		return {
			answer: { rule, source, answer: "deny-with-reason", ...said },
			denied: {
				kind: "block",
				reason: userDenied(rule, source, said),
				stop: false,
			},
		};
	}
	const kind = choice === undefined ? dismissal(opts) : "deny";
	return {
		answer: { rule, source, answer: kind },
		denied: { kind: "block", reason: userDenied(rule, source), stop: false },
	};
}

/** The command being decided, and the session allows it is checked against. */
export type Asking = {
	readonly command: string;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	/** Keys of the asks the user allowed for this session. */
	readonly allowed: Set<string>;
	/** One line shown below each dialog's title, such as the judge's reason. */
	readonly note?: string;
	/** The auto-mode choice's label, when the dialog offers it. */
	readonly autoChoice?: string;
};

// A JSON array keeps the four parts apart whatever characters they contain.
function sessionKey(asking: Asking, ask: Ask): string {
	return JSON.stringify([asking.command, asking.cwd, ask.rule, ask.source]);
}

/** Whether a session allow covers `ask`. */
function isSessionAllowed(asking: Asking, ask: Ask): boolean {
	return asking.allowed.has(sessionKey(asking, ask));
}

/** True when a session allow covers every ask: no dialog would open. */
export function allSessionAllowed(
	asks: readonly Ask[],
	asking: Asking,
): boolean {
	return asks.every((ask) => isSessionAllowed(asking, ask));
}

/**
 * Answers with no dialog: each ask a session allow covers is
 * `session-allowed`, and every other ask is `answer`.
 */
export function quietAnswers(
	asks: readonly Ask[],
	asking: Asking,
	answer: "yolo" | "auto" | "auto-deny" | "allow-auto",
): readonly AskAnswer[] {
	return asks.map((ask) => ({
		rule: ask.rule,
		source: ask.source,
		answer: isSessionAllowed(asking, ask) ? "session-allowed" : answer,
	}));
}

/**
 * YOLO mode's answers: each ask a session allow covers is `session-allowed`,
 * as without YOLO mode, and every other ask is `yolo`. No dialog opens.
 */
export function yoloAnswers(
	asks: readonly Ask[],
	asking: Asking,
): readonly AskAnswer[] {
	return quietAnswers(asks, asking, "yolo");
}

/** The asks no session allow covers: the ones a judge or dialog decides. */
export function uncovered(asks: readonly Ask[], asking: Asking): Ask[] {
	return asks.filter((ask) => !isSessionAllowed(asking, ask));
}

/** The outcome of a dialog sequence, and what happened to each ask. */
export type Asked = {
	readonly outcome: Outcome;
	/** In order, ending at the first deny: later asks were never asked. */
	readonly answers: readonly AskAnswer[];
	/** Set when the user picked "Allow all (YOLO)": YOLO mode is to turn on. */
	readonly yoloOn?: true;
	/** Set when the user picked the auto-mode choice: auto mode is to turn on. */
	readonly autoOn?: true;
};

/**
 * Asks the user about each ask not already allowed for the session, in
 * order; "i of N" counts only those. The first deny, including Escape, ends
 * the loop and blocks; if every ask is allowed, the call runs. "Allow all
 * (YOLO)" allows the rest of the line as YOLO mode would, with no more
 * dialogs.
 */
export async function askUser(
	asks: readonly Ask[],
	ui: AskUI,
	asking: Asking,
): Promise<Asked> {
	const opts: DialogOptions = asking.signal ? { signal: asking.signal } : {};
	const isAllowed = (ask: Ask): boolean => isSessionAllowed(asking, ask);
	const count = asks.filter((ask) => !isAllowed(ask)).length;
	const answers: AskAnswer[] = [];
	let index = 0;
	for (const ask of asks) {
		if (isAllowed(ask)) {
			answers.push({
				rule: ask.rule,
				source: ask.source,
				answer: "session-allowed",
			});
			continue;
		}
		const choice = await ui.select(
			title(ask, index, count, asking.note),
			choices(asking.autoChoice),
			opts,
		);
		index += 1;
		if (asking.autoChoice && choice === asking.autoChoice) {
			const rest = quietAnswers(
				asks.slice(answers.length),
				asking,
				"allow-auto",
			);
			return {
				outcome: { kind: "allow" },
				answers: [...answers, ...rest],
				autoOn: true,
			};
		}
		const answered = await answer(ask, choice, ui, opts);
		answers.push(answered.answer);
		if (answered.denied) return { outcome: answered.denied, answers };
		if (choice === ALLOW_ALL) {
			const rest = yoloAnswers(asks.slice(answers.length), asking);
			const all = [...answers, ...rest];
			return { outcome: { kind: "allow" }, answers: all, yoloOn: true };
		}
		if (choice === ALLOW_FOR_SESSION)
			asking.allowed.add(sessionKey(asking, ask));
	}
	return { outcome: { kind: "allow" }, answers };
}
