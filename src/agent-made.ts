// Directories this session's agent provably made: a recursive `rm` of one, or
// of something inside one, needs no ask. Only literal absolute paths count,
// and every check reads the filesystem, so a symlink never smuggles in a
// path outside the directory.
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { parseArgs } from "./rules/argv.ts";
import type { Invocation } from "./scan/walk.ts";

/**
 * Real path (so `/tmp` and `/private/tmp` agree) to the time, in ms, just
 * before the command that made it ran, and the directory's identity then.
 */
export type AgentMade = Map<string, Made>;

type Made = {
	readonly since: number;
	readonly dev: number;
	readonly ino: number;
};

// Room for filesystems that store times to the second (or two, on FAT).
const CLOCK_SLACK_MS = 2_000;

// ponytail: a fixed cap, so a huge tree asks instead of stalling the call.
export const WALK_LIMIT = 10_000;

// No expansion, glob, brace or escape: the text is exactly the path rm gets.
function literalAbsolute(path: string): boolean {
	return path.startsWith("/") && !/[$`*?[\]{}~\\]/.test(path);
}

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

// The highest missing directory `mkdir -p` would make: `mkdir -p` of a path
// that already exists proves nothing, so an existing one gives nothing.
function topMissing(path: string): string | undefined {
	let top: string | undefined;
	for (let at = posix.resolve(path); !exists(at); at = posix.dirname(at)) {
		top = at;
	}
	return top;
}

/** Checked before the command runs: what its `mkdir`s will make if it succeeds. */
export function mkdirTargets(invocations: readonly Invocation[]): string[] {
	return invocations.flatMap((invocation) => {
		if (invocation.name !== "mkdir" && invocation.name !== "gmkdir") return [];
		const spec = { shortValues: "mZ", longValues: ["mode", "context"] };
		const { operands, afterDashDash = [] } = parseArgs(invocation.args, spec);
		return [...operands, ...afterDashDash]
			.filter(literalAbsolute)
			.flatMap((path) => topMissing(path) ?? []);
	});
}

/** The path a command that is nothing but `mktemp -d` printed. */
export function mktempTarget(
	invocations: readonly Invocation[],
	output: string,
): string | undefined {
	const [only, ...rest] = invocations;
	if (!only || rest.length > 0 || only.name !== "mktemp") return undefined;
	const { shorts, longs } = parseArgs(only.args, {
		shortValues: "pt",
		longValues: ["tmpdir", "suffix"],
	});
	if (!shorts.includes("d") && !longs.includes("directory")) return undefined;
	const path = output.trim();
	return literalAbsolute(path) && !path.includes("\n") ? path : undefined;
}

/** Records each path that is now a real directory, not a symlink. */
export function recordMade(
	made: AgentMade,
	paths: readonly string[],
	since: number,
): void {
	for (const path of paths) {
		try {
			const stat = lstatSync(path);
			if (!stat.isDirectory()) continue;
			made.set(realpathSync(path), { since, dev: stat.dev, ino: stat.ino });
		} catch {
			// Gone already: nothing to record.
		}
	}
}

function isSame(dir: string, { dev, ino }: Made): boolean {
	try {
		const stat = lstatSync(dir);
		return stat.dev === dev && stat.ino === ino;
	} catch {
		return false;
	}
}

/**
 * Forgets each directory that is gone or replaced, so whatever is made at its
 * path later is not the agent's.
 */
export function forgetGone(made: AgentMade): void {
	for (const [dir, entry] of made) if (!isSame(dir, entry)) made.delete(dir);
}

// The earliest time the agent made a directory holding `real`.
function madeSince(made: AgentMade, real: string): number | undefined {
	forgetGone(made);
	let since: number | undefined;
	for (const [dir, entry] of made) {
		const inside = real === dir || real.startsWith(`${dir}/`);
		if (inside && (since === undefined || entry.since < since)) {
			since = entry.since;
		}
	}
	return since;
}

// Moving keeps a file's dates, even across disks, so anything dated before
// the directory was made came from elsewhere: deleting it needs an ask. An
// unknown birth time reads as 0 on some Linux filesystems and is skipped.
function allNewer(
	root: string,
	cutoff: number,
	budget: { left: number },
): boolean {
	const stack = [root];
	for (let path = stack.pop(); path !== undefined; path = stack.pop()) {
		budget.left -= 1;
		if (budget.left < 0) return false;
		const stat = lstatSync(path);
		const born = stat.birthtimeMs;
		if (stat.mtimeMs < cutoff || (born > 0 && born < cutoff)) return false;
		if (stat.isDirectory()) {
			for (const name of readdirSync(path)) stack.push(`${path}/${name}`);
		}
	}
	return true;
}

function isMade(
	made: AgentMade,
	operand: string,
	budget: { left: number },
): boolean {
	if (!literalAbsolute(operand)) return false;
	try {
		const real = realpathSync(operand);
		const since = madeSince(made, real);
		if (since === undefined) return false;
		return allNewer(real, since - CLOCK_SLACK_MS, budget);
	} catch {
		return false;
	}
}

// Commands that add nothing to a directory tree. The trees are read before any
// of the line runs, so a `mv` or `cp` earlier on it could fill them unseen.
const HARMLESS = new Set([
	"rm",
	"grm",
	"cd",
	"echo",
	"printf",
	"true",
	"ls",
	"pwd",
	"",
]);

/** True when nothing on the line but removing could change what `rm` deletes. */
export function onlyRemoves(invocations: readonly Invocation[]): boolean {
	return invocations.every((invocation) => HARMLESS.has(invocation.name));
}

// Typed as `rm` itself: a wrapper (`xargs`, `bash -c`, `timeout`) may add
// operands or change what runs.
const DIRECT_RM = /^\\?(?:\S*\/)?g?rm\s/;

/**
 * True when `rm` runs directly and every operand is inside an agent-made
 * directory and holds nothing older than that directory.
 */
export function rmOfAgentMade(
	made: AgentMade,
	invocation: Invocation,
): boolean {
	if (made.size === 0 || !DIRECT_RM.test(invocation.source)) return false;
	const { operands, afterDashDash = [] } = parseArgs(invocation.args);
	const targets = [...operands, ...afterDashDash];
	const budget = { left: WALK_LIMIT };
	return (
		targets.length > 0 &&
		targets.every((target) => isMade(made, target, budget))
	);
}
