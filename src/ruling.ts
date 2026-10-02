// Jev's failure stays out of the result's `tried` and joins the judge list's
// failures only for the notices.
import { type AutoSettings, judgeOrder } from "./config.ts";
import { errorText } from "./error-text.ts";
import {
	askJev,
	classify,
	type JevCall,
	type JevKeyLookup,
	type JevRecord,
	jevFailure,
	jevKey,
	jevRecord,
	jevVerdict,
	NO_KEY,
} from "./jev.ts";
import {
	type JudgeFailure,
	type JudgeRegistry,
	type JudgeResult,
	type JudgeRun,
	LINE_MS,
	runJudge,
} from "./judge.ts";
import type { JudgeRequest } from "./judge-request.ts";

export type Ruling = JudgeResult & { readonly jev?: JevRecord };

export type RulingRegistry = JudgeRegistry & JevKeyLookup;

export type RulingRun = Omit<JudgeRun, "lineMs" | "registry"> & {
	readonly registry: RulingRegistry;
};

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
 * With `auto.jev`: a safe answer at `allowAt` allows, an unsafe one at `denyAt`
 * denies, anything else goes to the judge list with what is left of the line's
 * budget (counted from before Jev's key lookup).
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
	const decided = jevVerdict(answer);
	if (decided) return { ...decided, tried: [], jev };
	const lineMs = LINE_MS - (Date.now() - start);
	return { ...(await runJudge(models, request, { ...run, lineMs })), jev };
}

export function rulingFailures(ruling: Ruling): JudgeFailure[] {
	const jev = jevFailure(ruling.jev);
	return jev ? [jev, ...ruling.tried] : [...ruling.tried];
}
