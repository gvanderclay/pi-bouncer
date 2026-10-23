// Ranking a file access against the policy's path entries: within one
// spelling the last match wins, so a later entry can carve an exception out of
// an earlier one; across spellings the strictest result wins. A search also
// reaches a protected path inside the folder it searches, and that scope is
// strictest-wins, so no allow unblocks it.
import type { Direction, FileAccess } from "../file-call.ts";
import { realOf, type Spellings } from "../path-spellings.ts";
import type { Match, Ranking } from "../rank.ts";
import { pathDenied, pathUnanswered } from "../verdict.ts";
import { alwaysDenySet } from "./built-in-policy.ts";
import type { PathPattern, PathWhere } from "./path-patterns.ts";
import type { PathEntry, PathRule, Policy } from "./rule.ts";

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

function anyMatch(
	patterns: readonly PathPattern[],
	path: string,
	wheres: readonly PathWhere[],
): boolean {
	return patterns.some((p) => wheres.some((where) => p.test(path, where)));
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
// depth are left out, or every project search would fire on `.env`.
function scoped(
	rule: PathRule,
	path: string,
	wheres: readonly PathWhere[],
): boolean {
	return rule.patterns.some((pattern) => {
		const { base } = pattern;
		if (base === undefined) return false;
		return wheres.some((where) => holds(path, base(where)));
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
		if (entry.kind !== "path") continue;
		const level = entry.levels[direction];
		if (level === "off" || !matches(entry.rule, path, wheres)) continue;
		found = { entry, level };
	}
	return found;
}

// Spellings are absolute or real, so the home and working directory are
// tried both as given and resolved, or a symlinked home would miss its rules.
function wheresOf(where: PathWhere): PathWhere[] {
	const real = {
		cwd: realOf(where.cwd),
		home: realOf(where.home),
		...(where.agentDir !== undefined && { agentDir: realOf(where.agentDir) }),
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
		if (entry.kind !== "path") continue;
		const level = entry.levels[direction];
		if (level === "off") continue;
		if (!paths.all.some((path) => scoped(entry.rule, path, wheres))) continue;
		if (!worst || STRICTNESS[level] > STRICTNESS[worst.level]) {
			worst = { entry, level };
		}
	}
	return worst;
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

export function rankFile(
	access: FileAccess,
	paths: Spellings,
	policy: Policy,
	where: PathWhere,
	mode: FileMode,
): Ranking | undefined {
	const { direction } = access;
	const wheres = wheresOf(where);
	const direct = strictest(paths, direction, policy, wheres, covers);
	const decided = access.search
		? stricter(direct, inScope(paths, direction, policy, wheres))
		: direct;
	if (!decided || decided.level === "allow") return undefined;
	const { rule } = decided.entry;
	const matches: Match[] = [
		{ rule: rule.name, level: decided.level, source: paths.typed },
	];
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
