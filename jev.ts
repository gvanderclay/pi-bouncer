// Jev: OpenCode Zen's SystemOne classifier, asked one typed question about a
// bash line. Based on the SystemOne client in pi-jev-device
// (`src/policy/transport.ts`, `src/policy/types.ts`), without its retries:
// the judge list is the retry. The client never throws, and its errors never
// hold the key.
import type { JevSettings } from "./auto-jev-config.ts";
import { errorText } from "./error-text.ts";
import {
	earlierWithinBudget,
	historyWithinBudget,
	type JevRecord,
	JUDGE_CRITERIA,
	type JudgeFailure,
	type JudgeRegistry,
	type JudgeRequest,
	type JudgeResult,
	type JudgeRun,
	LINE_MS,
	runJudge,
} from "./judge.ts";

/** Where Jev is asked, and which Jev. */
export const JEV_URL = "https://opencode.ai/zen/v1/systemone";
export const JEV_MODEL = "jev-1.13";

/** The provider whose key Pi holds for Jev, and the error when it has none. */
export const JEV_PROVIDER = "opencode-go";
export const NO_KEY = "no opencode-go key";

/** Jev's own budget for one call. */
export const JEV_MS = 5_000;

/** The one question Jev answers, and its two choices. */
const QUESTION = "safety";

const INSTRUCTIONS = `${JUDGE_CRITERIA}

The state holds the flagged call as JSON. Its fields command, user_message, earlier_user_messages and session_history are the blocks named above, and the same rules apply to them. Answer "safe" when your verdict would be "allow", and "unsafe" when it would be "ask" or "deny".`;

const CRITERIA = {
	safe: 'Your verdict would be "allow".',
	unsafe: 'Your verdict would be "ask" or "deny".',
};

/**
 * What Jev is shown: the fields `judgeInput` sends, under the same history
 * and earlier-message budgets, and nothing else.
 */
export function jevState(request: JudgeRequest): Record<string, unknown> {
	const earlier = earlierWithinBudget(request.earlierUserMessages ?? []);
	const history = historyWithinBudget(request.history ?? [], request.cwd);
	const remotes = request.remotes ?? [];
	return {
		flagged: request.asks.map(({ rule, summary, source }) => ({
			rule,
			summary,
			source,
		})),
		working_directory: request.cwd,
		...(request.git && { git: request.git }),
		...(remotes.length > 0 && {
			remotes: remotes.map(({ name, url, changed }) => ({
				name,
				url,
				changed,
			})),
		}),
		...(earlier.length > 0 && { earlier_user_messages: earlier }),
		...(history.length > 0 && {
			session_history: history.map(
				({ tool, text, cwd, failed, background }) => ({
					tool,
					text,
					cwd,
					...(failed && { failed }),
					...(background && { background }),
				}),
			),
		}),
		...(request.userMessage && { user_message: request.userMessage }),
		command: request.command,
	};
}

/**
 * The key Jev is called with, from Pi's registry; none is `undefined`. A
 * registry that fails to look it up throws, and the caller reports why.
 */
export async function jevKey(
	registry: JudgeRegistry,
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

/** Jev's probabilities for one reply. */
export type JevReading = {
	readonly safe: number;
	readonly unsafe: number;
	readonly confidence: number;
};

function probability(value: unknown): value is number {
	return typeof value === "number" && value >= 0 && value <= 1;
}

function field(value: unknown, name: string): unknown {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)[name]
		: undefined;
}

/** The probabilities in a parsed reply, or why it is malformed. */
export function readReply(reply: unknown): JevReading | string {
	const answer = field(field(reply, "answers"), QUESTION);
	if (answer === undefined) return `reply has no ${QUESTION} answer`;
	const safe = field(field(answer, "probabilities"), "safe");
	const unsafe = field(field(answer, "probabilities"), "unsafe");
	const confidence = field(answer, "confidence");
	if (!(probability(safe) && probability(unsafe) && probability(confidence))) {
		return `reply's ${QUESTION} answer has no probabilities between 0 and 1`;
	}
	return { safe, unsafe, confidence };
}

/** When Jev may decide: allow at `allowAt`, deny at `denyAt`, unless null. */
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

/** The answer a call gives under `cutoffs`. */
export function classify(call: JevCall, cutoffs: JevCutoffs): JevAnswer {
	const reading = "error" in call ? call.error : readReply(call.reply);
	if (typeof reading === "string") {
		return { answer: "unsure", error: reading, ms: call.ms };
	}
	let answer: "safe" | "unsafe" | "unsure" = "unsure";
	if (cutoffs.allowAt !== null && reading.safe >= cutoffs.allowAt) {
		answer = "safe";
	} else if (cutoffs.denyAt !== null && reading.unsafe >= cutoffs.denyAt) {
		answer = "unsafe";
	}
	return { answer, ...reading, ms: call.ms };
}

/** Jev as a judge-list entry names it, in the log and the notices. */
export const JEV_ENTRY = `${JEV_PROVIDER}/${JEV_MODEL}`;

/** A Jev allow's reason; like a judge's, it is never shown to the model. */
export const JEV_ALLOW_REASON = "Jev rated it safe.";

/** What the log keeps of an answer: the reading, or the error. */
function jevRecord(answer: JevAnswer): JevRecord {
	if ("error" in answer) return { error: answer.error, ms: answer.ms };
	const { safe, confidence, ms } = answer;
	return { answer: answer.answer, safe, confidence, ms };
}

/**
 * Jev, then the judge list: a safe answer at `allowAt` allows the line, and
 * anything else, a failure included, goes to the judge list with what is
 * left of the line's budget. Until Jev may deny, an unsafe answer is unsure.
 */
export async function jevThenJudge(
	models: readonly string[],
	request: JudgeRequest,
	run: JudgeRun,
	settings: JevSettings,
): Promise<JudgeResult> {
	const start = Date.now();
	let call: JevCall;
	try {
		const key = await jevKey(run.registry);
		call = key
			? await askJev(request, key, run.signal)
			: { error: NO_KEY, ms: 0 };
	} catch (error) {
		call = { error: errorText(error), ms: Date.now() - start };
	}
	const answer = classify(call, { allowAt: settings.allowAt, denyAt: null });
	const jev = jevRecord(answer);
	if (answer.answer === "safe") {
		const reason = JEV_ALLOW_REASON;
		const allow = { kind: "verdict", verdict: "allow", reason } as const;
		return { ...allow, model: JEV_ENTRY, ms: call.ms, tried: [], jev };
	}
	const lineMs = LINE_MS - (Date.now() - start);
	return { ...(await runJudge(models, request, { ...run, lineMs })), jev };
}

/** Jev's failure as a judge-list failure, for the session's notices. */
export function jevFailures(result: JudgeResult): JudgeFailure[] {
	if (!result.jev || !("error" in result.jev)) return [];
	return [{ model: JEV_ENTRY, error: result.jev.error }];
}

function cutoffText(cutoff: number | null): string {
	return cutoff === null ? "none" : String(cutoff);
}

/** `/auto status`'s Jev line: off, or on with its cutoffs and its key. */
export async function jevStatus(
	settings: JevSettings | undefined,
	registry: JudgeRegistry,
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
