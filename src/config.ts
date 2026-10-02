// Never throws: each invalid part is a problem and falls back to its built-in
// value; the valid parts still apply.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type JevSettings, jevPart } from "./auto-jev-config.ts";
import { errorText } from "./error-text.ts";
import {
	type ConfigFile,
	type Levels,
	oldProjectFile,
	projectConfigFile,
	projectLevels,
	routeOnlyProblem,
} from "./project-config.ts";
import {
	alwaysDenySet,
	builtInEntries,
	builtInPolicy,
} from "./rules/built-in-policy.ts";
import {
	type Policy,
	type PolicyEntry,
	policyEntryName,
} from "./rules/rule.ts";
import type { ConfigLevel, RuleName } from "./verdict.ts";

export type LogLimits = {
	readonly rotateAboveMiB: number;
	readonly generations: number;
	/** Absent: gzipped generations are never pruned by age. */
	readonly maxAgeDays?: number;
};

export type AutoSettings = {
	/** The judge list: `provider/id` entries, in priority order. */
	readonly models: readonly string[];
	readonly alwaysAsk: readonly string[];
	readonly environment: readonly string[];
	readonly firstByProvider: Readonly<Record<string, string>>;
	/** Absent: Jev is off and the judge list rules alone. */
	readonly jev?: JevSettings;
};

export type { ConfigFile } from "./project-config.ts";

export type StartMode = "off" | "auto";

export type GateConfig = {
	readonly policy: Policy;
	readonly projectTrusted: boolean;
	readonly log: LogLimits;
	readonly startMode: StartMode;
	/** Absent when the route sets no `auto`: auto mode cannot turn on. */
	readonly auto?: AutoSettings;
	readonly files: readonly ConfigFile[];
	readonly problems: readonly string[];
};

export const BUILT_IN_LOG_LIMITS: LogLimits = {
	rotateAboveMiB: 5,
	generations: 5,
};

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Read =
	| { readonly kind: "missing" }
	| { readonly kind: "failed"; readonly problem: string }
	| { readonly kind: "object"; readonly json: Json };

function readFile(path: string): Read {
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

function validLevels(value: unknown, problems: string[]): Levels {
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

function isModelEntry(value: unknown): value is string {
	return typeof value === "string" && /^[^/\s]+\/\S+$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function validList(
	key: keyof AutoSettings,
	value: unknown,
	valid: (entry: unknown) => entry is string,
	rule: string,
	problems: string[],
): string[] {
	if (!Array.isArray(value)) {
		problems.push(`auto.${key} must be an array of strings`);
		return [];
	}
	return value.filter((entry: unknown, index: number): entry is string => {
		if (valid(entry)) return true;
		problems.push(`auto.${key}[${index}] must be ${rule}`);
		return false;
	});
}

// Each value must be an entry of `models`, so the judge list stays the whole set of judges.
function validFirstByProvider(
	value: unknown,
	models: readonly string[],
	problems: string[],
): Record<string, string> {
	const first: Record<string, string> = {};
	if (!isObject(value)) {
		problems.push("auto.firstByProvider must be an object");
		return first;
	}
	for (const [provider, entry] of Object.entries(value)) {
		const at = `auto.firstByProvider.${provider}`;
		if (!isModelEntry(entry)) {
			problems.push(`${at} must be a provider/id string`);
		} else if (!models.includes(entry)) {
			problems.push(`${at}: ${entry} is not in auto.models`);
		} else first[provider] = entry;
	}
	return first;
}

const CHECKED_AFTER: ReadonlySet<string> = new Set(["firstByProvider", "jev"]);

function validAuto(
	value: unknown,
	problems: string[],
): AutoSettings | undefined {
	if (!isObject(value)) {
		problems.push('"auto" is not an object');
		return undefined;
	}
	const auto: Mutable<AutoSettings> = {
		models: [],
		alwaysAsk: [],
		environment: [],
		firstByProvider: {},
	};
	for (const [key, entries] of Object.entries(value)) {
		if (key === "models") {
			const rule = "a provider/id string";
			auto.models = validList(key, entries, isModelEntry, rule, problems);
			if (Array.isArray(entries) && entries.length === 0) {
				problems.push("auto.models is empty");
			}
		} else if (key === "alwaysAsk" || key === "environment") {
			const rule = "a non-empty string";
			auto[key] = validList(key, entries, isNonEmptyString, rule, problems);
		} else if (!CHECKED_AFTER.has(key)) {
			problems.push(`auto: unknown key "${key}"`);
		}
	}
	if (!Object.hasOwn(value, "models")) problems.push("auto.models is required");
	// After the loop: its values are checked against the valid `models`.
	if (Object.hasOwn(value, "firstByProvider")) {
		const { firstByProvider } = value;
		auto.firstByProvider = validFirstByProvider(
			firstByProvider,
			auto.models,
			problems,
		);
	}
	return { ...auto, ...jevPart(value, problems) };
}

export function judgeOrder(
	auto: AutoSettings | undefined,
	provider: string | undefined,
): readonly string[] {
	const models = auto?.models ?? [];
	const first =
		provider !== undefined &&
		auto &&
		Object.hasOwn(auto.firstByProvider, provider)
			? auto.firstByProvider[provider]
			: undefined;
	if (first === undefined) return models;
	return [first, ...models.filter((entry) => entry !== first)];
}

type Parsed = {
	readonly file: ConfigFile;
	readonly levels: Levels;
	readonly log?: LogLimits;
	readonly auto?: AutoSettings;
	readonly startMode?: StartMode;
};

function validStartMode(
	value: unknown,
	problems: string[],
): StartMode | undefined {
	if (value === "off" || value === "auto") return value;
	problems.push(
		value === "yolo"
			? '"startMode": "yolo" is not allowed: YOLO mode starts only with pi --yolo or /yolo'
			: '"startMode" must be "off" or "auto"',
	);
	return undefined;
}

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
	else if (key === "startMode") {
		assign(parts, "startMode", validStartMode(value, problems));
	} else if (key === "$schema") {
		// For editors only: points at schema/bouncer.schema.json.
		if (typeof value !== "string") problems.push('"$schema" must be a string');
	} else if (key === "rules") {
		problems.push('"rules" is not supported yet and is ignored');
	} else problems.push(`unknown key "${key}"`);
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

// A rule set to "off" leaves the policy.
function effectivePolicy(levels: Levels): Policy {
	return builtInPolicy.flatMap((entry): PolicyEntry[] => {
		if (entry.kind === "unreadable") return [entry];
		const level = levels[entry.rule.name] ?? entry.level;
		if (level === "off") return [];
		return entry.kind === "rule" ? [{ ...entry, level }] : [entry];
	});
}

// Every built-in entry's level under `policy`: "off" when it left the policy.
export function ruleLevels(policy: Policy): Record<RuleName, ConfigLevel> {
	const levels = {} as Record<RuleName, ConfigLevel>;
	for (const entry of builtInPolicy) levels[policyEntryName(entry)] = "off";
	for (const entry of policy) levels[policyEntryName(entry)] = entry.level;
	return levels;
}

export type Project = { readonly cwd: string; readonly trusted: boolean };

// Project levels override the route (user config) entry by entry, but never loosen
// the always-deny set, and an untrusted project only makes a rule stricter.
export function loadConfig(agentDir: string, project: Project): GateConfig {
	const routeFile = parseFile(routeConfigFile(agentDir), "route");
	const projectConfig = projectLevels(
		parseFile(projectConfigFile(project.cwd), "project"),
		routeFile.levels,
		project.trusted,
	);
	const files = [
		routeFile.file,
		projectConfig.file,
		...oldProjectFile(project.cwd),
	];
	return {
		policy: effectivePolicy({ ...routeFile.levels, ...projectConfig.levels }),
		projectTrusted: project.trusted,
		log: routeFile.log ?? BUILT_IN_LOG_LIMITS,
		startMode: routeFile.startMode ?? "off",
		...(routeFile.auto && { auto: routeFile.auto }),
		files,
		problems: files.flatMap(({ path, problems }) =>
			problems.map((problem) => `${path}: ${problem}`),
		),
	};
}

export type ConfigRecord = {
	readonly files: readonly ConfigFile[];
	readonly projectTrusted: boolean;
	readonly levels: Readonly<Record<RuleName, ConfigLevel>>;
	readonly log: LogLimits;
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
	const levels = ruleLevels(config.policy);
	const { files, log, auto, projectTrusted } = config;
	if (!auto) return { files, projectTrusted, levels, log };
	const { models, alwaysAsk, environment, firstByProvider, jev } = auto;
	const counted = {
		models,
		alwaysAsk,
		environment: environment.length,
		...(Object.keys(firstByProvider).length > 0 && { firstByProvider }),
		...(jev && { jev }),
	};
	return { files, projectTrusted, levels, log, auto: counted };
}
