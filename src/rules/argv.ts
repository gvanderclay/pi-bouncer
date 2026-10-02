// Argument conventions shared by rules. Rules judge `Invocation.args`
// (dequoted), and unless a rule says otherwise:
// - `--` ends options; everything after it is an operand.
// - A short cluster is an argument starting with a single `-` and one or more
//   letters (`-rf`). A flag is present when its letter appears in a cluster,
//   scanning stops at the first letter that takes a value (the rest of the
//   cluster is that value).
// - A long option is `--name` or `--name=value`. A dangerous long option
//   matches any `--p` where `p` is a prefix of its name (git and GNU tools
//   accept unambiguous abbreviations, and denying an ambiguous one is harmless
//   because the tool would refuse it anyway). A long option that allows
//   something (`--staged`, `--dry-run`) matches exactly only.
// - A lone `-` is an operand.
// - An unknown option is skipped as a bare flag and processing continues.

export function optionArgs(args: readonly string[]): readonly string[] {
	const end = args.indexOf("--");
	return end === -1 ? args : args.slice(0, end);
}

export function hasShortFlag(
	args: readonly string[],
	letters: string,
	valueLetters = "",
): boolean {
	for (const arg of optionArgs(args)) {
		if (!/^-[A-Za-z]/.test(arg)) continue;
		for (const letter of arg.slice(1)) {
			if (letters.includes(letter)) return true;
			if (valueLetters.includes(letter)) break;
		}
	}
	return false;
}

export function hasLongOption(args: readonly string[], name: string): boolean {
	return optionArgs(args).some((arg) => isLongOption(arg, name));
}

function abbreviates(given: string, name: string): boolean {
	return given !== "" && name.startsWith(given);
}

export function isLongOption(arg: string, name: string): boolean {
	if (!arg.startsWith("--")) return false;
	return abbreviates(arg.slice(2).split("=", 1)[0] ?? "", name);
}

export type OptionSpec = {
	/** Short options that take a value: the rest of the cluster, or the next argument. */
	readonly shortValues?: string;
	/** Long options (full names) that take a separate value when given without `=`. */
	readonly longValues?: readonly string[];
};

export type ParsedArgs = {
	readonly shorts: readonly string[];
	readonly longs: readonly string[];
	readonly operands: readonly string[];
	readonly afterDashDash?: readonly string[];
};

type Parsing = {
	shorts: string[];
	longs: string[];
	operands: string[];
	at: number;
};

function readLongArg(arg: string, spec: OptionSpec, state: Parsing): void {
	const [given = "", ...value] = arg.slice(2).split("=");
	state.longs.push(given);
	const takesValue = spec.longValues?.some((name) => abbreviates(given, name));
	if (value.length === 0 && takesValue) state.at += 1;
}

function readShortArg(arg: string, spec: OptionSpec, state: Parsing): void {
	for (let at = 1; at < arg.length; at += 1) {
		const letter = arg.charAt(at);
		state.shorts.push(letter);
		if (spec.shortValues?.includes(letter)) {
			if (at === arg.length - 1) state.at += 1;
			return;
		}
	}
}

export function parseArgs(
	args: readonly string[],
	spec: OptionSpec = {},
): ParsedArgs {
	const state: Parsing = { shorts: [], longs: [], operands: [], at: 0 };
	for (; state.at < args.length; state.at += 1) {
		const arg = args[state.at] ?? "";
		if (arg === "--") {
			const { shorts, longs, operands } = state;
			return {
				shorts,
				longs,
				operands,
				afterDashDash: args.slice(state.at + 1),
			};
		}
		if (arg.startsWith("--")) readLongArg(arg, spec, state);
		else if (arg.startsWith("-") && arg.length > 1)
			readShortArg(arg, spec, state);
		else state.operands.push(arg);
	}
	const { shorts, longs, operands } = state;
	return { shorts, longs, operands };
}

export function givesLong(parsed: ParsedArgs, name: string): boolean {
	return parsed.longs.some((given) => abbreviates(given, name));
}
