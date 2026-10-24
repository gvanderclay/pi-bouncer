import { isObject } from "./json.ts";
import type { Levels, PathLevels } from "./project-config.ts";
import { alwaysDenySet, builtInEntries } from "./rules/built-in-policy.ts";
import type { PathLevel } from "./rules/rule.ts";
import type { ConfigLevel, RuleName } from "./verdict.ts";

// Which levels a config may give a bash rule, and the problem when it gives another.
function allowedLevels(rule: string): readonly [ConfigLevel[], string] {
	const entry = builtInEntries.get(rule);
	if (!entry) return [[], `levels: unknown rule "${rule}"`];
	if (entry.kind === "unreadable")
		return [[], `levels: "${rule}" is always deny`];
	if (entry.kind === "steer") {
		return [["deny", "off"], `levels: "${rule}" must be "deny" or "off"`];
	}
	if (alwaysDenySet.has(entry.rule.name)) {
		const why = `levels: "${rule}" must be "ask" or "deny"; it is in the always-deny set, so it cannot be off`;
		return [["ask", "deny"], why];
	}
	return [
		["ask", "deny", "off"],
		`levels: "${rule}" must be "ask", "deny" or "off"`,
	];
}

const ALL = ["allow", "ask", "deny", "off"] as const;
const NOT_OFF = ["ask", "deny"] as const;

const OBJECT_OR_LEVEL = (rule: string): string =>
	`levels: "${rule}" must be "ask", "deny", "off" or an object with "read" and/or "write"`;

const ALWAYS_DENY = (rule: string): string =>
	`levels: "${rule}" must be "ask" or "deny"; it is in the always-deny set, so it cannot be off`;

function directionProblem(
	rule: string,
	direction: "read" | "write",
	bouncer: boolean,
): string {
	return bouncer && direction === "write"
		? `levels: "${rule}" write must be "ask" or "deny"; it is in the always-deny set, so it cannot be off`
		: `levels: "${rule}" ${direction} must be "allow", "ask", "deny" or "off"`;
}

// One direction's level, or the problem with it.
function validDirection(
	rule: string,
	direction: "read" | "write",
	value: unknown,
	bouncer: boolean,
	problems: string[],
): PathLevel | undefined {
	const allowed: readonly string[] = bouncer ? NOT_OFF : ALL;
	if (typeof value === "string" && allowed.includes(value)) {
		return value as PathLevel;
	}
	problems.push(directionProblem(rule, direction, bouncer));
	return undefined;
}

// A direction object's named levels; the directions it leaves out are absent.
function givenLevels(
	rule: string,
	given: readonly (readonly [string, unknown])[],
	bouncer: boolean,
	problems: string[],
): PathLevels {
	const levels: { read?: PathLevel; write?: PathLevel } = {};
	for (const [key, value] of given) {
		if (key !== "read" && key !== "write") {
			problems.push(
				`levels: "${rule}" has no direction "${key}"; use "read" or "write"`,
			);
			continue;
		}
		if (bouncer && key === "read") {
			problems.push(
				`levels: "${rule}" sets only the write level, so it has no "read"`,
			);
			continue;
		}
		const level = validDirection(rule, key, value, bouncer, problems);
		if (level !== undefined) levels[key] = level;
	}
	return levels;
}

// A path group's level: a plain level sets both directions, and an object sets
// the directions it names. The missing ones keep the group's default.
function pathValue(
	rule: string,
	value: unknown,
	bouncer: boolean,
	problems: string[],
): ConfigLevel | PathLevels | undefined {
	if (typeof value === "string") {
		const allowed: readonly string[] = bouncer ? NOT_OFF : [...NOT_OFF, "off"];
		if (allowed.includes(value)) return value as ConfigLevel;
		problems.push(bouncer ? ALWAYS_DENY(rule) : OBJECT_OR_LEVEL(rule));
		return undefined;
	}
	if (!isObject(value)) {
		problems.push(OBJECT_OR_LEVEL(rule));
		return undefined;
	}
	const given = Object.entries(value);
	if (given.length === 0) {
		problems.push(`levels: "${rule}" must set "read", "write" or both`);
		return undefined;
	}
	const levels = givenLevels(rule, given, bouncer, problems);
	return Object.keys(levels).length > 0 ? levels : undefined;
}

export function validLevels(value: unknown, problems: string[]): Levels {
	if (!isObject(value)) {
		problems.push('"levels" is not an object');
		return {};
	}
	const levels: Partial<Record<RuleName, ConfigLevel | PathLevels>> = {};
	for (const [rule, level] of Object.entries(value)) {
		const entry = builtInEntries.get(rule);
		if (entry?.kind === "path") {
			const parsed = pathValue(rule, level, alwaysDenySet.has(rule), problems);
			if (parsed !== undefined) levels[rule] = parsed;
			continue;
		}
		const [allowed, problem] = allowedLevels(rule);
		if (allowed.includes(level as ConfigLevel)) {
			levels[rule as RuleName] = level as ConfigLevel;
		} else {
			problems.push(problem);
		}
	}
	return levels;
}
