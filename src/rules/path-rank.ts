// Ranking a file access against the policy's path entries: within one
// spelling the last match wins, so a later entry can carve an exception out of
// an earlier one; across spellings the strictest result wins. A search also
// reaches a protected path inside the folder it searches, and that scope is
// strictest-wins, so no allow unblocks it. An untrusted project's entries are
// raise-only: they stay out of last-match-wins and their strictest match
// combines strictest-wins with the rest.
import type { Direction, FileAccess } from "../file-call.ts";
import { realOf, type Spellings } from "../path-spellings.ts";
import type { Match, Ranking } from "../rank.ts";
import { pathDenied, pathSteerDenied, pathUnanswered } from "../verdict.ts";
import { alwaysDenySet } from "./built-in-policy.ts";
import { pathGroups } from "./path-groups.ts";
import type { PathPattern, PathWhere } from "./path-patterns.ts";
import { BOUNCER, type PathEntry, type PathRule, type Policy } from "./rule.ts";

export type FileMode = "normal" | "yolo" | "auto";

type Decided = {
	readonly entry: PathEntry;
	readonly level: "allow" | "ask" | "deny";
};

const STRICTNESS = { allow: 0, ask: 1, deny: 2 } as const;

type Matcher = (
	rule: PathRule,
	path: string,
	wheres: readonly PathWhere[],
) => boolean;

// A pattern written from `/` names folders as typed, and the real spelling
// of a path below a symlinked folder (macOS's /var, /tmp) starts elsewhere:
// the path is also tried with that real start spelled as the pattern's.
function rootMatch(
	pattern: PathPattern,
	path: string,
	where: PathWhere,
): boolean {
	if (pattern.test(path, where)) return true;
	if (pattern.anchor !== "root" || pattern.base === undefined) return false;
	const base = pattern.base(where);
	const real = realOf(base);
	if (real === base || !holds(real, path)) return false;
	return pattern.test(base + path.slice(real.length), where);
}

function anyMatch(
	patterns: readonly PathPattern[],
	path: string,
	wheres: readonly PathWhere[],
): boolean {
	return patterns.some((p) =>
		wheres.some((where) => rootMatch(p, path, where)),
	);
}

// The pattern matches the path itself.
function covers(
	rule: PathRule,
	path: string,
	wheres: readonly PathWhere[],
): boolean {
	return (
		anyMatch(rule.patterns, path, wheres) &&
		!anyMatch(rule.except ?? [], path, wheres)
	);
}

// Whether `parent` holds `child`, compared by whole components: a search of
// `/h/.s` is not a search of `/h/.ssh`. A search of `/` holds every absolute
// path, and is not written with a `//` prefix.
function holds(parent: string, child: string): boolean {
	if (child === parent) return true;
	if (parent === "/") return child.startsWith("/");
	return child.startsWith(`${parent}/`);
}

// The pattern is anchored, so its fixed leading folders say where it sits: a
// search of the folder above them reaches it. Patterns that match at any
// depth are left out, or every project search would fire on `.env`. A pattern
// from `/` is also placed at its real folder, as `rootMatch` does.
function scoped(
	rule: PathRule,
	path: string,
	wheres: readonly PathWhere[],
): boolean {
	return rule.patterns.some((pattern) => {
		const { base } = pattern;
		if (base === undefined) return false;
		return wheres.some((where) => {
			const at = base(where);
			if (holds(path, at)) return true;
			return pattern.anchor === "root" && holds(path, realOf(at));
		});
	});
}

function lastMatch(
	path: string,
	direction: Direction,
	policy: Policy,
	wheres: readonly PathWhere[],
	matches: Matcher,
): Decided | undefined {
	let found: Decided | undefined;
	for (const entry of policy) {
		if (entry.kind !== "path" || entry.rule.name === BOUNCER) continue;
		if (entry.raiseOnly) continue;
		const level = entry.levels[direction];
		if (level === "off" || !matches(entry.rule, path, wheres)) continue;
		found = { entry, level };
	}
	return found;
}

// The strictest raise-only entry that covers any spelling.
function raised(
	paths: Spellings,
	direction: Direction,
	policy: Policy,
	wheres: readonly PathWhere[],
): Decided | undefined {
	let worst: Decided | undefined;
	for (const entry of policy) {
		if (entry.kind !== "path" || !entry.raiseOnly) continue;
		const level = entry.levels[direction];
		if (level === "off") continue;
		if (!paths.all.some((path) => covers(entry.rule, path, wheres))) continue;
		if (!worst || STRICTNESS[level] > STRICTNESS[worst.level]) {
			worst = { entry, level };
		}
	}
	return worst;
}

// Spellings are absolute or real, so the home and working directory are
// tried both as given and resolved, or a symlinked home would miss its rules.
function wheresOf(where: PathWhere): PathWhere[] {
	const real = {
		cwd: realOf(where.cwd),
		home: realOf(where.home),
		agentDir: realOf(where.agentDir),
	};
	const same =
		real.cwd === where.cwd &&
		real.home === where.home &&
		real.agentDir === where.agentDir;
	return same ? [where] : [where, real];
}

function strictest(
	paths: Spellings,
	direction: Direction,
	policy: Policy,
	wheres: readonly PathWhere[],
	matches: Matcher,
): Decided | undefined {
	let worst: Decided | undefined;
	for (const path of paths.all) {
		const found = lastMatch(path, direction, policy, wheres, matches);
		if (found && (!worst || STRICTNESS[found.level] > STRICTNESS[worst.level]))
			worst = found;
	}
	return worst;
}

// A search's scope: every entry with an anchored pattern inside the search
// path, the strictest deciding, and the first in policy order on a tie, so
// `grep ~` names path-ssh rather than the last home folder group.
function inScope(
	paths: Spellings,
	direction: Direction,
	policy: Policy,
	wheres: readonly PathWhere[],
): Decided | undefined {
	let worst: Decided | undefined;
	for (const entry of policy) {
		if (entry.kind !== "path" || entry.rule.name === BOUNCER) continue;
		const level = entry.levels[direction];
		if (level === "off") continue;
		if (!paths.all.some((path) => scoped(entry.rule, path, wheres))) continue;
		if (!worst || STRICTNESS[level] > STRICTNESS[worst.level]) {
			worst = { entry, level };
		}
	}
	return worst;
}

function selfWrite(
	paths: Spellings,
	direction: Direction,
	policy: Policy,
	wheres: readonly PathWhere[],
): Decided | undefined {
	if (direction !== "write") return undefined;
	for (const entry of policy) {
		if (entry.kind !== "path" || entry.rule.name !== BOUNCER) continue;
		const level = entry.levels.write;
		if (level === "off" || level === "allow") continue;
		if (paths.all.some((path) => covers(entry.rule, path, wheres))) {
			return { entry, level };
		}
	}
	return undefined;
}

function stricter(
	one: Decided | undefined,
	other: Decided | undefined,
): Decided | undefined {
	if (!one) return other;
	if (!other) return one;
	return STRICTNESS[other.level] > STRICTNESS[one.level] ? other : one;
}

function denies(decided: Decided, mode: FileMode): boolean {
	const always = alwaysDenySet.has(decided.entry.rule.name);
	if (mode === "yolo") return always;
	if (mode === "auto") return always || decided.level === "deny";
	return decided.level === "deny";
}

function walked(
	access: FileAccess,
	paths: Spellings,
	policy: Policy,
	wheres: readonly PathWhere[],
): Decided | undefined {
	const { direction } = access;
	const direct = stricter(
		strictest(paths, direction, policy, wheres, covers),
		raised(paths, direction, policy, wheres),
	);
	return access.search
		? stricter(direct, inScope(paths, direction, policy, wheres))
		: direct;
}

const SECRET_GROUPS = pathGroups().filter((group) => group.secret);

/**
 * Whether any spelling is in a secret group, whichever group decided and
 * whatever the groups' levels: a group the user turned off still names a
 * file that holds secrets.
 */
export function touchesSecret(paths: Spellings, where: PathWhere): boolean {
	const wheres = wheresOf(where);
	return SECRET_GROUPS.some(({ rule }) =>
		paths.all.some((path) => covers(rule, path, wheres)),
	);
}

export function rankFile(
	access: FileAccess,
	paths: Spellings,
	policy: Policy,
	where: PathWhere,
	mode: FileMode,
): Ranking | undefined {
	const { direction } = access;
	const wheres = wheresOf(where);
	const decided =
		selfWrite(paths, direction, policy, wheres) ??
		walked(access, paths, policy, wheres);
	if (!decided || decided.level === "allow") return undefined;
	const { rule, instead } = decided.entry;
	const matches: Match[] = [
		{ rule: rule.name, level: decided.level, source: paths.typed },
	];
	// A path steer's level is deny: it denies in every mode, with its text.
	if (instead !== undefined) {
		const verdict = pathSteerDenied(rule, instead, direction, paths.typed);
		return { kind: "deny", verdict, matches, steer: true };
	}
	const verdict = pathDenied(rule, direction, paths.typed);
	if (denies(decided, mode)) return { kind: "deny", verdict, matches };
	// The ask names the real path: a session allow covers that and nothing else.
	return {
		kind: "ask",
		asks: [{ rule: rule.name, summary: rule.summary, source: paths.real }],
		fallback: pathUnanswered(rule, direction, paths.typed),
		matches,
	};
}
