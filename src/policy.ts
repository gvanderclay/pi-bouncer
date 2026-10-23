// The policy a session runs: the built-ins at their configured levels, then
// custom rules. A rule set to "off" leaves it.
import type { Levels } from "./project-config.ts";
import { builtInPolicy } from "./rules/built-in-policy.ts";
import { type CustomRule, customEntry, customRule } from "./rules/custom.ts";
import {
	type Protect,
	rmRootProtecting,
	trashRootFor,
} from "./rules/filesystem.ts";
import {
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

// A plain level sets both directions.
function pathEntryAt(
	entry: PathEntry,
	level: "ask" | "deny" | undefined,
): PathEntry {
	return level ? { ...entry, levels: { read: level, write: level } } : entry;
}

// A rule set to "off" leaves the policy. Custom rules follow the built-ins,
// and custom steer rules come last.
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
			const level = levels[entry.rule.name];
			if (level === "off") off.push(entry.rule);
			else policy.push(pathEntryAt(entry, level));
			continue;
		}
		const level =
			entry.kind === "unreadable"
				? entry.level
				: (levels[entry.rule.name] ?? entry.level);
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
		if (!entry) off.push(customRule(rule));
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
