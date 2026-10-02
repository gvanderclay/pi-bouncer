// Never throws: each invalid part is a problem and falls back to its built-in
// value; the valid parts still apply.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSource } from "./agent-env.ts";
import {
	type AutoSettings,
	type JevSettings,
	validAuto,
} from "./auto-config.ts";
import { errorText } from "./error-text.ts";
import { isObject, type Json } from "./json.ts";
import { validLevels } from "./levels.ts";
import { effectivePolicy, ruleLevels } from "./policy.ts";
import { chooseProfile, profiledAgents } from "./profile-resolve.ts";
import {
	type Agents,
	type Normal,
	type ProfileChoice,
	type Profiles,
	type StartMode,
	validAgents,
	validProfiles,
	validStartMode,
	withProfile,
} from "./profiles.ts";
import {
	type ConfigFile,
	type Levels,
	oldProjectFile,
	projectConfigFile,
	projectLevels,
	routeOnlyProblem,
} from "./project-config.ts";
import { mergeProtect, validProtect } from "./protect.ts";
import { type CustomRule, projectRules, validRules } from "./rules/custom.ts";
import type { Protect } from "./rules/filesystem.ts";
import type { Policy, Rule } from "./rules/rule.ts";
import type { ConfigLevel, RuleName } from "./verdict.ts";

export type LogLimits = {
	readonly rotateAboveMiB: number;
	readonly generations: number;
	/** Absent: gzipped generations are never pruned by age. */
	readonly maxAgeDays?: number;
};

export type { ConfigFile } from "./project-config.ts";

export type { StartMode };

export type GateConfig = {
	readonly policy: Policy;
	/** Rules a config turned off, built-in and custom; absent when none. */
	readonly off?: readonly Rule[];
	/** What both files add to rm-root's protected paths; absent when none. */
	readonly protect?: Protect;
	readonly projectTrusted: boolean;
	readonly log: LogLimits;
	/** The profile's mode when it sets one, else the user config's. */
	readonly startMode: StartMode;
	/** Absent when the session has no agent name. */
	readonly profile?: ProfileChoice;
	/** Every agent name whose profile resolves. */
	readonly profiledAgents: ReadonlySet<string>;
	/** Absent when the route sets no `auto`: auto mode cannot turn on. */
	readonly auto?: AutoSettings;
	readonly files: readonly ConfigFile[];
	readonly problems: readonly string[];
};

export const BUILT_IN_LOG_LIMITS: LogLimits = {
	rotateAboveMiB: 5,
	generations: 5,
};

type FileRead =
	| { readonly kind: "missing" }
	| { readonly kind: "failed"; readonly problem: string }
	| { readonly kind: "object"; readonly json: Json };

function readFile(path: string): FileRead {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "missing" };
		}
		return {
			kind: "failed",
			problem: `could not be read (${errorText(error)})`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { kind: "failed", problem: `not valid JSON (${errorText(error)})` };
	}
	if (!isObject(parsed)) {
		return { kind: "failed", problem: "the top level is not a JSON object" };
	}
	return { kind: "object", json: parsed };
}

type LogCheck = readonly [valid: (value: unknown) => boolean, rule: string];

const LOG_CHECKS: Readonly<Record<keyof LogLimits, LogCheck>> = {
	rotateAboveMiB: [
		(v: unknown): boolean =>
			typeof v === "number" && Number.isFinite(v) && v > 0,
		"a positive number",
	],
	generations: [
		(v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0,
		"a whole number of 0 or more",
	],
	maxAgeDays: [
		(v: unknown): boolean => Number.isInteger(v) && (v as number) > 0,
		"a positive whole number",
	],
};

function isLogKey(key: string): key is keyof LogLimits {
	return Object.hasOwn(LOG_CHECKS, key);
}

function validLog(value: unknown, problems: string[]): LogLimits {
	if (!isObject(value)) {
		problems.push('"log" is not an object');
		return BUILT_IN_LOG_LIMITS;
	}
	const limits: { -readonly [K in keyof LogLimits]: LogLimits[K] } = {
		...BUILT_IN_LOG_LIMITS,
	};
	for (const [key, limit] of Object.entries(value)) {
		if (!isLogKey(key)) {
			problems.push(`log: unknown key "${key}"`);
			continue;
		}
		const [valid, rule] = LOG_CHECKS[key];
		if (valid(limit)) limits[key] = limit as number;
		else problems.push(`log.${key} must be ${rule}`);
	}
	return limits;
}

type Parsed = {
	readonly file: ConfigFile;
	readonly levels: Levels;
	readonly log?: LogLimits;
	readonly auto?: AutoSettings;
	readonly startMode?: StartMode;
	readonly protect?: Protect;
	readonly rules?: readonly CustomRule[];
	readonly profiles?: Profiles;
	readonly agents?: Agents;
	/** `agents` as written; checked once both files' profile names are known. */
	readonly rawAgents?: unknown;
};

function parseKeys(
	json: Json,
	scope: "route" | "project",
	problems: string[],
): Omit<Parsed, "file"> {
	const parts: Mutable<Omit<Parsed, "file">> = { levels: {} };
	for (const [key, value] of Object.entries(json)) {
		const routeOnly = scope === "project" && routeOnlyProblem(key);
		if (routeOnly) problems.push(routeOnly);
		else parseKey(key, value, parts, problems);
	}
	return parts;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function parseKey(
	key: string,
	value: unknown,
	parts: Mutable<Omit<Parsed, "file">>,
	problems: string[],
): void {
	if (key === "levels") parts.levels = validLevels(value, problems);
	else if (key === "log") assign(parts, "log", validLog(value, problems));
	else if (key === "auto") assign(parts, "auto", validAuto(value, problems));
	else if (key === "protect") parts.protect = validProtect(value, problems);
	else if (key === "startMode") {
		assign(parts, "startMode", validStartMode(value, '"startMode"', problems));
	} else if (key === "profiles") {
		parts.profiles = validProfiles(value, problems);
	} else if (key === "agents") parts.rawAgents = value;
	else if (key === "$schema") {
		// For editors only: points at schema/bouncer.schema.json.
		if (typeof value !== "string") problems.push('"$schema" must be a string');
	} else if (key === "rules") parts.rules = validRules(value, problems);
	else problems.push(`unknown key "${key}"`);
}

/** Sets `parts[key]` only when `value` is defined, so an invalid part is absent. */
function assign<K extends "log" | "auto" | "startMode">(
	parts: Mutable<Omit<Parsed, "file">>,
	key: K,
	value: Parsed[K],
): void {
	if (value !== undefined) parts[key] = value;
	else delete parts[key];
}

function parseFile(path: string, scope: "route" | "project"): Parsed {
	const read = readFile(path);
	if (read.kind === "missing") {
		return { file: { path, loaded: false, problems: [] }, levels: {} };
	}
	if (read.kind === "failed") {
		const file = { path, loaded: false, problems: [read.problem] };
		return { file, levels: {} };
	}
	const problems: string[] = [];
	const parts = parseKeys(read.json, scope, problems);
	return { file: { path, loaded: true, problems }, ...parts };
}

export function routeConfigFile(agentDir: string): string {
	return join(agentDir, "bouncer.json");
}

// `agents` names profiles from either file, so it is checked after both parse.
function withAgents(parsed: Parsed, known: ReadonlySet<string>): Parsed {
	if (!Object.hasOwn(parsed, "rawAgents")) return parsed;
	const problems: string[] = [];
	const agents = validAgents(parsed.rawAgents, problems, known);
	const { file } = parsed;
	const checked = { ...file, problems: [...file.problems, ...problems] };
	return { ...parsed, agents, file: checked };
}

export type Project = { readonly cwd: string; readonly trusted: boolean };

// Project levels override the route (user config) entry by entry, but never loosen
// the always-deny set, and an untrusted project only makes a rule stricter.
export function loadConfig(
	agentDir: string,
	project: Project,
	agent?: AgentSource,
): GateConfig {
	const route0 = parseFile(routeConfigFile(agentDir), "route");
	const project0 = parseFile(projectConfigFile(project.cwd), "project");
	const known = new Set([
		...Object.keys(route0.profiles ?? {}),
		...Object.keys(project0.profiles ?? {}),
	]);
	const routeFile = withAgents(route0, known);
	const projectFile = withAgents(project0, known);
	const projectConfig = projectLevels(
		projectFile,
		routeFile.levels,
		project.trusted,
	);
	const refused: string[] = [];
	const normal = normalRules(routeFile, projectFile, projectConfig.levels, {
		trusted: project.trusted,
		refused,
	});
	const chosen = chooseProfile(
		agent,
		routeFile,
		projectFile,
		project.trusted,
		normal,
	);
	refused.push(...chosen.problems);
	const applied = withProfile(normal, chosen.layer);
	const { protect } = applied;
	const { policy, off } = effectivePolicy(
		applied.levels,
		protect,
		applied.rules,
	);
	const { file } = projectConfig;
	const files = [
		routeFile.file,
		{ ...file, problems: [...file.problems, ...refused] },
		...oldProjectFile(project.cwd),
	];
	return {
		policy,
		...(off.length > 0 && { off }),
		...(protect && { protect }),
		projectTrusted: project.trusted,
		log: routeFile.log ?? BUILT_IN_LOG_LIMITS,
		startMode: applied.startMode,
		...(chosen.choice && { profile: chosen.choice }),
		profiledAgents: profiledAgents(routeFile, projectFile, project.trusted),
		...(routeFile.auto && { auto: routeFile.auto }),
		files,
		problems: files.flatMap(({ path, problems }) =>
			problems.map((problem) => `${path}: ${problem}`),
		),
	};
}

// The rules both files give with no profile: what a profile starts from.
function normalRules(
	routeFile: Parsed,
	projectFile: Parsed,
	projectLevelsKept: Levels,
	{ trusted, refused }: { trusted: boolean; refused: string[] },
): Normal {
	const userRules = routeFile.rules ?? [];
	const custom = [
		...userRules,
		...projectRules(projectFile.rules ?? [], userRules, trusted, refused),
	];
	const protect = mergeProtect(routeFile.protect, projectFile.protect);
	return {
		levels: { ...routeFile.levels, ...projectLevelsKept },
		rules: custom,
		...(protect && { protect }),
		startMode: routeFile.startMode ?? "off",
	};
}

/** A profile choice as the log writes it: the agent flattened to strings. */
export type ProfileRecord = {
	readonly state: ProfileChoice["state"];
	readonly agent: string;
	readonly from: string;
	readonly name?: string;
};

function profileRecord(choice: ProfileChoice): ProfileRecord {
	return {
		state: choice.state,
		agent: choice.agent.name,
		from: choice.agent.variable,
		...("name" in choice && { name: choice.name }),
	};
}

export type ConfigRecord = {
	readonly files: readonly ConfigFile[];
	readonly projectTrusted: boolean;
	readonly levels: Readonly<Record<RuleName, ConfigLevel>>;
	readonly log: LogLimits;
	/** Only when the session has an agent name. */
	readonly profile?: ProfileRecord;
	/** Only when a file adds protected paths. */
	readonly protect?: Protect;
	/** The route's auto settings, with only a count of environment facts. */
	readonly auto?: {
		readonly models: readonly string[];
		readonly alwaysAsk: readonly string[];
		readonly environment: number;
		/** Only when set. */
		readonly firstByProvider?: Readonly<Record<string, string>>;
		/** Only when Jev is on. */
		readonly jev?: JevSettings;
	};
};

export function configRecord(config: GateConfig): ConfigRecord {
	const { files, log, auto, projectTrusted, protect } = config;
	const base = {
		files,
		projectTrusted,
		levels: ruleLevels(config.policy, config.off),
		log,
		...(config.profile && { profile: profileRecord(config.profile) }),
		...(protect && { protect }),
	};
	if (!auto) return base;
	const { models, alwaysAsk, environment, firstByProvider, jev } = auto;
	const counted = {
		models,
		alwaysAsk,
		environment: environment.length,
		...(Object.keys(firstByProvider).length > 0 && { firstByProvider }),
		...(jev && { jev }),
	};
	return { ...base, auto: counted };
}
