import type { Invocation } from "../scan/walk.ts";
import type { RuleName, VerdictLevel } from "../verdict.ts";

/**
 * Where a call runs: its working directory and the home directory. Rules
 * read these instead of `process.cwd()` or `os.homedir()`.
 */
export type Where = {
	readonly cwd: string;
	readonly home: string;
};

/**
 * A rule only recognises an invocation (a dangerous one, or one a steer entry
 * redirects); a `Policy` sets its level.
 */
export type Rule = {
	readonly name: RuleName;
	readonly summary: string;
	readonly matches: (invocation: Invocation, where: Where) => boolean;
};

/** A deny for a command the bouncer could not read. Its level is fixed. */
export type UnreadableDeny = {
	readonly kind: "unreadable";
	readonly name: "parser-unavailable" | "unparseable" | "inline-too-deep";
	readonly level: "deny";
};

/** A rule, at the level it is enforced at. */
export type RuleEntry = {
	readonly kind: "rule";
	readonly rule: Rule;
	readonly level: VerdictLevel;
};

/**
 * A steer rule: it blocks what its rule matches in every bouncer mode, with
 * no dialog, judge or warning, and tells the model what to run `instead`. Its
 * level is fixed.
 */
export type SteerEntry = {
	readonly kind: "steer";
	readonly rule: Rule;
	/** The sentence that tells the model what to run instead. */
	readonly instead: string;
	readonly level: "deny";
};

export type PolicyEntry = UnreadableDeny | RuleEntry | SteerEntry;

/**
 * Every rule, steer rule and unreadable-command deny, in evaluation order,
 * each at its rule level: the shape of the built-in policy and of an
 * effective policy.
 */
export type Policy = readonly PolicyEntry[];

export function policyEntryName(entry: PolicyEntry): RuleName {
	return entry.kind === "unreadable" ? entry.name : entry.rule.name;
}
