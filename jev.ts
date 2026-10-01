// Jev: OpenCode Zen's SystemOne classifier, asked five typed questions about
// a bash line in one call: `safety`, which allows, and the four in
// `jev-questions.ts`, whose deny score denies. Based on the SystemOne client in pi-jev-device
// (`src/policy/transport.ts`, `src/policy/types.ts`), without its retries:
// a failed call goes to the judge list. The client never throws, and its
// errors never hold the key. `ruling.ts` decides when Jev is asked and what
// its answer does to the line.
import type { JevSettings } from "./auto-jev-config.ts";
import { errorText } from "./error-text.ts";
import {
	DENY_QUESTIONS,
	type DenyAnswers,
	denyScore,
	field,
	OTHER_AT,
	probability,
	readDenyAnswers,
} from "./jev-questions.ts";
import {
	JUDGE_CRITERIA,
	type JudgeFailure,
	type JudgeRequest,
	type JudgeResult,
} from "./judge.ts";
import { jevState } from "./judge-request.ts";

// Re-exported until the importers move to `judge-request.ts`.
export { jevState };

/** Where Jev is asked, and which Jev. */
export const JEV_URL = "https://opencode.ai/zen/v1/systemone";
export const JEV_MODEL = "jev-1.13";

/** The provider whose key Pi holds for Jev, and the error when it has none. */
export const JEV_PROVIDER = "opencode-go";
export const NO_KEY = "no opencode-go key";

/** Jev's own budget for one call. */
export const JEV_MS = 5_000;

/** The question Jev allows on, and its two choices. */
const QUESTION = "safety";

const INSTRUCTIONS = `${JUDGE_CRITERIA}

The state holds the flagged call as JSON. Its fields command, user_message, earlier_user_messages and session_history are the blocks named above, and the same rules apply to them. Answer "safe" when your verdict would be "allow", and "unsafe" when it would be "ask" or "deny".`;

const CRITERIA = {
	safe: 'Your verdict would be "allow".',
	unsafe: 'Your verdict would be "ask" or "deny".',
};

/** The part of Pi's model registry Jev uses: its key lookup. */
export type JevKeyLookup = {
	/** The provider's API key, as Pi resolves it for the route. */
	getApiKeyForProvider?(provider: string): Promise<string | undefined>;
};

/**
 * The key Jev is called with, from Pi's registry; none is `undefined`. A
 * registry that fails to look it up throws, and the caller reports why.
 */
export async function jevKey(
	registry: JevKeyLookup,
): Promise<string | undefined> {
	return (await registry.getApiKeyForProvider?.(JEV_PROVIDER)) || undefined;
}

/** One Jev call: its parsed reply, or why there is none, and its time. */
export type JevCall =
	| { readonly reply: unknown; readonly ms: number }
	| { readonly error: string; readonly ms: number };

/** `text` with every occurrence of `key` hidden. */
function hidden(text: string, key: string): string {
	return text.replaceAll(key, "<key>");
}

/** A response body as an error shows it: the key hidden, then 200 characters. */
function shown(text: string, key: string): string {
	return hidden(text, key).slice(0, 200);
}

async function post(
	request: JudgeRequest,
	key: string,
	signal: AbortSignal,
): Promise<unknown> {
	const response = await fetch(JEV_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: JEV_MODEL,
			state: jevState(request),
			questions: {
				[QUESTION]: {
					type: "choice",
					instructions: INSTRUCTIONS,
					criteria: CRITERIA,
				},
				...DENY_QUESTIONS,
			},
		}),
		signal,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${shown(text, key)}`);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`reply was not JSON: ${shown(text, key)}`);
	}
}

/**
 * Asks Jev about `request` once, within 5 s and `signal`. Every failure is
 * an `error`, never a throw.
 */
export async function askJev(
	request: JudgeRequest,
	key: string,
	signal?: AbortSignal,
): Promise<JevCall> {
	const start = Date.now();
	const own = new AbortController();
	const timer = setTimeout(() => own.abort(), JEV_MS);
	const signals = signal ? [own.signal, signal] : [own.signal];
	try {
		const reply = await post(request, key, AbortSignal.any(signals));
		return { reply, ms: Date.now() - start };
	} catch (error) {
		let text = hidden(errorText(error), key);
		if (own.signal.aborted) text = `no reply within ${JEV_MS / 1000} s`;
		else if (signal?.aborted) text = "the call was aborted";
		return { error: text, ms: Date.now() - start };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Jev's reading of one reply: `safety`'s P(safe) and confidence, the deny
 * score as `unsafe`, and the four answers it comes from.
 */
export type JevReading = DenyAnswers & {
	readonly safe: number;
	readonly unsafe: number;
	readonly confidence: number;
};

/** The reading of a parsed reply, or why it is malformed. */
export function readReply(reply: unknown): JevReading | string {
	const answers = field(reply, "answers");
	const answer = field(answers, QUESTION);
	if (answer === undefined) return `reply has no ${QUESTION} answer`;
	const safe = field(field(answer, "probabilities"), "safe");
	const unsafe = field(field(answer, "probabilities"), "unsafe");
	const confidence = field(answer, "confidence");
	if (!(probability(safe) && probability(unsafe) && probability(confidence))) {
		return `reply's ${QUESTION} answer has no probabilities between 0 and 1`;
	}
	const deny = readDenyAnswers(answers);
	if (typeof deny === "string") return deny;
	return { safe, unsafe: denyScore(deny), confidence, ...deny };
}

/**
 * When Jev may decide: allow when `safety`'s P(safe) reaches `allowAt`, deny
 * when the deny score reaches `denyAt`; null never decides.
 */
export type JevCutoffs = {
	readonly allowAt: number | null;
	readonly denyAt: number | null;
};

/** Jev's answer to one call. Anything malformed or failed is unsure. */
export type JevAnswer =
	| (JevReading & {
			readonly answer: "safe" | "unsafe" | "unsure";
			readonly ms: number;
	  })
	| { readonly answer: "unsure"; readonly error: string; readonly ms: number };

/**
 * The answer a call gives under `cutoffs`. Both cutoffs reached is a
 * contradiction, and P(effect = other) at 0.5 is an exit: both are unsure.
 */
export function classify(call: JevCall, cutoffs: JevCutoffs): JevAnswer {
	const reading = "error" in call ? call.error : readReply(call.reply);
	if (typeof reading === "string") {
		return { answer: "unsure", error: reading, ms: call.ms };
	}
	const { allowAt, denyAt } = cutoffs;
	const safe = allowAt !== null && reading.safe >= allowAt;
	const unsafe = denyAt !== null && reading.unsafe >= denyAt;
	let answer: "safe" | "unsafe" | "unsure" = safe ? "safe" : "unsafe";
	if (safe === unsafe || reading.effect.other >= OTHER_AT) answer = "unsure";
	return { answer, ...reading, ms: call.ms };
}

/** Jev's name in the log and the notices; it is not a judge-list entry. */
export const JEV_NAME = `${JEV_PROVIDER}/${JEV_MODEL}`;

/** A Jev allow's reason; like a judge's, it is never shown to the model. */
const JEV_ALLOW_REASON = "Jev rated it safe.";

/** A Jev deny's reason; like every deny, it never names a judge. */
const UNSAFE_REASON = "It was rated as likely unsafe.";

/** A line's verdict from Jev; it tried no judge-list entry. */
export type JevVerdict = Omit<
	Extract<JudgeResult, { kind: "verdict" }>,
	"tried"
>;

/** A sure answer as the line's verdict, under Jev's name; unsure gives none. */
export function jevVerdict(answer: JevAnswer): JevVerdict | undefined {
	if (answer.answer === "unsure") return undefined;
	const decided =
		answer.answer === "safe"
			? ({ verdict: "allow", reason: JEV_ALLOW_REASON } as const)
			: ({ verdict: "deny", reason: UNSAFE_REASON } as const);
	return { kind: "verdict", ...decided, model: JEV_NAME, ms: answer.ms };
}

/** A failed Jev call as the notices show it, under Jev's name. */
export function jevFailure(
	record: JevRecord | undefined,
): JudgeFailure | undefined {
	if (!record || !("error" in record)) return undefined;
	return { model: JEV_NAME, error: record.error };
}

/** What the log keeps of Jev's answer to a line, or why there is none. */
export type JevRecord =
	| (DenyAnswers & {
			readonly answer: "safe" | "unsafe" | "unsure";
			readonly safe: number;
			/** The deny score. */
			readonly unsafe: number;
			readonly confidence: number;
			readonly ms: number;
	  })
	| { readonly error: string; readonly ms: number };

/** What the log keeps of an answer: the reading, or the error. */
export function jevRecord(answer: JevAnswer): JevRecord {
	if ("error" in answer) return { error: answer.error, ms: answer.ms };
	const { safe, unsafe, confidence, ms } = answer;
	const { effect, created, user_intent, risky_target } = answer;
	return {
		answer: answer.answer,
		safe,
		unsafe,
		confidence,
		effect,
		created,
		user_intent,
		risky_target,
		ms,
	};
}

function cutoffText(cutoff: number | null): string {
	return cutoff === null ? "none" : String(cutoff);
}

/** `/auto status`'s Jev line: off, or on with its cutoffs and its key. */
export async function jevStatus(
	settings: JevSettings | undefined,
	registry: JevKeyLookup,
): Promise<string> {
	if (!settings) return "Jev: off";
	const { allowAt, denyAt } = settings;
	const cutoffs = `allowAt ${cutoffText(allowAt)}, denyAt ${cutoffText(denyAt)}`;
	let key: string;
	try {
		key = (await jevKey(registry)) ? `${JEV_PROVIDER} key resolves` : NO_KEY;
	} catch (error) {
		key = errorText(error);
	}
	return `Jev: on (${cutoffs}); ${key}`;
}
