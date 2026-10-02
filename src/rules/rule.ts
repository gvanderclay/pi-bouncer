import type { Invocation } from "../scan/walk.ts";
import type { RuleName, VerdictLevel } from "../verdict.ts";

export type Where = {
	readonly cwd: string;
	readonly home: string;
};

// A rule only recognises an invocation; a `Policy` sets its level.
export type Rule = {
	readonly name: RuleName;
	readonly summary: string;
	readonly matches: (invocation: Invocation, where: Where) => boolean;
};

type UnreadableDeny = {
	readonly kind: "unreadable";
	readonly name: "parser-unavailable" | "unparseable" | "inline-too-deep";
	readonly level: "deny";
};

export type RuleEntry = {
	readonly kind: "rule";
	readonly rule: Rule;
	readonly level: VerdictLevel;
};

// A steer rule blocks in every bouncer mode, with no dialog, judge or warning.
export type SteerEntry = {
	readonly kind: "steer";
	readonly rule: Rule;
	readonly instead: string;
	readonly level: "deny";
};

export type PolicyEntry = UnreadableDeny | RuleEntry | SteerEntry;

// In evaluation order.
export type Policy = readonly PolicyEntry[];

export function policyEntryName(entry: PolicyEntry): RuleName {
	return entry.kind === "unreadable" ? entry.name : entry.rule.name;
}
