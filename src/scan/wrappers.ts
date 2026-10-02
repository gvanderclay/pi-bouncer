// Option lists are the union of the macOS (BSD) and GNU tools.
import { commandName } from "./normalize.ts";
import type { Invocation } from "./walk.ts";

type Wrapper = {
	readonly names: readonly string[];
	/** Short options that take a value: the rest of the cluster, or the next argument. */
	readonly shortValues?: string;
	/** Short options whose optional value can only be attached (`-i{}`). */
	readonly shortAttached?: string;
	readonly longValues?: readonly string[];
	/** Short options that mean no command runs (`command -v`). */
	readonly noRun?: string;
	/** Plain operands before the command (timeout's duration). */
	readonly operands?: number;
	/** Skip `NAME=value` operands before the command (env). */
	readonly assignments?: boolean;
	/** A lone `-` is an option here, not the command (env's `-i`). */
	readonly dashOption?: boolean;
	// env -S
	readonly split?: { readonly short: string; readonly long: string };
	// flock -c
	readonly script?: { readonly short: string; readonly long: string };
	/**
	 * The command operands are joined with spaces and run by `sh -c`, unless
	 * this option says otherwise (watch -x).
	 */
	readonly shellRest?: { readonly exec: { short: string; long: string } };
};

// What a wrapper runs: a command; (env -S) a string to split into one, then
// the remaining operands; or a string it hands to `sh -c` (watch, flock -c).
export type Peeled =
	| { readonly kind: "command"; readonly invocation: Invocation }
	| {
			readonly kind: "split";
			readonly parent: Invocation;
			readonly script: string;
			readonly rest: readonly string[];
	  }
	| {
			readonly kind: "shell";
			readonly parent: Invocation;
			readonly script: string;
	  };

const ENV: Wrapper = {
	names: ["env"],
	shortValues: "uCPSa",
	longValues: ["unset", "chdir", "split-string", "argv0"],
	assignments: true,
	dashOption: true,
	split: { short: "S", long: "split-string" },
};

/** env's short options that take a value, for rules that read env's options. */
export const ENV_SHORT_VALUES: string = ENV.shortValues ?? "";

const WRAPPERS: readonly Wrapper[] = [
	ENV,
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

export type EnvParts = {
	/** Everything before the first assignment or command, `--` included. */
	readonly options: readonly string[];
	/** The `NAME=value` operands before the command. */
	readonly assignments: readonly string[];
	/** The command env runs, with its arguments (empty with -S: see `split`). */
	readonly command: readonly string[];
	/** The -S string, which holds the command; `command` is then what follows it. */
	readonly split?: string;
};

// Splits env's arguments with the same option table the scan uses, so that
// the command's own words are never read as env's options or assignments.
export function envParts(args: readonly string[]): EnvParts {
	const cursor: Cursor = { index: 0 };
	skipOptions(ENV, args, cursor);
	const options = args.slice(0, cursor.index);
	if (cursor.split !== undefined) {
		return {
			options,
			assignments: [],
			command: args.slice(cursor.index),
			split: cursor.split,
		};
	}
	while (ASSIGNMENT.test(args[cursor.index] ?? "")) cursor.index += 1;
	return {
		options,
		assignments: args.slice(options.length, cursor.index),
		command: args.slice(cursor.index),
	};
}

function peelCommand(
	wrapper: Wrapper,
	invocation: Invocation,
	rest: readonly string[],
	cursor: Cursor,
): Peeled | undefined {
	const [name, ...commandArgs] = rest;
	if (name === undefined) return undefined;
	if (wrapper.shellRest && cursor.exec !== true) {
		return { kind: "shell", parent: invocation, script: rest.join(" ") };
	}
	if (wrapper.script && isScriptOption(wrapper.script, name)) {
		// Without its value flock refuses and runs nothing.
		const script = commandArgs[0];
		if (script === undefined) return undefined;
		return { kind: "shell", parent: invocation, script };
	}
	return {
		kind: "command",
		invocation: { ...invocation, name: commandName(name), args: commandArgs },
	};
}

// flock FILE -c COMMAND: util-linux stops reading options at the file, so
// only -c or --command right after it is an option; any other word there,
// dash or not, is the command.
function isScriptOption(
	option: { readonly short: string; readonly long: string },
	given: string,
): boolean {
	return given === `-${option.short}` || given === `--${option.long}`;
}
