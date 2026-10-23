// No project file loosens the always-deny set; an untrusted project's file only
// makes a rule stricter.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { alwaysDenySet, builtInEntries } from "./rules/built-in-policy.ts";
import {
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

// A direction's order, allow the loosest: an untrusted project may only
// raise. `off` sits between `allow` and `ask` here, unlike the policy's own
// strictness order where it ties with `allow`: turning off a group that asked
// or denied loosens it, while turning off one that allowed changes nothing.
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

// A project's path group level, judged by the whole entry it puts in place:
// the entry replaces the one the session had, so a direction the project omits
// falls back to the group's built-in level, and that must not be a loosening
// either. A refused entry is dropped whole, so the group keeps the level it had.
function pathAccepted(
	rule: RuleName,
	entry: PathEntry,
	level: ConfigLevel | PathLevels,
	routeLevels: Levels,
	trusted: boolean,
	refusals: string[],
): boolean {
	const before = directionLevels(entry, routeLevels[rule]);
	const after = directionLevels(entry, level);
	// path-bouncer guards writes: a project may raise its write level to deny,
	// but never set anything else.
	if (alwaysDenySet.has(rule) && after.write !== "deny") {
		refusals.push(
			`levels: "${rule}" is in the always-deny set; a project config cannot loosen it`,
		);
		return false;
	}
	if (trusted) return true;
	const named = namedLevels(entry.rule, level);
	const lowered = DIRECTIONS.filter(
		(direction) =>
			named[direction] === "allow" ||
			RANK[after[direction]] < RANK[before[direction]],
	);
	refusals.push(
		...lowered.map(
			(direction) =>
				`levels: an untrusted project may not lower "${rule}" ${direction}`,
		),
	);
	return lowered.length === 0;
}

export type ProjectFile = {
	readonly file: ConfigFile;
	readonly levels: Levels;
};

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
			if (pathAccepted(rule, entry, level, routeLevels, trusted, refusals)) {
				kept[rule] = level;
			}
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
