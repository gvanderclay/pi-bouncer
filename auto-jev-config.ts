// The route's `auto.jev`: whether auto mode asks Jev first, and the cutoffs
// at which Jev may decide. Route-only, as all of `auto` is
// (`ROUTE_ONLY` in project-config.ts). Free of Pi; only config.ts imports it.

/** Jev's cutoffs on a route that set `auto.jev`; `null` never decides. */
export type JevSettings = {
	/** Jev allows at or above this safe probability. */
	readonly allowAt: number | null;
	/** Jev denies at or above this deny score. */
	readonly denyAt: number | null;
};

/**
 * The cutoffs a route that sets no `allowAt` or `denyAt` gets, chosen from
 * the Jev bench run of 2026-10-01 (spec `.scratch/bouncer-jev-judge/spec.md`,
 * `## Comments`, "Default cutoffs chosen, 2026-10-01"). `allowAt` is 0.51,
 * the lowest cutoff a route may set, so a 0.50/0.50 tie never allows; the
 * bench's 0.50 and 0.51 rows are identical.
 * `denyAt` stays `null` (Jev never denies unless a route sets it) by
 * decision, deliberately not the bench's 0.96.
 */
export const JEV_ALLOW_AT: number | null = 0.51;
export const JEV_DENY_AT: number | null = null;

const CUTOFF_RULE = "a number above 0.5 and at most 1";
const RULES: Readonly<Record<keyof JevSettings, string>> = {
	allowAt: CUTOFF_RULE,
	denyAt: `null or ${CUTOFF_RULE}`,
};

function isCutoff(value: unknown): value is number {
	return typeof value === "number" && value > 0.5 && value <= 1;
}

/**
 * `auto.jev`, or `undefined` (Jev off) when any part of it is invalid; each
 * problem goes to `problems`.
 */
function validJev(value: unknown, problems: string[]): JevSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		problems.push("auto.jev must be an object");
		return undefined;
	}
	const jev = { allowAt: JEV_ALLOW_AT, denyAt: JEV_DENY_AT };
	const before = problems.length;
	for (const [key, cutoff] of Object.entries(value)) {
		if (key !== "allowAt" && key !== "denyAt") {
			problems.push(`auto.jev: unknown key "${key}"`);
		} else if (isCutoff(cutoff) || (key === "denyAt" && cutoff === null)) {
			jev[key] = cutoff;
		} else problems.push(`auto.jev.${key} must be ${RULES[key]}`);
	}
	return problems.length === before ? jev : undefined;
}

/**
 * The `jev` part of an `auto` object: its settings when it sets a valid
 * `jev`, else nothing (Jev off). Each problem goes to `problems`.
 */
export function jevPart(
	auto: Readonly<Record<string, unknown>>,
	problems: string[],
): { jev?: JevSettings } {
	if (!Object.hasOwn(auto, "jev")) return {};
	const jev = validJev(auto["jev"], problems);
	return jev ? { jev } : {};
}
