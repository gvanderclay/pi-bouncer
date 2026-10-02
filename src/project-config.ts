// The project's bouncer config: where it lives, which keys only the route
// sets, and which of its levels apply over the route's. No project file
// loosens the always-deny set, and an untrusted project's file only makes a
// rule stricter. Free of Pi; only config.ts imports it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { alwaysDenySet, builtInEntries } from "./rules/built-in-policy.ts";
import type { RuleName, VerdictLevel } from "./verdict.ts";

/** One config file the bouncer looked for. A missing file is not loaded. */
export type ConfigFile = {
	readonly path: string;
	readonly loaded: boolean;
	readonly problems: readonly string[];
};

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

/** A parsed project file: the file, and the levels it set validly. */
export type ProjectFile = {
	readonly file: ConfigFile;
	readonly levels: Levels;
};

/**
 * The project file with only its levels that apply over the route's
 * `routeLevels` for a project Pi trusts or not: each refused entry is
 * dropped, and why is added to the file's problems.
 */
export function projectLevels(
	project: ProjectFile,
	routeLevels: Levels,
	trusted: boolean,
): ProjectFile {
	const kept: Partial<Record<RuleName, VerdictLevel>> = {};
	const refusals: string[] = [];
	for (const [rule, level] of Object.entries(project.levels) as [
		RuleName,
		VerdictLevel,
	][]) {
		const routeLevel = routeLevels[rule] ?? builtInEntries.get(rule)?.level;
		const why = refusal(rule, level, routeLevel, trusted);
		if (why) refusals.push(why);
		else kept[rule] = level;
	}
	return {
		file: {
			...project.file,
			problems: [...project.file.problems, ...refusals],
		},
		levels: kept,
	};
}

/** What a project file may not set, and why each is ignored there. */
const ROUTE_ONLY: Readonly<Record<string, string>> = {
	log: '"log" is ignored in a project file: only the route sets log limits',
	auto: '"auto" is ignored in a project file: only the route sets auto mode',
	startMode:
		'"startMode" is ignored in a project file: only the route sets the start mode',
};

export function routeOnlyProblem(key: string): string | undefined {
	return Object.hasOwn(ROUTE_ONLY, key) ? ROUTE_ONLY[key] : undefined;
}
