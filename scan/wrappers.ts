// Commands that run another command. One table row per wrapper; one peeling
// function reads it. Option lists are the union of the macOS (BSD) and GNU
// tools; the evidence is in the package's archived issue notes.
import { commandName } from "./normalize.ts";
import type { Invocation } from "./walk.ts";

type Wrapper = {
	readonly names: readonly string[];
	/** Short options that take a value: the rest of the cluster, or the next argument. */
	readonly shortValues?: string;
	/** Short options whose optional value can only be attached (`-i{}`). */
	readonly shortAttached?: string;
	/** Long options that take a value: `--name=value` or `--name value`. */
	readonly longValues?: readonly string[];
	/** Short options that mean no command runs (`command -v`). */
	readonly noRun?: string;
	/** Plain operands before the command (timeout's duration). */
	readonly operands?: number;
	/** Skip `NAME=value` operands before the command (env). */
	readonly assignments?: boolean;
	/** A lone `-` is an option here, not the command (env's `-i`). */
	readonly dashOption?: boolean;
	/** The option whose value is a string split into the command (env -S). */
	readonly split?: { readonly short: string; readonly long: string };
	/** The option whose value is a shell script the wrapper runs (flock -c). */
	readonly script?: { readonly short: string; readonly long: string };
	/**
	 * The command operands are joined with spaces and run by `sh -c`, unless
	 * this option says otherwise (watch -x).
	 */
	readonly shellRest?: { readonly exec: { short: string; long: string } };
};

/**
 * What a wrapper runs: a command; (env -S) a string to split into one,
 * followed by the wrapper's remaining operands; a string it hands to
 * `sh -c` (watch, flock -c); or something its arguments do not show.
 */
export type Peeled =
	| { readonly kind: "command"; readonly invocation: Invocation }
	| {
			readonly kind: "split";
			/** The wrapper invocation, to rebuild with the split words. */
			readonly parent: Invocation;
			readonly script: string;
			readonly rest: readonly string[];
	  }
	| {
			/** A string the wrapper runs with `sh -c`. */
			readonly kind: "shell";
			readonly parent: Invocation;
			readonly script: string;
	  }
	| {
			/** An option shape this table does not know where the command goes. */
			readonly kind: "opaque";
	  };

const WRAPPERS: readonly Wrapper[] = [
	{
		names: ["env"],
		shortValues: "uCPSa",
		longValues: ["unset", "chdir", "split-string", "argv0"],
		assignments: true,
		dashOption: true,
		split: { short: "S", long: "split-string" },
	},
	{ names: ["command"], noRun: "vV" },
	{ names: ["builtin"] },
	{ names: ["exec"], shortValues: "a" },
	{ names: ["nohup"] },
	// util-linux: -c/--ctty, -f/--fork, -w/--wait take no value.
	{ names: ["setsid"] },
	// util-linux flock(1): file|directory|fd, then command and arguments, or
	// `-c command` (before or after the file) run by the shell.
	{
		names: ["flock"],
		shortValues: "wEc",
		longValues: ["timeout", "wait", "conflict-exit-code", "command"],
		operands: 1,
		script: { short: "c", long: "command" },
	},
	// procps-ng watch(1): the command goes to `sh -c` unless -x/--exec.
	{
		names: ["watch"],
		shortValues: "nqs",
		shortAttached: "d",
		longValues: ["interval", "equexit", "shotsdir"],
		shellRest: { exec: { short: "x", long: "exec" } },
	},
	{ names: ["time"], shortValues: "of", longValues: ["output", "format"] },
	{ names: ["nice"], shortValues: "n", longValues: ["adjustment"] },
	{
		names: ["timeout", "gtimeout"],
		shortValues: "sk",
		longValues: ["signal", "kill-after"],
		operands: 1,
	},
	{
		names: ["stdbuf", "gstdbuf"],
		shortValues: "ioe",
		longValues: ["input", "output", "error"],
	},
	{ names: ["caffeinate"], shortValues: "tw" },
	{
		names: ["xargs"],
		shortValues: "adEILnPsJRS",
		shortAttached: "eil",
		longValues: [
			"arg-file",
			"delimiter",
			"max-args",
			"max-procs",
			"max-chars",
			"process-slot-var",
		],
	},
];

const BY_NAME: ReadonlyMap<string, Wrapper> = new Map(
	WRAPPERS.flatMap((wrapper) => wrapper.names.map((name) => [name, wrapper])),
);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

type Cursor = {
	index: number;
	split?: string;
	script?: string;
	/** watch -x: the command runs directly, not through `sh -c`. */
	exec?: boolean;
};

/** Reads the value of a value-taking short option at `at` in its cluster. */
function readShortValue(
	wrapper: Wrapper,
	args: readonly string[],
	cursor: Cursor,
	at: number,
): void {
	const cluster = args[cursor.index - 1] ?? "";
	const attached = cluster.slice(at + 1);
	const value = attached === "" ? args[cursor.index] : attached;
	if (attached === "") cursor.index += 1;
	if (cluster.charAt(at) === wrapper.split?.short && value !== undefined) {
		cursor.split = value;
	}
	if (cluster.charAt(at) === wrapper.script?.short && value !== undefined) {
		cursor.script = value;
	}
}

/** Reads one short cluster. Returns false when an option means no command runs. */
function readCluster(
	wrapper: Wrapper,
	args: readonly string[],
	cursor: Cursor,
): boolean {
	const cluster = args[cursor.index] ?? "";
	cursor.index += 1;
	for (let at = 1; at < cluster.length; at += 1) {
		const letter = cluster.charAt(at);
		if (wrapper.noRun?.includes(letter)) return false;
		if (letter === wrapper.shellRest?.exec.short) cursor.exec = true;
		if (wrapper.shortAttached?.includes(letter)) return true;
		if (wrapper.shortValues?.includes(letter)) {
			readShortValue(wrapper, args, cursor, at);
			return true;
		}
	}
	return true;
}

function readLong(
	wrapper: Wrapper,
	args: readonly string[],
	cursor: Cursor,
): void {
	const arg = args[cursor.index] ?? "";
	cursor.index += 1;
	const [given = "", attached] = splitOnce(arg.slice(2), "=");
	const matches = (name: string): boolean => name.startsWith(given);
	let value = attached;
	if (attached === undefined && wrapper.longValues?.some(matches)) {
		value = args[cursor.index];
		cursor.index += 1;
	}
	const exec = wrapper.shellRest?.exec.long;
	if (exec?.startsWith(given) && given.length >= 2) cursor.exec = true;
	if (wrapper.script && matches(wrapper.script.long) && value !== undefined) {
		cursor.script = value;
	}
	if (wrapper.split && matches(wrapper.split.long) && value !== undefined) {
		cursor.split = value;
	}
}

function splitOnce(text: string, separator: string): [string, string?] {
	const at = text.indexOf(separator);
	return at === -1 ? [text] : [text.slice(0, at), text.slice(at + 1)];
}

function isOption(wrapper: Wrapper, arg: string): boolean {
	return arg.startsWith("-") && (arg.length > 1 || wrapper.dashOption === true);
}

/** Reads one option. Returns false when it means no command runs. */
function readOption(
	wrapper: Wrapper,
	args: readonly string[],
	cursor: Cursor,
): boolean {
	const arg = args[cursor.index] ?? "";
	if (arg === "-") cursor.index += 1;
	else if (arg.startsWith("--")) readLong(wrapper, args, cursor);
	else return readCluster(wrapper, args, cursor);
	return true;
}

/** Skips the wrapper's options up to its operands. Returns false when no command runs. */
function skipOptions(
	wrapper: Wrapper,
	args: readonly string[],
	cursor: Cursor,
): boolean {
	for (
		let arg = args[cursor.index];
		arg !== undefined && isOption(wrapper, arg);
		arg = args[cursor.index]
	) {
		if (arg === "--") {
			cursor.index += 1;
			return true;
		}
		if (!readOption(wrapper, args, cursor)) return false;
		// env -S and flock -c end option processing: the rest follows the string.
		if (cursor.split !== undefined || cursor.script !== undefined) return true;
	}
	return true;
}

/**
 * What a wrapper invocation runs, or undefined when the invocation is not a
 * wrapper or runs nothing. The result keeps the wrapper's source text and
 * relationships.
 */
export function peel(invocation: Invocation): Peeled | undefined {
	const wrapper = BY_NAME.get(invocation.name);
	if (!wrapper) return undefined;
	const { args } = invocation;
	const cursor: Cursor = { index: 0 };
	if (!skipOptions(wrapper, args, cursor)) return undefined;
	if (cursor.script !== undefined) {
		return { kind: "shell", parent: invocation, script: cursor.script };
	}
	if (cursor.split !== undefined) {
		const rest = args.slice(cursor.index);
		const script = cursor.split;
		return { kind: "split", parent: invocation, script, rest };
	}
	cursor.index += wrapper.operands ?? 0;
	while (wrapper.assignments && ASSIGNMENT.test(args[cursor.index] ?? "")) {
		cursor.index += 1;
	}
	return peelCommand(wrapper, invocation, args.slice(cursor.index), cursor);
}

/** The command operands after the wrapper's options and plain operands. */
function peelCommand(
	wrapper: Wrapper,
	invocation: Invocation,
	rest: readonly string[],
	cursor: Cursor,
): Peeled | undefined {
	const [name, ...commandArgs] = rest;
	if (name === undefined) return undefined;
	if (wrapper.shellRest && cursor.exec !== true) {
		// watch joins its operands with spaces and runs them with `sh -c`.
		return { kind: "shell", parent: invocation, script: rest.join(" ") };
	}
	if (wrapper.script && name.startsWith("-")) {
		return trailingScript(wrapper.script, invocation, rest);
	}
	return {
		kind: "command",
		invocation: { ...invocation, name: commandName(name), args: commandArgs },
	};
}

/**
 * flock FILE -c COMMAND: util-linux reads the option only right after the
 * file. Any other option there is a shape this table does not know.
 */
function trailingScript(
	option: { readonly short: string; readonly long: string },
	invocation: Invocation,
	[given, script]: readonly string[],
): Peeled | undefined {
	if (given !== `-${option.short}` && given !== `--${option.long}`) {
		return { kind: "opaque" };
	}
	// Without its value flock refuses and runs nothing.
	if (script === undefined) return undefined;
	return { kind: "shell", parent: invocation, script };
}
