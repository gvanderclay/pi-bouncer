// The policy a session runs: the built-ins at their configured levels, then
// custom rules. A rule set to "off" leaves it.
import type { Levels } from "./project-config.ts";
import { builtInPolicy } from "./rules/built-in-policy.ts";
import { type CustomRule, customEntry, customRule } from "./rules/custom.ts";
import { type Protect, rmRootProtecting } from "./rules/filesystem.ts";
import {
	type Policy,
	type PolicyEntry,
	policyEntryName,
	type Rule,
} from "./rules/rule.ts";
import type { ConfigLevel, RuleName } from "./verdict.ts";

type Effective = { readonly policy: Policy; readonly off: readonly Rule[] };

// A rule set to "off" leaves the policy. Custom rules follow the built-ins,
// and custom steer rules come last.
export function effectivePolicy(
	levels: Levels,
	protect: Protect | undefined,
	custom: readonly CustomRule[],
): Effective {
	const off: Rule[] = [];
	const policy: PolicyEntry[] = [];
	for (const entry of builtInPolicy) {
		const level =
			entry.kind === "unreadable"
				? entry.level
				: (levels[entry.rule.name] ?? entry.level);
		if (level === "off" && entry.kind !== "unreadable") off.push(entry.rule);
		else if (entry.kind !== "rule" || level === "off") policy.push(entry);
		else {
			const rule =
				protect && entry.rule.name === "rm-root"
					? rmRootProtecting(protect)
					: entry.rule;
			policy.push({ ...entry, rule, level });
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
	off: readonly Rule[] = [],
): Record<RuleName, ConfigLevel> {
	const levels: Record<RuleName, ConfigLevel> = {};
	for (const entry of policy) levels[policyEntryName(entry)] = entry.level;
	for (const rule of off) levels[rule.name] = "off";
	return levels;
}
