// Per-child profiles: parsing `profiles` and `agents`, choosing a session's
// profile from its agent name, and applying it to the normal rules. Pure; the
// config loader calls it.

import { validLevels } from "./levels.ts";
import type { Levels } from "./project-config.ts";
import { mergeProtect, validProtect } from "./protect.ts";
import { type CustomRule, validRules } from "./rules/custom.ts";
import type { Protect } from "./rules/filesystem.ts";

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

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

function validMode(value: unknown, problems: string[]): StartMode | undefined {
	if (value === "off" || value === "auto") return value;
	problems.push(
		value === "yolo"
			? 'mode: "yolo" is not allowed: YOLO mode starts only with pi --yolo or /yolo'
			: 'mode must be "off" or "auto"',
	);
	return undefined;
}

function parseProfile(value: unknown, problems: string[]): Profile {
	if (!isObject(value)) {
		problems.push("is not an object");
		return { levels: {}, rules: [] };
	}
	const profile: { -readonly [K in keyof Profile]: Profile[K] } = {
		levels: {},
		rules: [],
	};
	for (const [key, part] of Object.entries(value)) {
		if (key === "levels") profile.levels = validLevels(part, problems);
		else if (key === "rules") profile.rules = validRules(part, problems);
		else if (key === "protect") profile.protect = validProtect(part, problems);
		else if (key === "mode") {
			const mode = validMode(part, problems);
			if (mode) profile.mode = mode;
		} else problems.push(`unknown key "${key}"`);
	}
	return profile;
}

// Each profile has its own problem list, copied to the file's with a
// `profiles.<name>` prefix; any problem makes the profile broken.
export function validProfiles(value: unknown, problems: string[]): Profiles {
	if (!isObject(value)) {
		problems.push('"profiles" is not an object');
		return {};
	}
	const parsed: [string, ParsedProfile][] = [];
	for (const [name, definition] of Object.entries(value)) {
		const own: string[] = [];
		if (!NAME.test(name)) {
			own.push("the name must be lowercase letters, digits and dashes");
		}
		const profile = parseProfile(definition, own);
		const at = `profiles.${name}`;
		const prefixed = own.map((problem) => {
			const keyed = /^(mode|levels|rules)[.[:\s]/.test(problem);
			return `${at}${keyed ? "." : ": "}${problem}`;
		});
		problems.push(...prefixed);
		parsed.push([
			name,
			own.length > 0
				? { kind: "broken", problems: prefixed }
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
			readonly agent: string;
			readonly from: string;
			readonly name: string;
	  }
	| {
			readonly state: "unmapped";
			readonly agent: string;
			readonly from: string;
	  }
	| {
			readonly state: "broken";
			readonly agent: string;
			readonly from: string;
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

export { chooseProfile, profiledAgents } from "./profile-resolve.ts";
