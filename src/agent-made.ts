// Directories this session's agent provably made: a recursive `rm` of one, or
// of something inside one, needs no ask. Only literal paths count, and every
// check reads the filesystem, so a symlink never smuggles in a path outside
// the directory.
import { lstatSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { soleDirectInvocation } from "./agent-made-command.ts";
import { parseArgs } from "./rules/argv.ts";
import type { Invocation, ParseFn } from "./scan/walk.ts";
import { isWrapper } from "./scan/wrappers.ts";

/**
 * Real path (so `/tmp` and `/private/tmp` agree) to the time, in ms, just
 * before the command that made it ran, and the directory's identity then.
 */
export type AgentMade = Map<string, Made>;

// `born` as well as the inode: Linux filesystems hand a deleted directory's
// inode number straight to the next one made.
export type Made = {
	readonly since: number;
	readonly dev: number;
	readonly ino: number;
	readonly born: number;
};

/**
 * Told to the agent at the start of every run, so it deletes the way that
 * needs no ask; the no-UI block repeats it. A recipe at least as strict as
 * `creationTargets`, `checkRms` and the lone-call check: following it always
 * passes them, though they accept more.
 */
export const AGENT_MADE_NOTE = `A recursive rm of a folder you made this session, or of something inside it, runs without asking the user when you follow these steps:
1. Make the folder in a call of its own: a literal \`mkdir -p /full/path\`, \`mktemp -d\` alone (read the path it prints), or \`cp -r <dir> /full/new/path\` alone, into a path that does not exist yet.
2. Keep anything older than the folder out of it: moved-in files and date-preserving copies keep their old dates.
3. Delete it in a later call with \`rm -rf /full/path\`, a literal path with no $VARIABLES, ~, wildcards or .. segments. Put nothing else in that call, not even a \`cd\`, and make it the only tool call in its message.
To recreate a folder, delete it in one call and make it again in the next. Make, use and delete the folder in separate calls.`;

// Room for filesystems that store times to the second (or two, on FAT).
export const CLOCK_SLACK_MS = 2_000;

// ponytail: a fixed cap, so a huge tree asks instead of stalling the call.
export const WALK_LIMIT = 10_000;

// No expansion, glob, brace or escape: the text is exactly the path rm gets.
const UNSAFE = /[$`*?[\]{}~\\]/;

export function literalAbsolute(path: string): boolean {
	return path.startsWith("/") && !UNSAFE.test(path);
}

// Resolving a symlink before a `..` can differ from the filesystem's own
// resolution, so a literal operand may not contain a parent segment.
function hasParent(path: string): boolean {
	return /(?:^|\/)\.\.(?:\/|$)/.test(path);
}

export function literalRelative(path: string): boolean {
	return (
		path !== "" &&
		!path.startsWith("/") &&
		!UNSAFE.test(path) &&
		!hasParent(path)
	);
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

// The absolute path a creation operand names, or undefined when its spelling
// is not one the code reads. Relative operands need a direct command and an
// absolute working directory (`posix.resolve` would use the process's own).
function fullPath(
	path: string,
	cwd: string,
	direct: boolean,
): string | undefined {
	// `resolve`, not `normalize`: it drops a trailing slash, which would make
	// lstat follow a symlink root.
	if (literalAbsolute(path)) return posix.resolve(path);
	if (direct && cwd.startsWith("/") && literalRelative(path)) {
		return posix.resolve(cwd, path);
	}
	return undefined;
}

/** Checked before the command runs: what its `mkdir`s will make if it succeeds. */
export function mkdirTargets(
	invocations: readonly Invocation[],
	cwd: string,
	direct: Invocation | undefined,
): string[] {
	return invocations.flatMap((invocation) => {
		if (invocation.name !== "mkdir" && invocation.name !== "gmkdir") return [];
		const spec = { shortValues: "mZ", longValues: ["mode", "context"] };
		const { operands, afterDashDash = [] } = parseArgs(invocation.args, spec);
		return [...operands, ...afterDashDash].flatMap((path) => {
			const full = fullPath(path, cwd, invocation === direct);
			return full === undefined ? [] : (topMissing(full) ?? []);
		});
	});
}

const COPY_NAMES = new Set(["cp", "gcp"]);
const COPY_FLAGS = new Set(["-r", "-R", "--recursive"]);

// One literal source, one literal destination, only recursive flags: a copy
// into an existing folder proves nothing, and any other flag may change what
// it does.
function copyOperands(
	args: readonly string[],
): readonly [string, string] | undefined {
	const operands: string[] = [];
	let end = false;
	let recursive = false;
	for (const arg of args) {
		if (!end && arg === "--") {
			end = true;
		} else if (!end && arg.startsWith("-") && arg.length > 1) {
			if (!COPY_FLAGS.has(arg)) return undefined;
			recursive = true;
		} else {
			operands.push(arg);
		}
	}
	const [source, dest, extra] = operands;
	if (!recursive || source === undefined || dest === undefined) {
		return undefined;
	}
	return extra === undefined ? [source, dest] : undefined;
}

// The source has to be a real directory. `posix.normalize` strips a trailing
// slash or `/.`, which would otherwise make lstat follow a symlink root.
function copySource(source: string): boolean {
	try {
		const stat = lstatSync(source);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

// Absent means lstat said ENOENT; a dangling symlink is present, and any
// other error is not evidence of absence.
function absent(path: string): boolean {
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/** The new folder a direct recursive copy will make, when its destination is absent now. */
export function copyTarget(
	invocation: Invocation,
	cwd: string,
): string | undefined {
	if (!COPY_NAMES.has(invocation.name)) return undefined;
	const operands = copyOperands(invocation.args);
	if (!operands) return undefined;
	const [source, dest] = operands;
	// `fullPath` resolves absolute operands lexically, so a `..` after a
	// symlink would inspect a different root than `cp` reads; reject it first.
	if (hasParent(source) || hasParent(dest)) return undefined;
	const from = fullPath(source, cwd, true);
	const to = fullPath(dest, cwd, true);
	if (from === undefined || to === undefined) return undefined;
	return copySource(from) && absent(to) ? to : undefined;
}

/** Paths a command will make if it succeeds: `mkdir`s and qualifying `cp`s. */
export function creationTargets(
	parse: ParseFn | undefined,
	command: string,
	invocations: readonly Invocation[],
	cwd: string,
): string[] {
	const direct = parse
		? soleDirectInvocation(parse, command, invocations)
		: undefined;
	const copy = direct ? copyTarget(direct, cwd) : undefined;
	return [...mkdirTargets(invocations, cwd, direct), ...(copy ? [copy] : [])];
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
			const { dev, ino, birthtimeMs: born } = stat;
			made.set(realpathSync(path), { since, dev, ino, born });
		} catch {
			// Gone already: nothing to record.
		}
	}
}

function isSame(dir: string, { dev, ino, born }: Made): boolean {
	try {
		const stat = lstatSync(dir);
		return stat.dev === dev && stat.ino === ino && stat.birthtimeMs === born;
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

// Commands that add nothing to a directory tree. The trees are read before any
// of the line runs, so a `mv` or `cp` earlier on it could fill them unseen.
// No assignment: `PATH=…` could swap the `rm` that runs.
const HARMLESS = new Set([
	"rm",
	"grm",
	"cd",
	"echo",
	"printf",
	"true",
	"ls",
	"pwd",
]);

/** Why nothing but removing may change what the `rm` deletes, if that is so. */
export type RemovalSafety =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: "expansion" | "wrapper" | "compound-command";
	  };

/**
 * True when nothing on the line but removing could change what `rm` deletes.
 * No `$` or backtick anywhere: an expansion can run a command the scan never
 * sees (`echo $((x))` with `x='a[$(mv …)]'`).
 */
export function removalSafety(
	command: string,
	invocations: readonly Invocation[],
): RemovalSafety {
	if (/[$`]/.test(command)) return { ok: false, reason: "expansion" };
	const blocking = invocations.find(
		(invocation) => !HARMLESS.has(invocation.name),
	);
	if (blocking === undefined) return { ok: true };
	return {
		ok: false,
		reason: isWrapper(blocking.name) ? "wrapper" : "compound-command",
	};
}
