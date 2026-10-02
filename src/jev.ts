// Jev: TypeSafe's SystemOne classifier, always called through Pi's classifier registry.
// By default Zen's jev-1.13 (Pi's opencode/jev-1.13) with the opencode-go key, since Pi
// looks for that model's key under `opencode`; with `auto.jev.model`, that model and Pi's
// own credentials. Never retried: a failed call goes to the judge list. Errors never hold the key.
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
	type JudgeResult,
} from "./judge.ts";
import { type JudgeRequest, jevState } from "./judge-request.ts";

const ZEN_PROVIDER = "opencode";
export const JEV_MODEL = "jev-1.13";

export const JEV_PROVIDER = "opencode-go";
export const NO_KEY = "no opencode-go key";

export const JEV_MS = 5_000;

const QUESTION = "safety";

const INSTRUCTIONS = `${JUDGE_CRITERIA}

The state holds the flagged call as JSON. Its fields command, user_message, earlier_user_messages and session_history are the blocks named above, and the same rules apply to them. Answer "safe" when your verdict would be "allow", and "unsafe" when it would be "ask" or "deny".`;

const CRITERIA = {
	safe: 'Your verdict would be "allow".',
	unsafe: 'Your verdict would be "ask" or "deny".',
};

const QUESTIONS: Readonly<
	Record<string, { readonly type: string; readonly [field: string]: unknown }>
> = {
	[QUESTION]: {
		type: "choice",
		instructions: INSTRUCTIONS,
		criteria: CRITERIA,
	},
	...DENY_QUESTIONS,
};

// Pi's public name for SystemOne's wire-level `noul` question.
const PI_QUESTIONS = Object.fromEntries(
	Object.entries(QUESTIONS).map(([id, question]) => [
		id,
		question.type === "noul" ? { ...question, type: "bool" } : question,
	]),
);

type PiResult = {
	readonly answers: Readonly<Record<string, object>>;
	readonly stopReason: string;
	readonly errorMessage?: string;
};

export type JevKeyLookup = {
	getApiKeyForProvider?(provider: string): Promise<string | undefined>;
	getModelOfType?(type: "classifier", provider: string, id: string): unknown;
	hasConfiguredAuth?(model: never): boolean;
	classify?(
		model: never,
		context: { state: object; questions: object },
		options: { signal: AbortSignal; maxRetries: number; apiKey?: string },
	): Promise<PiResult>;
};

// A registry that fails to look up the key throws.
async function jevKey(registry: JevKeyLookup): Promise<string | undefined> {
	return (await registry.getApiKeyForProvider?.(JEV_PROVIDER)) || undefined;
}

export type JevCall =
	| { readonly reply: unknown; readonly ms: number }
	| { readonly error: string; readonly ms: number };

// Capped: a provider's error can carry a whole reply body.
function shown(text: string, key: string | undefined): string {
	return (key ? text.replaceAll(key, "<key>") : text).slice(0, 200);
}

async function timed(
	send: (signal: AbortSignal) => Promise<unknown>,
	key: string | undefined,
	signal?: AbortSignal,
): Promise<JevCall> {
	const start = Date.now();
	const own = new AbortController();
	const timer = setTimeout(() => own.abort(), JEV_MS);
	const signals = signal ? [own.signal, signal] : [own.signal];
	try {
		const reply = await send(AbortSignal.any(signals));
		return { reply, ms: Date.now() - start };
	} catch (error) {
		let text = shown(errorText(error), key);
		if (own.signal.aborted) text = `no reply within ${JEV_MS / 1000} s`;
		else if (signal?.aborted) text = "the call was aborted";
		return { error: text, ms: Date.now() - start };
	} finally {
		clearTimeout(timer);
	}
}

// Pi answers a `bool` question with `probability`; readReply reads SystemOne's `noul`.
function wireAnswers(answers: PiResult["answers"]): Record<string, object> {
	return Object.fromEntries(
		Object.entries(answers).map(([id, answer]) => [
			id,
			"probability" in answer
				? { ...answer, noul: answer.probability }
				: answer,
		]),
	);
}

export type JevAsk = (
	request: JudgeRequest,
	signal?: AbortSignal,
) => Promise<JevCall>;

type Target = {
	readonly provider: string;
	readonly id: string;
	/** Handed to Pi in place of the provider's own key. */
	readonly apiKey?: string;
};

async function target(
	registry: JevKeyLookup,
	model: string | undefined,
): Promise<Target | string> {
	if (!model) {
		const apiKey = await jevKey(registry);
		return apiKey ? { provider: ZEN_PROVIDER, id: JEV_MODEL, apiKey } : NO_KEY;
	}
	const slash = model.indexOf("/");
	return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/**
 * How to ask Jev, or why it cannot be asked. A registry that fails to look up the
 * key throws.
 */
export async function jevAsker(
	registry: JevKeyLookup,
	model?: string,
): Promise<JevAsk | string> {
	const to = await target(registry, model);
	if (typeof to === "string") return to;
	const found = registry.getModelOfType?.(
		"classifier",
		to.provider,
		to.id,
	) as never;
	const { classify } = registry;
	if (!(found && classify)) return "not a classifier model in Pi's catalogue";
	if (!(to.apiKey || registry.hasConfiguredAuth?.(found))) {
		return "no configured auth";
	}
	// Pi resolves its own key at request time; this one only keeps it out of errors.
	const key = to.apiKey ?? (await registry.getApiKeyForProvider?.(to.provider));
	const options = to.apiKey ? { apiKey: to.apiKey } : {};
	return (request: JudgeRequest, signal?: AbortSignal): Promise<JevCall> =>
		timed(
			async (both: AbortSignal): Promise<unknown> => {
				const result = await classify.call(
					registry,
					found,
					{ state: jevState(request), questions: PI_QUESTIONS },
					{ ...options, signal: both, maxRetries: 0 },
				);
				if (result.stopReason !== "stop") {
					throw new Error(result.errorMessage ?? result.stopReason);
				}
				return { answers: wireAnswers(result.answers) };
			},
			key,
			signal,
		);
}

export type JevReading = DenyAnswers & {
	readonly safe: number;
	readonly unsafe: number;
	readonly confidence: number;
};

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

// Null never decides.
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

// Both cutoffs reached is a contradiction, and P(effect = other) at 0.5 is an exit: both are unsure.
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

export const JEV_NAME = `${JEV_PROVIDER}/${JEV_MODEL}`;

/** A Jev allow's reason; like a judge's, it is never shown to the model. */
const JEV_ALLOW_REASON = "Jev rated it safe.";

/** A Jev deny's reason; like every deny, it never names a judge. */
const UNSAFE_REASON = "It was rated as likely unsafe.";

export type JevVerdict = Omit<
	Extract<JudgeResult, { kind: "verdict" }>,
	"tried"
>;

export function jevName(model: string | undefined): string {
	return model ?? JEV_NAME;
}

export function jevVerdict(
	answer: JevAnswer,
	model = JEV_NAME,
): JevVerdict | undefined {
	if (answer.answer === "unsure") return undefined;
	const decided =
		answer.answer === "safe"
			? ({ verdict: "allow", reason: JEV_ALLOW_REASON } as const)
			: ({ verdict: "deny", reason: UNSAFE_REASON } as const);
	return { kind: "verdict", ...decided, model, ms: answer.ms };
}

export function jevFailure(
	record: JevRecord | undefined,
): JudgeFailure | undefined {
	if (!record || !("error" in record)) return undefined;
	return { model: record.model ?? JEV_NAME, error: record.error };
}

// `model` only when `auto.jev.model` is set, so default records stay as they were.
export type JevRecord = { readonly model?: string } & (
	| (DenyAnswers & {
			readonly answer: "safe" | "unsafe" | "unsure";
			readonly safe: number;
			readonly unsafe: number;
			readonly confidence: number;
			readonly ms: number;
	  })
	| { readonly error: string; readonly ms: number }
);

export function jevRecord(answer: JevAnswer, model?: string): JevRecord {
	const named = model ? { model } : {};
	if ("error" in answer)
		return { ...named, error: answer.error, ms: answer.ms };
	const { safe, unsafe, confidence, ms } = answer;
	const { effect, created, user_intent, risky_target } = answer;
	return {
		...named,
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

export async function jevStatus(
	settings: JevSettings | undefined,
	registry: JevKeyLookup,
): Promise<string> {
	if (!settings) return "Jev: off";
	const { allowAt, denyAt } = settings;
	const cutoffs = `allowAt ${cutoffText(allowAt)}, denyAt ${cutoffText(denyAt)}`;
	let key: string;
	try {
		const asker = await jevAsker(registry, settings.model);
		if (!settings.model)
			key = typeof asker === "string" ? asker : `${JEV_PROVIDER} key resolves`;
		else
			key = `${settings.model}: ${typeof asker === "string" ? asker : "resolves"}`;
	} catch (error) {
		key = errorText(error);
	}
	return `Jev: on (${cutoffs}); ${key}`;
}
