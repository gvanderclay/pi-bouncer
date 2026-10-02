import { alwaysAskHits } from "./always-ask.ts";
import type { Ask } from "./ask.ts";
import { alwaysDenySet } from "./rules/built-in-policy.ts";
import type { Policy, RuleEntry, SteerEntry, Where } from "./rules/rule.ts";
import { type Invocation, type ParseFn, scan } from "./scan/walk.ts";
import {
	inlineTooDeep,
	parserUnavailable,
	type RuleName,
	ruleDenied,
	steerDenied,
	unparseable,
	type Verdict,
	type VerdictLevel,
} from "./verdict.ts";

export type Match = {
	readonly rule: RuleName;
	readonly level: VerdictLevel;
	readonly source: string;
};

export type Read =
	| { readonly kind: "unreadable"; readonly verdict: Verdict }
	| { readonly kind: "ok"; readonly invocations: readonly Invocation[] };

export type Ranking =
	| {
			readonly kind: "deny";
			readonly verdict: Verdict;
			readonly matches: readonly Match[];
			/** Set when a steer rule denied: no warning goes to the user. */
			readonly steer?: true;
	  }
	| {
			readonly kind: "ask";
			readonly asks: readonly Ask[];
			readonly fallback: Verdict;
			readonly matches: readonly Match[];
	  };

function wholeCommandDeny(verdict: Verdict): Ranking {
	const { level, rule, command: source } = verdict;
	return { kind: "deny", verdict, matches: [{ rule, level, source }] };
}

type Hit = {
	readonly entry: RuleEntry | SteerEntry;
	readonly source: string;
};

function* hits(
	invocations: readonly Invocation[],
	policy: Policy,
	where: Where,
): Generator<Hit> {
	for (const invocation of invocations) {
		for (const entry of policy) {
			if (entry.kind === "unreadable") continue;
			if (entry.rule.matches(invocation, where)) {
				yield { entry, source: invocation.source };
			}
		}
	}
}

// A match for which `denies` holds wins outright; otherwise the first steer
// match denies the line, whatever asks it holds.
function rankHits(
	found: Iterable<Hit>,
	denies: (entry: RuleEntry) => boolean,
): Ranking | undefined {
	const asks: Ask[] = [];
	const matches: Match[] = [];
	let fallback: Verdict | undefined;
	let steer: Verdict | undefined;
	for (const { entry, source } of found) {
		const { name: rule, summary } = entry.rule;
		const { level } = entry;
		if (entry.kind === "steer") {
			// Held, not returned: a real deny later on the line still wins.
			matches.push({ rule, level, source });
			steer ??= steerDenied(entry.rule, entry.instead, source);
			continue;
		}
		if (denies(entry)) {
			matches.push({ rule, level, source });
			const verdict = ruleDenied({ rule: entry.rule, level: "deny" }, source);
			return { kind: "deny", verdict, matches };
		}
		if (asks.some((ask) => ask.rule === rule && ask.source === source)) {
			continue;
		}
		asks.push({ rule, summary, source });
		matches.push({ rule, level, source });
		fallback ??= ruleDenied(entry, source);
	}
	if (steer) return { kind: "deny", verdict: steer, matches, steer: true };
	return fallback ? { kind: "ask", asks, fallback, matches } : undefined;
}

export function read(parse: ParseFn | undefined, command: string): Read {
	if (!parse)
		return { kind: "unreadable", verdict: parserUnavailable(command) };
	const result = scan(parse, command);
	if (result.kind === "unparseable") {
		const verdict = unparseable(command, result.message);
		return { kind: "unreadable", verdict };
	}
	if (result.kind === "too-deep") {
		return { kind: "unreadable", verdict: inlineTooDeep(command) };
	}
	return { kind: "ok", invocations: result.invocations };
}

export function rank(
	command: Read,
	policy: Policy,
	where: Where,
): Ranking | undefined {
	if (command.kind === "unreadable") return wholeCommandDeny(command.verdict);
	const found = hits(command.invocations, policy, where);
	return rankHits(found, (entry) => entry.level === "deny");
}

// The first match in the always-deny set wins at whatever level the policy
// puts it; every other match is an ask.
export function rankYolo(
	command: Read,
	policy: Policy,
	where: Where,
): Ranking | undefined {
	if (command.kind === "unreadable") return wholeCommandDeny(command.verdict);
	const found = hits(command.invocations, policy, where);
	return rankHits(found, (entry) => alwaysDenySet.has(entry.rule.name));
}

// An unreadable command, the first always-deny match whatever its level, and
// the first effective-level deny all deny; every other match is an ask.
export function rankAuto(
	command: Read,
	policy: Policy,
	where: Where,
	alwaysAsk: readonly string[],
): Ranking | undefined {
	if (command.kind === "unreadable") return wholeCommandDeny(command.verdict);
	const found = hits(command.invocations, policy, where);
	const ranking = rankHits(
		found,
		(entry) => entry.level === "deny" || alwaysDenySet.has(entry.rule.name),
	);
	if (ranking?.kind === "deny") return ranking;
	const extra = alwaysAskHits(command.invocations, alwaysAsk);
	const [first] = extra;
	if (!first) return ranking;
	const matches = extra.map(({ rule, source }) => ({
		rule,
		level: "ask" as const,
		source,
	}));
	const rule = { name: first.rule, summary: first.summary };
	return {
		kind: "ask",
		asks: [...(ranking?.asks ?? []), ...extra],
		fallback:
			ranking?.fallback ?? ruleDenied({ rule, level: "ask" }, first.source),
		matches: [...(ranking?.matches ?? []), ...matches],
	};
}
