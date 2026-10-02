// No project file loosens the always-deny set; an untrusted project's file only
// makes a rule stricter.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { alwaysDenySet, builtInEntries } from "./rules/built-in-policy.ts";
import type { ConfigLevel, RuleName } from "./verdict.ts";

export type ConfigFile = {
	readonly path: string;
	readonly loaded: boolean;
	readonly problems: readonly string[];
};

export type Levels = Readonly<Partial<Record<RuleName, ConfigLevel>>>;

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

const RANK: Readonly<Record<ConfigLevel, number>> = { off: 0, ask: 1, deny: 2 };

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

export type ProjectFile = {
	readonly file: ConfigFile;
	readonly levels: Levels;
};

export function projectLevels(
	project: ProjectFile,
	routeLevels: Levels,
	trusted: boolean,
): ProjectFile {
	const kept: Partial<Record<RuleName, ConfigLevel>> = {};
	const refusals: string[] = [];
	for (const [rule, level] of Object.entries(project.levels) as [
		RuleName,
		ConfigLevel,
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

const ROUTE_ONLY: Readonly<Record<string, string>> = {
	log: '"log" is ignored in a project file: only the user config (bouncer.json in the Pi agent dir) sets log limits',
	auto: '"auto" is ignored in a project file: only the user config (bouncer.json in the Pi agent dir) sets auto mode',
	trashCommand:
		'"trashCommand" is ignored in a project file: only the user config (bouncer.json in the Pi agent dir) names the trash program',
	startMode:
		'"startMode" is ignored in a project file: only the user config (bouncer.json in the Pi agent dir) sets the start mode',
};

export function routeOnlyProblem(key: string): string | undefined {
	return Object.hasOwn(ROUTE_ONLY, key) ? ROUTE_ONLY[key] : undefined;
}
