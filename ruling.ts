// The auto-mode ruling: what auto mode makes of one line's uncovered asks.
// Jev first when the route sets `auto.jev`, then the judge list in judge
// order, all within the line's one 20 s budget. Free of Pi apart from the
// shape of the model registry it is handed. Jev is not a judge-list entry:
// its failure stays out of the result's `tried` and joins the judge list's
// failures only for the notices.
import { type AutoSettings, judgeOrder } from "./config.ts";
import { errorText } from "./error-text.ts";
import {
	askJev,
	classify,
	JEV_ALLOW_REASON,
	JEV_ENTRY,
	type JevCall,
	jevKey,
	jevRecord,
	NO_KEY,
} from "./jev.ts";
import type { JevRecord } from "./jev-questions.ts";
import {
	type JudgeFailure,
	type JudgeRegistry,
	type JudgeRequest,
	type JudgeResult,
	type JudgeRun,
	LINE_MS,
	runJudge,
	UNSAFE_REASON,
} from "./judge.ts";

/** What the ruling gave: the judge list's result, and Jev's when asked. */
export type Ruling = JudgeResult & { readonly jev?: JevRecord };

/** Where and on whose behalf a line is ruled; the line's budget is its own. */
export type RulingRun = Omit<JudgeRun, "lineMs" | "registry"> & {
	readonly registry: JudgeRegistry;
};

/** Jev's call for `request`, its key lookup included; it never throws. */
async function callJev(
	request: JudgeRequest,
	run: RulingRun,
	start: number,
): Promise<JevCall> {
	try {
		const key = await jevKey(run.registry);
		return key
			? await askJev(request, key, run.signal)
			: { error: NO_KEY, ms: 0 };
	} catch (error) {
		return { error: errorText(error), ms: Date.now() - start };
	}
}

/**
 * Rules one line: with `auto.jev`, a safe answer at `allowAt` allows it and
 * an unsafe one at `denyAt` denies it; anything else, a failure included,
 * goes to the judge list with what is left of the line's budget, counted
 * from before Jev's key lookup. Without `auto.jev` the judge list gets the
 * whole budget and Jev is never asked.
 */
export async function ruleLine(
	request: JudgeRequest,
	auto: AutoSettings | undefined,
	provider: string | undefined,
	run: RulingRun,
): Promise<Ruling> {
	const models = judgeOrder(auto, provider);
	if (!auto?.jev) return runJudge(models, request, run);
	const start = Date.now();
	const answer = classify(await callJev(request, run, start), auto.jev);
	const jev = jevRecord(answer);
	if (answer.answer !== "unsure") {
		const decided =
			answer.answer === "safe"
				? ({ verdict: "allow", reason: JEV_ALLOW_REASON } as const)
				: ({ verdict: "deny", reason: UNSAFE_REASON } as const);
		const result = { kind: "verdict", ...decided, model: JEV_ENTRY } as const;
		return { ...result, ms: answer.ms, tried: [], jev };
	}
	const lineMs = LINE_MS - (Date.now() - start);
	return { ...(await runJudge(models, request, { ...run, lineMs })), jev };
}

/**
 * Every failure of a ruling, for the notices: Jev's first, under its log
 * name, then the judge list's.
 */
export function rulingFailures(ruling: Ruling): JudgeFailure[] {
	const jev =
		ruling.jev && "error" in ruling.jev
			? [{ model: JEV_ENTRY, error: ruling.jev.error }]
			: [];
	return [...jev, ...ruling.tried];
}
