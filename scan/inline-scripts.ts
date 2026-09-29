// Strings that a command runs as bash: `sh -c SCRIPT`, `eval ARGS…`,
// `trap SCRIPT SIGNAL…`, and `env -S STRING` (split into one command).
import type { ParsedScript } from "unbash";
import type { Invocation } from "./walk.ts";

/** Top level is depth 0; a re-parse deeper than this is `too-deep`. */
export const MAX_INLINE_DEPTH = 3;

const SHELLS: ReadonlySet<string> = new Set([
	"bash",
	"sh",
	"zsh",
	"dash",
	"ksh",
]);
const SHELL_LONG_VALUES: ReadonlySet<string> = new Set([
	"--rcfile",
	"--init-file",
]);

/** How many arguments a shell option spans; 0 when `arg` is not an option. */
function shellOptionWidth(arg: string): number {
	if (SHELL_LONG_VALUES.has(arg)) return 2;
	if (arg.startsWith("--")) return 1;
	if (/^[-+][A-Za-z]+$/.test(arg)) return /[oO]$/.test(arg) ? 2 : 1;
	return 0;
}

/**
 * bash(1): with -c, "commands are read from the first non-option argument".
 * `-o`/`-O` (and `+o`/`+O`) take a value; `--` or `-` ends options.
 */
function shellScript(args: readonly string[]): string | undefined {
	let hasC = false;
	let at = 0;
	for (let arg = args[at]; arg !== undefined; arg = args[at]) {
		if (arg === "--" || arg === "-") return hasC ? args[at + 1] : undefined;
		const width = shellOptionWidth(arg);
		if (width === 0) break;
		if (/^-[A-Za-z]*c/.test(arg)) hasC = true;
		at += width;
	}
	return hasC ? args[at] : undefined;
}

/** bash: eval joins its arguments with spaces and runs the result. */
function evalScript(args: readonly string[]): string | undefined {
	const operands = args[0] === "--" ? args.slice(1) : args;
	return operands.length > 0 ? operands.join(" ") : undefined;
}

/**
 * `help trap`: `trap [-Plp] [[action] signal_spec ...]`. An absent action
 * (one operand), `-`, or the null string runs nothing.
 */
function trapScript(args: readonly string[]): string | undefined {
	const first = args[0];
	if (first !== "--" && first?.startsWith("-")) return undefined;
	const operands = first === "--" ? args.slice(1) : args;
	const action = operands[0];
	if (operands.length < 2 || action === "-" || action === "") return undefined;
	return action;
}

/** The bash script an invocation runs from a string argument, if any. */
export function inlineScript(invocation: Invocation): string | undefined {
	if (SHELLS.has(invocation.name)) return shellScript(invocation.args);
	if (invocation.name === "eval") return evalScript(invocation.args);
	if (invocation.name === "trap") return trapScript(invocation.args);
	return undefined;
}

/**
 * env -S splits its string into words and splices them into its own argv
 * (`genv -S 'echo' -- -rf x` prints `-- -rf x`), so the caller rebuilds the
 * wrapper with those words and peels it once more. env does not interpret
 * `|`, `;` or redirects: a string that is not exactly one simple command is
 * suspicious, so it yields an error message instead of words.
 */
export function splitCommand(script: ParsedScript): readonly string[] | string {
	return splitWords(script) ?? "env -S string is not a single simple command";
}

/** The words of a script that is one simple command (or empty), else undefined. */
function splitWords(script: ParsedScript): readonly string[] | undefined {
	const [statement, ...others] = script.commands;
	if (!statement) return [];
	const command = statement.command;
	if (
		others.length > 0 ||
		statement.background ||
		statement.redirects.length > 0 ||
		command.type !== "Command" ||
		command.redirects.length > 0
	) {
		return undefined;
	}
	return [command.name, ...command.suffix].flatMap((word) =>
		word ? [word.value] : [],
	);
}
