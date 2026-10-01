// The bouncer config: finds, reads, validates and merges the route's and the
// project's `bouncer.json`. Free of Pi; only index.ts, explain.ts and
// mode-switch.ts (for `judgeOrder`) import it. It never throws: each invalid part is a problem and falls back
// to its built-in value, and the valid parts still apply.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { builtInPolicy } from "./rules/built-in-policy.ts";
import {
	type Policy,
	type PolicyEntry,
	policyEntryName,
} from "./rules/rule.ts";
import type { RuleName, VerdictLevel } from "./verdict.ts";

/** The bouncer log's limits; only the route file sets them. */
export type LogLimits = {
	readonly rotateAboveMiB: number;
	readonly generations: number;
	/** Absent: gzipped generations are never pruned by age. */
	readonly maxAgeDays?: number;
};

/** Auto mode's route-only settings; only the route file sets them. */
export type AutoSettings = {
	/** The judge list: `provider/id` entries, in priority order. */
	readonly models: readonly string[];
	/** Command prefixes that always open the dialog in auto mode. */
	readonly alwaysAsk: readonly string[];
	/** Prose facts about the user's environment, appended to the judge prompt. */
	readonly environment: readonly string[];
	/**
	 * By the session model's provider, the `models` entry asked first; the
	 * rest of `models` follows in order.
	 */
	readonly firstByProvider: Readonly<Record<string, string>>;
};

/** One config file the bouncer looked for. A missing file is not loaded. */
export type ConfigFile = {
	readonly path: string;
	readonly loaded: boolean;
	readonly problems: readonly string[];
};

/** The bouncer mode a process starts in without a flag; YOLO is flag-only. */
export type StartMode = "off" | "auto";

export type GateConfig = {
	/** The effective policy: the built-in policy with the config applied. */
	readonly policy: Policy;
	readonly log: LogLimits;
	/** The route's start mode; `off` when it sets none. */
	readonly startMode: StartMode;
	/** Absent when the route sets no `auto`: auto mode cannot turn on. */
	readonly auto?: AutoSettings;
	readonly files: readonly ConfigFile[];
	/** Every file's problems, each as `<path>: <problem>`. */
	readonly problems: readonly string[];
};

export const BUILT_IN_LOG_LIMITS: LogLimits = {
	rotateAboveMiB: 5,
	generations: 5,
};

/** Level changes by rule name; a rule absent here keeps its level. */
type Levels = Readonly<Partial<Record<RuleName, VerdictLevel>>>;

const POLICY_ENTRIES: ReadonlyMap<string, PolicyEntry> = new Map(
	builtInPolicy.map((entry) => [policyEntryName(entry), entry]),
);

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What one file holds: its parsed object, or why it contributes nothing. */
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

function validLevels(value: unknown, problems: string[]): Levels {
	if (!isObject(value)) {
		problems.push('"levels" is not an object');
		return {};
	}
	const levels: Partial<Record<RuleName, VerdictLevel>> = {};
	for (const [rule, level] of Object.entries(value)) {
		const entry = POLICY_ENTRIES.get(rule);
		// Unreadable-command denies and steer rules have a fixed level.
		if (entry?.kind === "unreadable" || entry?.kind === "steer") {
			problems.push(`levels: "${rule}" is always deny`);
		} else if (!entry) {
			problems.push(`levels: unknown rule "${rule}"`);
		} else if (level !== "ask" && level !== "deny") {
			problems.push(`levels: "${rule}" must be "ask" or "deny"`);
		} else {
			levels[rule as RuleName] = level;
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

/** A `provider/id` entry: both parts non-empty. */
function isModelEntry(value: unknown): value is string {
	return typeof value === "string" && /^[^/\s]+\/\S+$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/** The entries of `auto.<key>` that pass `valid`; each other one is a problem. */
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

/**
 * `auto.firstByProvider`: each value must be a `provider/id` entry of
 * `models`, so the judge list stays the whole set of judges.
 */
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

function validAuto(
	value: unknown,
	problems: string[],
): AutoSettings | undefined {
	if (!isObject(value)) {
		problems.push('"auto" is not an object');
		return undefined;
	}
	const auto = {
		models: [] as string[],
		alwaysAsk: [] as string[],
		environment: [] as string[],
		firstByProvider: {} as Record<string, string>,
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
		} else if (key !== "firstByProvider") {
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
	return auto;
}

/**
 * The judge list in the order a session on `provider` asks it: the
 * provider's `firstByProvider` entry, then the rest of `models` in order.
 */
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

/** One file's contribution: the parts it set validly, and its problems. */
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

/** What a project file may not set, and why each is ignored there. */
const ROUTE_ONLY: Readonly<Record<string, string>> = {
	log: '"log" is ignored in a project file: only the route sets log limits',
	auto: '"auto" is ignored in a project file: only the route sets auto mode',
	startMode:
		'"startMode" is ignored in a project file: only the route sets the start mode',
};

function routeOnlyProblem(key: string): string | undefined {
	return Object.hasOwn(ROUTE_ONLY, key) ? ROUTE_ONLY[key] : undefined;
}

/** The parts one parsed object sets validly; `problems` collects the rest. */
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

/** Sets `parts` from one key when its value is valid; `problems` gets the rest. */
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

/** The route's config file: `<agent dir>/bouncer.json`. */
export function routeConfigFile(agentDir: string): string {
	return join(agentDir, "bouncer.json");
}

/** A project's config file: `<cwd>/.pi/bouncer.json`, never higher up. */
export function projectConfigFile(cwd: string): string {
	return join(cwd, ".pi", "bouncer.json");
}

/**
 * The built-in policy with `levels` applied; unreadable denies and steer
 * rules stay deny.
 */
function effectivePolicy(levels: Levels): Policy {
	return builtInPolicy.map((entry) =>
		entry.kind === "rule"
			? { ...entry, level: levels[entry.rule.name] ?? entry.level }
			: entry,
	);
}

/**
 * Loads the bouncer config of the route in `agentDir` for a session in `cwd`:
 * the project file's levels override the route file's entry by entry, and
 * the result is the effective policy. A missing file is the built-in policy.
 */
export function loadConfig(agentDir: string, cwd: string): GateConfig {
	const routeFile = parseFile(routeConfigFile(agentDir), "route");
	const projectFile = parseFile(projectConfigFile(cwd), "project");
	const files = [routeFile.file, projectFile.file];
	return {
		policy: effectivePolicy({ ...routeFile.levels, ...projectFile.levels }),
		log: routeFile.log ?? BUILT_IN_LOG_LIMITS,
		startMode: routeFile.startMode ?? "off",
		...(routeFile.auto && { auto: routeFile.auto }),
		files,
		problems: files.flatMap(({ path, problems }) =>
			problems.map((problem) => `${path}: ${problem}`),
		),
	};
}

/** What a session ran under: the shape of the session record's `config`. */
export type ConfigRecord = {
	readonly files: readonly ConfigFile[];
	/** Every rule's effective level, unreadable-command denies first. */
	readonly levels: Readonly<Record<RuleName, VerdictLevel>>;
	readonly log: LogLimits;
	/** The route's auto settings, with only a count of environment facts. */
	readonly auto?: {
		readonly models: readonly string[];
		readonly alwaysAsk: readonly string[];
		readonly environment: number;
		/** Only when set. */
		readonly firstByProvider?: Readonly<Record<string, string>>;
	};
};

export function configRecord(config: GateConfig): ConfigRecord {
	const levels = {} as Record<RuleName, VerdictLevel>;
	for (const entry of config.policy) {
		levels[policyEntryName(entry)] = entry.level;
	}
	const { files, log, auto } = config;
	if (!auto) return { files, levels, log };
	const { models, alwaysAsk, environment, firstByProvider } = auto;
	const counted = {
		models,
		alwaysAsk,
		environment: environment.length,
		...(Object.keys(firstByProvider).length > 0 && { firstByProvider }),
	};
	return { files, levels, log, auto: counted };
}
