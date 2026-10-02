import { isObject } from "./json.ts";
import type { Levels } from "./project-config.ts";
import { alwaysDenySet, builtInEntries } from "./rules/built-in-policy.ts";
import type { ConfigLevel, RuleName } from "./verdict.ts";

// Which levels a config may give a rule, and the problem when it gives another.
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

export function validLevels(value: unknown, problems: string[]): Levels {
	if (!isObject(value)) {
		problems.push('"levels" is not an object');
		return {};
	}
	const levels: Partial<Record<RuleName, ConfigLevel>> = {};
	for (const [rule, level] of Object.entries(value)) {
		const [allowed, problem] = allowedLevels(rule);
		if (allowed.includes(level as ConfigLevel)) {
			levels[rule as RuleName] = level as ConfigLevel;
		} else {
			problems.push(problem);
		}
	}
	return levels;
}
