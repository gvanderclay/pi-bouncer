// The whole decision, free of Pi: a bash command in, an outcome out.

import { ALWAYS_ASK } from "./always-ask.ts";
import {
	type Ask,
	type AskAnswer,
	type Asked,
	type Asking,
	type AskUI,
	allSessionAllowed,
	askUser,
	quietAnswers,
	uncovered,
	yoloAnswers,
} from "./ask.ts";
import type { JevRecord } from "./jev.ts";
import type { JudgeFailure } from "./judge.ts";
import type { GateMode } from "./mode.ts";
import {
	type Match,
	type Ranking,
	rank,
	rankAuto,
	rankYolo,
	read,
} from "./rank.ts";
import type { Policy, Where } from "./rules/rule.ts";
import type { Ruling } from "./ruling.ts";
import type { ParseFn } from "./scan/walk.ts";
import {
	notification,
	type Outcome,
	type RuleName,
	reasonDenied,
	type Verdict,
} from "./verdict.ts";

export type { AskAnswer, AskUI, Match, Outcome, ParseFn };

/**
 * What the effective policy alone would have done with a call YOLO mode
 * decided: a hard deny or a no-UI ask is `blocked`, an ask with a UI that
 * session allows do not all cover is `dialog`, and one they cover is
 * `allowed`.
 */
export type WithoutYolo = "blocked" | "dialog" | "allowed";

/** What auto mode's judge made of a call: the log's `auto` shape. */
export type AutoTrace = {
	/** `none`: no model on the judge list answered. */
	readonly verdict: "allow" | "deny" | "ask" | "none" | "always-ask" | "paused";
	readonly reason?: string;
	/** The `provider/id` entry that answered. */
	readonly model?: string;
	readonly ms?: number;
	/** Every model given up on before the answer, with why. */
	readonly tried: readonly JudgeFailure[];
	/** What Jev said first, when the route has `auto.jev`. */
	readonly jev?: JevRecord;
	/** Set when the bouncer mode changed while the judge was out: unused. */
	readonly discarded?: true;
};

/** Why the bouncer did what it did, for the bouncer log. */
export type Trace = {
	/**
	 * Every match, in evaluation order; a deny match ends the list (under
	 * YOLO mode, only a match in the always-deny set does). A steer match
	 * does not end it.
	 */
	readonly matches: readonly Match[];
	readonly ui: boolean;
	/** What happened to each ask, when a dialog sequence ran. */
	readonly asks: readonly AskAnswer[];
	/** Set only when YOLO mode made the decision. */
	readonly yolo?: { readonly withoutYolo: WithoutYolo };
	/** Set only when auto mode made the decision; `auto` only if a judge was asked. */
	readonly withoutAuto?: WithoutYolo;
	readonly auto?: AutoTrace;
};

/**
 * An outcome, with a trace whenever a rule matched. `yoloOn` is set when the
 * user picked "Allow all (YOLO)": the caller turns YOLO mode on.
 */
export type Decision = Outcome & {
	readonly trace?: Trace;
	readonly yoloOn?: true;
	/** Set when the user picked the auto-mode choice: the caller turns it on. */
	readonly autoOn?: true;
};

/** Rules a line's uncovered asks: the auto-mode ruling. */
export type Judge = (asks: readonly Ask[]) => Promise<Ruling>;

/** One bash call: where it runs, and who can be asked about it. */
export type Call = {
	readonly cwd: string;
	/** The home directory, for rules that resolve `~`. */
	readonly home: string;
	/** The bouncer mode this call is decided in. */
	readonly mode: GateMode;
	/** Auto mode's judge; without one, auto mode hands every ask to the user. */
	readonly judge?: Judge;
	/** The route's `auto.alwaysAsk` prefixes; used in auto mode only. */
	readonly alwaysAsk?: readonly string[];
	/** Whether auto mode's brakes paused it: its calls go to the dialog. */
	readonly paused?: boolean;
	/** The dialog's auto-mode choice label, when auto mode could turn on. */
	readonly autoChoice?: string;
	/**
	 * Asked once the judge answers: the decision under the bouncer mode now in
	 * force if it changed while the judge was out, else `undefined`.
	 */
	readonly redecide?: () => Promise<Decision> | undefined;
	readonly ui?: AskUI;
	readonly signal?: AbortSignal;
};

export type Gate = {
	decide(command: string, call: Call): Promise<Decision>;
	/** Forgets every session allow and enforces `policy` from now on. */
	reset(policy: Policy): void;
};

function blocked(verdict: Verdict): Outcome {
	return {
		kind: "block",
		reason: verdict.reason,
		warning: notification(verdict),
		stop: false,
	};
}

/** A deny ranking's block: a steer rule's carries no warning. */
function denied(ranking: Ranking & { readonly kind: "deny" }): Outcome {
	if (!ranking.steer) return blocked(ranking.verdict);
	return { kind: "block", reason: ranking.verdict.reason, stop: false };
}

function askingFor(command: string, call: Call, allowed: Set<string>): Asking {
	const { cwd, signal, autoChoice } = call;
	return {
		command,
		cwd,
		allowed,
		...(signal && { signal }),
		...(autoChoice && { autoChoice }),
	};
}

/** The switches a dialog answer asked for, to put on the decision. */
function switches(asked: Asked): Pick<Decision, "yoloOn" | "autoOn"> {
	return {
		...(asked.yoloOn && { yoloOn: asked.yoloOn }),
		...(asked.autoOn && { autoOn: asked.autoOn }),
	};
}

async function decided(
	ranking: Ranking | undefined,
	command: string,
	call: Call,
	allowed: Set<string>,
): Promise<Decision> {
	if (!ranking) return { kind: "allow" };
	const { matches } = ranking;
	const trace: Trace = { matches, ui: call.ui !== undefined, asks: [] };
	if (ranking.kind === "deny") return { ...denied(ranking), trace };
	if (!call.ui) return { ...blocked(ranking.fallback), trace };
	const asking = askingFor(command, call, allowed);
	const asked = await askUser(ranking.asks, call.ui, asking);
	return {
		...asked.outcome,
		trace: { ...trace, asks: asked.answers },
		...switches(asked),
	};
}

function withoutYolo(
	ranking: Ranking | undefined,
	call: Call,
	asking: Asking,
): WithoutYolo {
	if (!ranking) return "allowed";
	if (ranking.kind === "deny" || !call.ui) return "blocked";
	return allSessionAllowed(ranking.asks, asking) ? "allowed" : "dialog";
}

/**
 * YOLO mode's decision from its own ranking: no dialog opens, with or
 * without a UI. `ranking` is the effective policy's, for the trace.
 */
function yoloDecided(
	yoloRanking: Ranking | undefined,
	ranking: Ranking | undefined,
	command: string,
	call: Call,
	allowed: Set<string>,
): Decision {
	if (!yoloRanking) return { kind: "allow" };
	const asking = askingFor(command, call, allowed);
	const trace: Trace = {
		matches: yoloRanking.matches,
		ui: call.ui !== undefined,
		asks: [],
		yolo: { withoutYolo: withoutYolo(ranking, call, asking) },
	};
	if (yoloRanking.kind === "deny") {
		return { ...denied(yoloRanking), trace };
	}
	const asks = yoloAnswers(yoloRanking.asks, asking);
	return { kind: "allow", trace: { ...trace, asks } };
}

function autoTrace(result: Ruling): AutoTrace {
	const jev = result.jev && { jev: result.jev };
	if (result.kind === "none") {
		return { verdict: "none", tried: result.tried, ...jev };
	}
	const { verdict, reason, model, ms, tried } = result;
	return { verdict, reason, model, ms, tried, ...jev };
}

const NO_JUDGE = "Auto: no judge available";

/** The rules of `asks`, each once, in order. */
function rulesOf(asks: readonly Ask[]): RuleName[] {
	return [...new Set(asks.map((ask) => ask.rule))];
}

/**
 * Auto mode's decision from its own ranking: one judge call covers every
 * ask no session allow covers. Allow runs the line quietly, deny blocks it
 * in the hard-deny form, and a hand-off or no judge opens the dialog, or
 * blocks without a UI. `ranking` is the effective policy's, for the trace.
 */
async function autoDecided(
	autoRanking: Ranking | undefined,
	ranking: Ranking | undefined,
	command: string,
	call: Call,
	allowed: Set<string>,
): Promise<Decision> {
	if (!autoRanking) return { kind: "allow" };
	const asking = askingFor(command, call, allowed);
	const trace: Trace = {
		matches: autoRanking.matches,
		ui: call.ui !== undefined,
		asks: [],
		withoutAuto: withoutYolo(ranking, call, asking),
	};
	if (autoRanking.kind === "deny") {
		return { ...denied(autoRanking), trace };
	}
	const { asks } = autoRanking;
	const open = uncovered(asks, asking);
	if (open.length === 0) {
		const quiet = quietAnswers(asks, asking, "auto");
		return { kind: "allow", trace: { ...trace, asks: quiet } };
	}
	const skipped = call.paused
		? "paused"
		: open.some((ask) => ask.rule === ALWAYS_ASK) && "always-ask";
	if (skipped) {
		const auto: AutoTrace = { verdict: skipped, tried: [] };
		return dialogDecided(autoRanking, command, call, allowed, {
			...trace,
			auto,
		});
	}
	const result: Ruling = call.judge
		? await call.judge(open)
		: { kind: "none", tried: [] };
	const again = call.redecide?.();
	if (again) return discarded(await again, autoTrace(result), call);
	const judged: Trace = { ...trace, auto: autoTrace(result) };
	if (result.kind === "verdict" && result.verdict === "allow") {
		const quiet = quietAnswers(asks, asking, "auto");
		return { kind: "allow", trace: { ...judged, asks: quiet } };
	}
	if (result.kind === "verdict" && result.verdict === "deny") {
		const rules = rulesOf(open);
		const verdict = reasonDenied(rules, result.reason, command);
		const quiet = quietAnswers(asks, asking, "auto-deny");
		const outcome: Outcome = {
			kind: "block",
			reason: verdict.reason,
			warning: notification(verdict, rules),
			stop: false,
		};
		return { ...outcome, trace: { ...judged, asks: quiet } };
	}
	const note = result.kind === "none" ? NO_JUDGE : `Judge: ${result.reason}`;
	return dialogDecided(autoRanking, command, call, allowed, judged, note);
}

/** `decision`, keeping the judge's dropped verdict in its trace. */
function discarded(decision: Decision, auto: AutoTrace, call: Call): Decision {
	const trace = decision.trace ?? {
		matches: [],
		ui: call.ui !== undefined,
		asks: [],
	};
	return {
		...decision,
		trace: { ...trace, auto: { ...auto, discarded: true } },
	};
}

/**
 * Auto mode's dialog, or its no-UI fallback: for a hand-off, no judge, an
 * alwaysAsk hit or a pause. `note` is one line below each dialog's title.
 */
async function dialogDecided(
	ranking: Ranking & { readonly kind: "ask" },
	command: string,
	call: Call,
	allowed: Set<string>,
	trace: Trace,
	note?: string,
): Promise<Decision> {
	if (!call.ui) return { ...blocked(ranking.fallback), trace };
	const asking = askingFor(command, call, allowed);
	const noted = note === undefined ? asking : { ...asking, note };
	const asked = await askUser(ranking.asks, call.ui, noted);
	const answered: Trace = { ...trace, asks: asked.answers };
	return { ...asked.outcome, trace: answered, ...switches(asked) };
}

/**
 * An undefined parser makes every decision the `parser-unavailable` deny.
 * Each bouncer keeps its own session allows, in memory only, and enforces
 * `policy` until `reset` is given another.
 */
export function createGate(parse: ParseFn | undefined, policy: Policy): Gate {
	const allowed = new Set<string>();
	let current = policy;
	return {
		decide(command: string, call: Call): Promise<Decision> {
			const where = { cwd: call.cwd, home: call.home };
			const given = read(parse, command);
			const ranking = rank(given, current, where);
			if (call.mode === "auto") {
				const prefixes = call.alwaysAsk ?? [];
				const autoRanking = rankAuto(given, current, where, prefixes);
				return autoDecided(autoRanking, ranking, command, call, allowed);
			}
			if (call.mode !== "yolo") return decided(ranking, command, call, allowed);
			const yoloRanking = rankYolo(given, current, where);
			return Promise.resolve(
				yoloDecided(yoloRanking, ranking, command, call, allowed),
			);
		},
		reset(next: Policy): void {
			allowed.clear();
			current = next;
		},
	};
}

/** What the bouncer would do with a command, before anyone is asked. */
export type Would =
	| { readonly kind: "allow" }
	| { readonly kind: "ask" }
	| { readonly kind: "deny"; readonly rule: RuleName };

/**
 * What auto mode would do with a command, before any judge is asked: allow
 * (no match), `judge`, a dialog for an always-ask prefix, or a deny.
 */
export type AutoWould =
	| { readonly kind: "allow" }
	| { readonly kind: "judge" }
	| { readonly kind: "ask"; readonly rule: typeof ALWAYS_ASK }
	| { readonly kind: "deny"; readonly rule: RuleName };

export type Inspection = {
	readonly matches: readonly Match[];
	/** Session allows aside: a dialog, or a deny. */
	readonly withUI: Would;
	readonly withoutUI: Would;
	/** Session allows aside: YOLO mode's allow, or the rule that still denies. */
	readonly withYolo: Would;
	/** Session allows aside: auto mode's judge, dialog, or deny. */
	readonly withAuto: AutoWould;
};

/** YOLO mode never asks: its ranking allows or denies. */
function yoloWould(ranking: Ranking | undefined): Would {
	if (ranking?.kind !== "deny") return { kind: "allow" };
	return { kind: "deny", rule: ranking.verdict.rule };
}

/** Auto mode asks the judge unless an always-ask prefix sends it to the user. */
function autoWould(ranking: Ranking | undefined): AutoWould {
	if (!ranking) return { kind: "allow" };
	if (ranking.kind === "deny") {
		return { kind: "deny", rule: ranking.verdict.rule };
	}
	const always = ranking.asks.some((ask) => ask.rule === ALWAYS_ASK);
	return always ? { kind: "ask", rule: ALWAYS_ASK } : { kind: "judge" };
}

/**
 * Every match and what the bouncer would do with and without a UI, in YOLO
 * mode and in auto mode (with the route's `alwaysAsk` prefixes), from the
 * same rankings `decide` uses, for a call running `where`. Opens no dialog,
 * calls no judge and remembers nothing.
 */
export function inspect(
	parse: ParseFn | undefined,
	command: string,
	policy: Policy,
	where: Where,
	alwaysAsk: readonly string[] = [],
): Inspection {
	const given = read(parse, command);
	const ranking = rank(given, policy, where);
	const modes = {
		withYolo: yoloWould(rankYolo(given, policy, where)),
		withAuto: autoWould(rankAuto(given, policy, where, alwaysAsk)),
	};
	if (!ranking) {
		const allow: Would = { kind: "allow" };
		return { matches: [], withUI: allow, withoutUI: allow, ...modes };
	}
	const { matches } = ranking;
	if (ranking.kind === "deny") {
		const deny: Would = { kind: "deny", rule: ranking.verdict.rule };
		return { matches, withUI: deny, withoutUI: deny, ...modes };
	}
	const withoutUI: Would = { kind: "deny", rule: ranking.fallback.rule };
	return { matches, withUI: { kind: "ask" }, withoutUI, ...modes };
}
