// Per-child profiles: parsing `profiles` and `agents`, choosing a session's
// profile from its agent name, and applying it to the normal rules. Pure; the
// config loader calls it.

import type { AgentSource } from "./agent-env.ts";
import { isObject } from "./json.ts";
import { validLevels } from "./levels.ts";
import type { Levels } from "./project-config.ts";
import { mergeProtect, validProtect } from "./protect.ts";
import { type CustomRule, validRules } from "./rules/custom.ts";
import type { Protect } from "./rules/filesystem.ts";

/** The mode a session starts in; `config.ts` re-exports it. */
export type StartMode = "off" | "auto";

export type Profile = {
	readonly levels: Levels;
	readonly rules: readonly CustomRule[];
	readonly protect?: Protect;
	readonly mode?: StartMode;
};

export type ParsedProfile =
	| { readonly kind: "ok"; readonly profile: Profile }
	| { readonly kind: "broken"; readonly problems: readonly string[] };

export type Profiles = Readonly<Record<string, ParsedProfile>>;
export type Agents = Readonly<Record<string, string>>;

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export function validStartMode(
	value: unknown,
	label: string,
	problems: string[],
): StartMode | undefined {
	if (value === "off" || value === "auto") return value;
	problems.push(
		value === "yolo"
			? `${label}: "yolo" is not allowed: YOLO mode starts only with pi --yolo or /yolo`
			: `${label} must be "off" or "auto"`,
	);
	return undefined;
}

// Validates one key into `profile`, pushing unprefixed problems to `own`, and
// returns the separator that joins them to the profile's path.
function parseKey(
	profile: { -readonly [K in keyof Profile]: Profile[K] },
	key: string,
	part: unknown,
	own: string[],
): string {
	if (key === "levels") {
		profile.levels = validLevels(part, own);
		return isObject(part) ? "." : ": ";
	}
	if (key === "rules") {
		profile.rules = validRules(part, own);
		return Array.isArray(part) ? "." : ": ";
	}
	if (key === "protect") {
		profile.protect = validProtect(part, own);
		return ": ";
	}
	if (key === "mode") {
		const mode = validStartMode(part, "mode", own);
		if (mode) profile.mode = mode;
		return ".";
	}
	own.push(`unknown key "${key}"`);
	return ": ";
}

// Pushes each problem to `problems` already prefixed with `at` (the profile's
// path) and the key it came from. The key text is part of a validator's
// message for a bad entry (`levels: "x" ...`, `rules[0]: ...`, `mode ...`) but
// not for a wrongly shaped value (`"levels" is not an object`), so a "." joins
// the first kind and ": " the second, decided by the value's shape.
function parseProfile(value: unknown, at: string, problems: string[]): Profile {
	if (!isObject(value)) {
		problems.push(`${at}: is not an object`);
		return { levels: {}, rules: [] };
	}
	const profile: { -readonly [K in keyof Profile]: Profile[K] } = {
		levels: {},
		rules: [],
	};
	for (const [key, part] of Object.entries(value)) {
		const own: string[] = [];
		const sep = parseKey(profile, key, part, own);
		problems.push(...own.map((problem) => `${at}${sep}${problem}`));
	}
	return profile;
}

// Each profile has its own problem list, already prefixed with
// `profiles.<name>`, copied to the file's; any problem makes it broken.
export function validProfiles(value: unknown, problems: string[]): Profiles {
	if (!isObject(value)) {
		problems.push('"profiles" is not an object');
		return {};
	}
	const parsed: [string, ParsedProfile][] = [];
	for (const [name, definition] of Object.entries(value)) {
		const at = `profiles.${name}`;
		const own: string[] = [];
		if (!NAME.test(name)) {
			own.push(`${at}: the name must be lowercase letters, digits and dashes`);
		}
		const profile = parseProfile(definition, at, own);
		problems.push(...own);
		parsed.push([
			name,
			own.length > 0
				? { kind: "broken", problems: own }
				: { kind: "ok", profile },
		]);
	}
	return Object.fromEntries(parsed);
}

/** `known`: every profile name either file defines. */
export function validAgents(
	value: unknown,
	problems: string[],
	known: ReadonlySet<string>,
): Agents {
	if (!isObject(value)) {
		problems.push('"agents" is not an object');
		return {};
	}
	const agents: [string, string][] = [];
	for (const [agent, profile] of Object.entries(value)) {
		if (typeof profile !== "string") {
			problems.push(`agents.${agent}: must be a profile name (a string)`);
		} else if (!known.has(profile)) {
			problems.push(`agents.${agent}: profile "${profile}" is not defined`);
		} else agents.push([agent, profile]);
	}
	return Object.fromEntries(agents);
}

/** What one config file says about profiles. */
export type ProfileFile = {
	readonly profiles?: Profiles;
	readonly agents?: Agents;
};

/** The session's normal rules: what a profile starts from. */
export type Normal = {
	readonly levels: Levels;
	readonly rules: readonly CustomRule[];
	readonly protect?: Protect;
	readonly startMode: StartMode;
};

export type ProfileChoice =
	| {
			readonly state: "profile";
			readonly agent: AgentSource;
			readonly name: string;
	  }
	| {
			readonly state: "unmapped";
			readonly agent: AgentSource;
	  }
	| {
			readonly state: "broken";
			readonly agent: AgentSource;
			readonly name: string;
	  };

export type Chosen = {
	/** Absent when the session has no agent name. */
	readonly choice?: ProfileChoice;
	/** Absent unless the choice is a profile. */
	readonly layer?: Profile;
	/** Refusals of the project file's entries. */
	readonly problems: readonly string[];
};

/** The normal rules with the profile's layer on top (inherit). */
export function withProfile(
	normal: Normal,
	layer: Profile | undefined,
): Normal {
	if (!layer) return normal;
	const byName = new Map(layer.rules.map((rule) => [rule.name, rule]));
	const replaced = normal.rules.map((rule) => byName.get(rule.name) ?? rule);
	const known = new Set(normal.rules.map(({ name }) => name));
	const added = layer.rules.filter(({ name }) => !known.has(name));
	const protect = mergeProtect(normal.protect, layer.protect);
	return {
		levels: { ...normal.levels, ...layer.levels },
		rules: [...replaced, ...added],
		...(protect && { protect }),
		startMode: layer.mode ?? normal.startMode,
	};
}
