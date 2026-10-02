// User-config only, like all of `auto` (`ROUTE_ONLY` in project-config.ts).

export type JevSettings = {
	/** Jev allows at or above this safe probability. */
	readonly allowAt: number | null;
	/** Jev denies at or above this deny score. */
	readonly denyAt: number | null;
	/** A Pi classifier model, `provider/id`; absent is OpenCode Zen with the opencode-go key. */
	readonly model?: string;
};

// Chosen from the Jev bench (`docs/design-notes.md`, "Jev cutoffs"). `allowAt` 0.75:
// 0.51 let one held-out ask case through (safe 0.62–0.68). `denyAt` null: 0.65
// wrongly denied two held-out allow cases.
export const JEV_ALLOW_AT: number | null = 0.75;
export const JEV_DENY_AT: number | null = null;

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

function validJev(value: unknown, problems: string[]): JevSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		problems.push("auto.jev must be an object");
		return undefined;
	}
	const jev: { -readonly [Key in keyof JevSettings]: JevSettings[Key] } = {
		allowAt: JEV_ALLOW_AT,
		denyAt: JEV_DENY_AT,
	};
	const before = problems.length;
	const { model, ...cutoffs } = value as Record<string, unknown>;
	if (isModel(model)) jev.model = model;
	else if (model !== undefined) {
		problems.push('auto.jev.model must be "provider/id"');
	}
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
