import type { AgentMade } from "../agent-made.ts";
import type { RmChecks } from "../agent-made-check.ts";
import type { PathLevels } from "../project-config.ts";
import type { Invocation } from "../scan/walk.ts";
import type { ConfigLevel, RuleName, VerdictLevel } from "../verdict.ts";
import type { PathPattern } from "./path-patterns.ts";

export type Where = {
	readonly cwd: string;
	readonly home: string;
	/** Directories the agent made this session; absent when that is not trusted. */
	readonly agentMade?: AgentMade;
	/** Recursive-`rm` eligibility already checked for this decision, keyed by invocation. */
	readonly agentMadeChecks?: RmChecks;
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

/** The bouncer's own config and code: checked before the walk, writes only. */
export const BOUNCER = "path-bouncer";

export type PathLevel = "allow" | "ask" | "deny" | "off";

export type DirectionLevels = {
	readonly read: PathLevel;
	readonly write: PathLevel;
};

// A path rule only recognises paths of file tool calls, never a bash invocation.
export type PathRule = {
	readonly name: RuleName;
	readonly summary: string;
	readonly patterns: readonly PathPattern[];
	/** Paths the rule leaves out, such as .env.example. */
	readonly except?: readonly PathPattern[];
};

export type PathEntry = {
	readonly kind: "path";
	readonly rule: PathRule;
	readonly levels: DirectionLevels;
	/** Set on a custom path steer rule. */
	readonly instead?: string;
};

// The directions a config level names: a plain level names both, except
// path-bouncer's, which sets its write level only.
export function namedLevels(
	rule: PathRule,
	level: ConfigLevel | PathLevels,
): PathLevels {
	if (typeof level !== "string") return level;
	return rule.name === BOUNCER
		? { write: level }
		: { read: level, write: level };
}

// A path entry's levels with the config's directions applied; a direction the
// config leaves out keeps the group's default.
export function directionLevels(
	entry: PathEntry,
	level: ConfigLevel | PathLevels | undefined,
): DirectionLevels {
	if (level === undefined) return entry.levels;
	const named = namedLevels(entry.rule, level);
	return {
		read: named.read ?? entry.levels.read,
		write: named.write ?? entry.levels.write,
	};
}

export type PolicyEntry = UnreadableDeny | RuleEntry | SteerEntry | PathEntry;

// In evaluation order.
export type Policy = readonly PolicyEntry[];

export function policyEntryName(entry: PolicyEntry): RuleName {
	return entry.kind === "unreadable" ? entry.name : entry.rule.name;
}

const STRICTNESS: Readonly<Record<PathLevel, number>> = {
	off: 0,
	allow: 0,
	ask: 1,
	deny: 2,
};

// One level for an entry, as `/bouncer` and the session record list them: a
// path entry shows its stricter direction.
// shortcut: a path entry allowed in both directions shows as "off". Upgrade
// when `/bouncer` and the session record show both directions.
export function entryLevel(entry: PolicyEntry): ConfigLevel {
	if (entry.kind !== "path") return entry.level;
	const { read, write } = entry.levels;
	const level = STRICTNESS[read] >= STRICTNESS[write] ? read : write;
	return level === "allow" ? "off" : level;
}
