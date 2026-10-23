// The policy a session runs: the built-ins at their configured levels, then
// custom rules. A rule set to "off" leaves it.
import type { Levels, PathLevels } from "./project-config.ts";
import { builtInPolicy } from "./rules/built-in-policy.ts";
import { type CustomRule, customEntry, offRule } from "./rules/custom.ts";
import {
	type Protect,
	rmRootProtecting,
	trashRootFor,
} from "./rules/filesystem.ts";
import {
	directionLevels,
	entryLevel,
	type PathEntry,
	type PathRule,
	type Policy,
	type PolicyEntry,
	policyEntryName,
	type Rule,
} from "./rules/rule.ts";
import type { ConfigLevel, RuleName } from "./verdict.ts";

type Effective = {
	readonly policy: Policy;
	readonly off: readonly (Rule | PathRule)[];
};

const NO_PROTECT: Protect = { home: [], paths: [] };

// The built-in rules the config's `protect` and `trashCommand` widen.
function configured(
	rule: Rule,
	protect: Protect | undefined,
	trashCommand: string | undefined,
): Rule {
	if (protect && rule.name === "rm-root") return rmRootProtecting(protect);
	if ((protect || trashCommand) && rule.name === "trash-root") {
		return trashRootFor(protect ?? NO_PROTECT, trashCommand);
	}
	return rule;
}

// A path entry at its configured direction levels, or none when both are off.
function pathEntry(
	entry: PathEntry,
	level: ConfigLevel | PathLevels | undefined,
): PathEntry | undefined {
	const levels = directionLevels(entry, level);
	return levels.read === "off" && levels.write === "off"
		? undefined
		: { ...entry, levels };
}

// A rule set to "off" leaves the policy. Custom rules follow the built-ins in
// their given order, so a custom path rule can make an exception to a built-in
// group; custom bash steer rules come last.
export function effectivePolicy(
	levels: Levels,
	protect: Protect | undefined,
	custom: readonly CustomRule[],
	trashCommand?: string,
): Effective {
	const off: (Rule | PathRule)[] = [];
	const policy: PolicyEntry[] = [];
	for (const entry of builtInPolicy) {
		if (entry.kind === "path") {
			const at = pathEntry(entry, levels[entry.rule.name]);
			if (at) policy.push(at);
			else off.push(entry.rule);
			continue;
		}
		let level: ConfigLevel = entry.level;
		if (entry.kind !== "unreadable") {
			const given = levels[entry.rule.name];
			if (typeof given === "string") level = given;
		}
		if (level === "off" && entry.kind !== "unreadable") off.push(entry.rule);
		else if (entry.kind !== "rule" || level === "off") policy.push(entry);
		else {
			policy.push({
				...entry,
				rule: configured(entry.rule, protect, trashCommand),
				level,
			});
		}
	}
	const entries = custom.flatMap((rule) => {
		const entry = customEntry(rule);
		if (!entry) off.push(offRule(rule));
		return entry ? [entry] : [];
	});
	policy.push(
		...entries.filter((entry) => entry.kind !== "steer"),
		...entries.filter((entry) => entry.kind === "steer"),
	);
	return { policy, off };
}

// Every rule's level: the policy's, or "off".
export function ruleLevels(
	policy: Policy,
	off: readonly (Rule | PathRule)[] = [],
): Record<RuleName, ConfigLevel> {
	const levels: Record<RuleName, ConfigLevel> = {};
	for (const entry of policy)
		levels[policyEntryName(entry)] = entryLevel(entry);
	for (const rule of off) levels[rule.name] = "off";
	return levels;
}
