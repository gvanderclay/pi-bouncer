import { clip, type Outcome, type RuleName, userDenied } from "./verdict.ts";

type DialogOptions = { signal?: AbortSignal };

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

async function typedReason(
	ui: AskUI,
	opts: DialogOptions,
): Promise<string | undefined> {
	const text = await ui.input(REASON_PROMPT, "", opts);
	return text?.trim() || undefined;
}

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

export type Asking = {
	readonly command: string;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly allowed: Set<string>;
	readonly note?: string;
	readonly autoChoice?: string;
};

// A JSON array keeps the four parts apart whatever characters they contain.
function sessionKey(asking: Asking, ask: Ask): string {
	return JSON.stringify([asking.command, asking.cwd, ask.rule, ask.source]);
}

function isSessionAllowed(asking: Asking, ask: Ask): boolean {
	return asking.allowed.has(sessionKey(asking, ask));
}

export function allSessionAllowed(
	asks: readonly Ask[],
	asking: Asking,
): boolean {
	return asks.every((ask) => isSessionAllowed(asking, ask));
}

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

export function yoloAnswers(
	asks: readonly Ask[],
	asking: Asking,
): readonly AskAnswer[] {
	return quietAnswers(asks, asking, "yolo");
}

export function uncovered(asks: readonly Ask[], asking: Asking): Ask[] {
	return asks.filter((ask) => !isSessionAllowed(asking, ask));
}

export type Asked = {
	readonly outcome: Outcome;
	/** In order, ending at the first deny: later asks were never asked. */
	readonly answers: readonly AskAnswer[];
	readonly yoloOn?: true;
	readonly autoOn?: true;
};

// "i of N" counts only asks not already allowed. The first deny, including
// Escape, ends the loop.
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
