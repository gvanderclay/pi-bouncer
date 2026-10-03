// User-config only, like all of `auto` (`ROUTE_ONLY` in project-config.ts).

import { isObject } from "./json.ts";

/** Which number Jev allows from: 1 − the deny score, or the `safety` question. */
export type AllowFrom = "deny-score" | "safety";

export type JevSettings = {
	/** Jev allows at or above this allow score. */
	readonly allowAt: number | null;
	readonly allowFrom: AllowFrom;
	/** Jev denies at or above this deny score. */
	readonly denyAt: number | null;
	/** A Pi classifier model, `provider/id`; absent is OpenCode Zen with the opencode-go key. */
	readonly model?: string;
};

// Chosen from the Jev bench (`docs/design-notes.md`, "Jev cutoffs"). `allowAt` 0.90
// from the deny score: no wrong allow on the bench or a fresh held-out set, and it
// clears the bench's closest case (0.84). `denyAt` null: 0.65 wrongly denied two
// held-out allow cases. `"allowFrom": "safety"` was the default at `allowAt` 0.75.
const JEV_ALLOW_AT: number | null = 0.9;
const JEV_ALLOW_FROM: AllowFrom = "deny-score";
const JEV_DENY_AT: number | null = null;

const CUTOFF_RULE = "a number above 0.5 and at most 1";
const RULES: Readonly<Record<"allowAt" | "denyAt", string>> = {
	allowAt: CUTOFF_RULE,
	denyAt: `null or ${CUTOFF_RULE}`,
};

function isCutoff(value: unknown): value is number {
	return typeof value === "number" && value > 0.5 && value <= 1;
}

function isModel(value: unknown): value is string {
	return typeof value === "string" && /^[^/\s]+\/\S+$/.test(value);
}

type MutableJev = { -readonly [Key in keyof JevSettings]: JevSettings[Key] };

function readModelAndAllowFrom(
	jev: MutableJev,
	model: unknown,
	allowFrom: unknown,
	problems: string[],
): void {
	if (isModel(model)) jev.model = model;
	else if (model !== undefined) {
		problems.push('auto.jev.model must be "provider/id"');
	}
	if (allowFrom === "deny-score" || allowFrom === "safety") {
		jev.allowFrom = allowFrom;
	} else if (allowFrom !== undefined) {
		problems.push('auto.jev.allowFrom must be "deny-score" or "safety"');
	}
}

function validJev(value: unknown, problems: string[]): JevSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		problems.push("auto.jev must be an object");
		return undefined;
	}
	const jev: MutableJev = {
		allowAt: JEV_ALLOW_AT,
		allowFrom: JEV_ALLOW_FROM,
		denyAt: JEV_DENY_AT,
	};
	const before = problems.length;
	const { model, allowFrom, ...cutoffs } = value as Record<string, unknown>;
	readModelAndAllowFrom(jev, model, allowFrom, problems);
	for (const [key, cutoff] of Object.entries(cutoffs)) {
		if (key !== "allowAt" && key !== "denyAt") {
			problems.push(`auto.jev: unknown key "${key}"`);
		} else if (isCutoff(cutoff) || (key === "denyAt" && cutoff === null)) {
			jev[key] = cutoff;
		} else problems.push(`auto.jev.${key} must be ${RULES[key]}`);
	}
	return problems.length === before ? jev : undefined;
}

export function jevPart(
	auto: Readonly<Record<string, unknown>>,
	problems: string[],
): { jev?: JevSettings } {
	if (!Object.hasOwn(auto, "jev")) return {};
	const jev = validJev(auto["jev"], problems);
	return jev ? { jev } : {};
}

export type AutoSettings = {
	/** The judge list: `provider/id` entries, in priority order. */
	readonly models: readonly string[];
	readonly alwaysAsk: readonly string[];
	readonly environment: readonly string[];
	readonly firstByProvider: Readonly<Record<string, string>>;
	/** Absent: Jev is off and the judge list rules alone. */
	readonly jev?: JevSettings;
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

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

export function validAuto(
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
