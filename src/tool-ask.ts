// A tool call with no shell string to rule on (an MCP call or a file call)
// once its own allow-list check has passed: in auto mode the judge
// rules unless the call says not to be judged, otherwise a session allow or
// the dialog decides, and with no UI the call is blocked.
import {
	type Ask,
	type Asking,
	allSessionAllowed,
	askUser,
	yoloAnswers,
} from "./ask.ts";
import {
	autoDecided,
	type Call,
	type Decision,
	type Trace,
	type WithoutYolo,
} from "./gate.ts";
import type { Ranking } from "./rank.ts";
import type { Verdict } from "./verdict.ts";

export type ToolAsk = Call & {
	/** What the dialog, the log and the session-allow key name: an MCP tool name, or a file call's "<direction> <real path>". */
	readonly command: string;
	readonly asks: readonly Ask[];
	/** The block when no one can answer, and the judge's fallback. */
	readonly fallback: Verdict;
	/** Session allows for this kind of call; cleared at each session start. */
	readonly allowed: Set<string>;
	/** false: auto mode opens the dialog instead of asking the judge. */
	readonly judged: boolean;
};

export async function decideToolAsk(call: ToolAsk): Promise<Decision> {
	const { command, mode, ui, asks, fallback, allowed, judged } = call;
	if (mode === "auto" && judged) {
		const ranking: Ranking = { kind: "ask", asks, fallback, matches: [] };
		return autoDecided(ranking, ranking, command, call, allowed);
	}
	const asking: Asking = {
		command,
		cwd: call.cwd,
		allowed,
		...(call.title && { title: call.title }),
		...(call.signal && { signal: call.signal }),
		...(call.autoChoice && { autoChoice: call.autoChoice }),
	};
	let without: WithoutYolo = "blocked";
	if (ui) without = allSessionAllowed(asks, asking) ? "allowed" : "dialog";
	const trace: Trace = {
		matches: [],
		ui: ui !== undefined,
		asks: [],
		...(mode === "yolo" && { yolo: { withoutYolo: without } }),
		// Unjudged, auto mode goes to the dialog, and withoutAuto says what the
		// plain path would have done with the same asks.
		...(mode === "auto" && { withoutAuto: without }),
	};
	if (mode === "yolo") {
		return {
			kind: "allow",
			trace: { ...trace, asks: yoloAnswers(asks, asking) },
		};
	}
	if (!ui) {
		return { kind: "block", reason: fallback.reason, stop: false, trace };
	}
	const asked = await askUser(asks, ui, asking);
	return {
		...asked.outcome,
		trace: { ...trace, asks: asked.answers },
		...(asked.yoloOn && { yoloOn: true }),
		...(asked.autoOn && { autoOn: true }),
	};
}
