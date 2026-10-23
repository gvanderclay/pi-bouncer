// No project file loosens the always-deny set; an untrusted project's file only
// makes a rule stricter.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { alwaysDenySet, builtInEntries } from "./rules/built-in-policy.ts";
import {
	type DirectionLevels,
	directionLevels,
	entryLevel,
	namedLevels,
	type PathEntry,
	type PathLevel,
} from "./rules/rule.ts";
import type { ConfigLevel, RuleName } from "./verdict.ts";

export type ConfigFile = {
	readonly path: string;
	readonly loaded: boolean;
	readonly problems: readonly string[];
};

/** The directions a config may set for a path group; a missing one keeps its default. */
export type PathLevels = {
	readonly read?: PathLevel;
	readonly write?: PathLevel;
};

export type Levels = Readonly<
	Partial<Record<RuleName, ConfigLevel | PathLevels>>
>;

// Below `.pi/extensions`, so Pi asks the user to trust the project.
export function projectConfigFile(cwd: string): string {
	return join(cwd, ".pi", "extensions", "bouncer", "config.json");
}

export function oldProjectFile(cwd: string): ConfigFile[] {
	const path = join(cwd, ".pi", "bouncer.json");
	if (!existsSync(path)) return [];
	const problem = `no longer read; move it to ${projectConfigFile(cwd)}`;
	return [{ path, loaded: false, problems: [problem] }];
}

const DIRECTIONS = ["read", "write"] as const;

// A direction's order, allow the loosest: an untrusted project may only raise.
const RANK: Readonly<Record<PathLevel, number>> = {
	allow: 0,
	off: 1,
	ask: 2,
	deny: 3,
};

function refusal(
	rule: RuleName,
	level: ConfigLevel,
	routeLevel: ConfigLevel | undefined,
	trusted: boolean,
): string | undefined {
	if (level === "deny") return undefined;
	if (alwaysDenySet.has(rule)) {
		return `levels: "${rule}" is in the always-deny set; a project config cannot loosen it`;
	}
	if (!trusted && routeLevel && RANK[level] < RANK[routeLevel]) {
		return `levels: "${rule}" would loosen the rule, and the project is not trusted`;
	}
	return undefined;
}

// A project group's level, direction by direction: the always-deny set takes
// only deny, and an untrusted project may only raise a direction. Whatever is
// refused is left out, so the group keeps the level it had.
function pathKept(
	rule: RuleName,
	given: PathLevels,
	route: DirectionLevels,
	trusted: boolean,
	refusals: string[],
): PathLevels {
	const kept: { read?: PathLevel; write?: PathLevel } = {};
	for (const direction of DIRECTIONS) {
		const level = given[direction];
		if (level === undefined) continue;
		if (alwaysDenySet.has(rule) && level !== "deny") {
			refusals.push(
				`levels: "${rule}" is in the always-deny set; a project config cannot loosen it`,
			);
		} else if (
			!trusted &&
			(level === "allow" || RANK[level] < RANK[route[direction]])
		) {
			refusals.push(
				`levels: an untrusted project may not lower "${rule}" ${direction}`,
			);
		} else kept[direction] = level;
	}
	return kept;
}

export type ProjectFile = {
	readonly file: ConfigFile;
	readonly levels: Levels;
};

// A project's level for one path group, as kept after its refusals: a plain
// level stays plain when both directions it named are kept.
function keptPath(
	rule: RuleName,
	entry: PathEntry,
	level: ConfigLevel | PathLevels,
	routeLevels: Levels,
	trusted: boolean,
	refusals: string[],
): ConfigLevel | PathLevels | undefined {
	const accepted = pathKept(
		rule,
		namedLevels(entry.rule, level),
		directionLevels(entry, routeLevels[rule]),
		trusted,
		refusals,
	);
	const directions = DIRECTIONS.filter(
		(direction) => accepted[direction] !== undefined,
	).length;
	if (directions === 0) return undefined;
	return typeof level === "string" && directions === DIRECTIONS.length
		? level
		: accepted;
}

export function projectLevels(
	project: ProjectFile,
	routeLevels: Levels,
	trusted: boolean,
): ProjectFile {
	const kept: Partial<Record<RuleName, ConfigLevel | PathLevels>> = {};
	const refusals: string[] = [];
	for (const [rule, level] of Object.entries(project.levels) as [
		RuleName,
		ConfigLevel | PathLevels,
	][]) {
		const entry = builtInEntries.get(rule);
		if (entry?.kind === "path") {
			const at = keptPath(rule, entry, level, routeLevels, trusted, refusals);
			if (at !== undefined) kept[rule] = at;
			continue;
		}
		const given = routeLevels[rule];
		const routeLevel =
			typeof given === "string" ? given : entry && entryLevel(entry);
		const why = refusal(rule, level as ConfigLevel, routeLevel, trusted);
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

const ROUTE_ONLY: Readonly<Record<string, string>> = {
	log: '"log" is ignored in a project file: only the user config (bouncer.json in the Pi agent dir) sets log limits',
	mcp: '"mcp" is ignored in a project file: only the user config (bouncer.json in the Pi agent dir) allows MCP tools',
	auto: '"auto" is ignored in a project file: only the user config (bouncer.json in the Pi agent dir) sets auto mode',
	trashCommand:
		'"trashCommand" is ignored in a project file: only the user config (bouncer.json in the Pi agent dir) names the trash program',
	startMode:
		'"startMode" is ignored in a project file: only the user config (bouncer.json in the Pi agent dir) sets the start mode',
};

export function routeOnlyProblem(key: string): string | undefined {
	return Object.hasOwn(ROUTE_ONLY, key) ? ROUTE_ONLY[key] : undefined;
}
