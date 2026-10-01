// The project's bouncer config: where it lives, and which of its levels apply
// over the route's. No project file loosens the always-deny set, and an
// untrusted project's file only makes a rule stricter. Free of Pi; only
// config.ts imports it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConfigFile } from "./config.ts";
import { alwaysDenySet, builtInPolicy } from "./rules/built-in-policy.ts";
import { policyEntryName } from "./rules/rule.ts";
import type { RuleName, VerdictLevel } from "./verdict.ts";

/** Level changes by rule name; a rule absent here keeps its level. */
export type Levels = Readonly<Partial<Record<RuleName, VerdictLevel>>>;

/**
 * A project's config file: `<cwd>/.pi/extensions/bouncer/config.json`, never
 * higher up. Below `.pi/extensions`, so Pi asks the user to trust the project.
 */
export function projectConfigFile(cwd: string): string {
	return join(cwd, ".pi", "extensions", "bouncer", "config.json");
}

/**
 * A file at the project config's old path, `<cwd>/.pi/bouncer.json`, as a
 * config file with one problem: it is never read. Empty when there is none.
 */
export function oldProjectFile(cwd: string): ConfigFile[] {
	const path = join(cwd, ".pi", "bouncer.json");
	if (!existsSync(path)) return [];
	const problem = `no longer read; move it to ${projectConfigFile(cwd)}`;
	return [{ path, loaded: false, problems: [problem] }];
}

const BUILT_IN_LEVELS: ReadonlyMap<string, VerdictLevel> = new Map(
	builtInPolicy.map((entry) => [policyEntryName(entry), entry.level]),
);

/**
 * Why a project may not set `rule` to `level` over `routeLevel` (the level
 * after the route's file), or `undefined` when it may.
 */
function refusal(
	rule: RuleName,
	level: VerdictLevel,
	routeLevel: VerdictLevel | undefined,
	trusted: boolean,
): string | undefined {
	if (level === "deny") return undefined;
	if (alwaysDenySet.has(rule)) {
		return `levels: "${rule}" is in the always-deny set; a project config cannot loosen it`;
	}
	if (!trusted && routeLevel === "deny") {
		return `levels: "${rule}" would loosen the rule, and the project is not trusted`;
	}
	return undefined;
}

/**
 * The project file's `levels` that apply over the route's `routeLevels` for
 * a project Pi trusts or not: each refused entry is dropped and added to
 * `problems`.
 */
export function projectLevels(
	levels: Levels,
	routeLevels: Levels,
	trusted: boolean,
	problems: string[],
): Levels {
	const kept: Partial<Record<RuleName, VerdictLevel>> = {};
	for (const [rule, level] of Object.entries(levels) as [
		RuleName,
		VerdictLevel,
	][]) {
		const routeLevel = routeLevels[rule] ?? BUILT_IN_LEVELS.get(rule);
		const why = refusal(rule, level, routeLevel, trusted);
		if (why) problems.push(why);
		else kept[rule] = level;
	}
	return kept;
}
