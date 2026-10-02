// Commands and options that run a command the bouncer cannot read in full:
// search tools' exec options and template runners.
import type { Invocation } from "../scan/walk.ts";
import {
	hasLongOption,
	hasShortFlag,
	isLongOption,
	optionArgs,
} from "./argv.ts";
import { findWith } from "./filesystem.ts";
import type { Rule } from "./rule.ts";

/** find's actions whose next argument is a command it runs. */
export const FIND_EXEC_ACTIONS: readonly string[] = [
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
];

export const findExec: Rule = {
	name: "find-exec",
	summary: "find -exec, -execdir, -ok and -okdir run arbitrary commands",
	matches: (invocation: Invocation): boolean =>
		findWith(invocation, FIND_EXEC_ACTIONS),
};

// `fdfind` is Debian's name for fd. fd 10.4.2's value-taking short options
// (`fd --help`); a cluster letter after one of them is its value.
export const FD_NAMES: ReadonlySet<string> = new Set(["fd", "fdfind"]);
export const FD_VALUE_LETTERS = "dEteSoxXcjC";

export const fdExec: Rule = {
	name: "fd-exec",
	summary: "fd -x and -X run arbitrary commands",
	matches: (invocation: Invocation): boolean =>
		FD_NAMES.has(invocation.name) &&
		(hasShortFlag(invocation.args, "xX", FD_VALUE_LETTERS) ||
			hasLongOption(invocation.args, "exec") ||
			hasLongOption(invocation.args, "exec-batch")),
};

// A separate argument after these is a search pattern or file, not an option.
const RG_PATTERN_OPTIONS: ReadonlySet<string> = new Set([
	"-e",
	"-f",
	"--regexp",
	"--file",
]);

function isRgPatternOption(arg: string | undefined): boolean {
	return (
		arg !== undefined &&
		(RG_PATTERN_OPTIONS.has(arg) || /^-[A-Za-z]*[ef]$/.test(arg))
	);
}

export const rgPre: Rule = {
	name: "rg-pre",
	summary: "rg --pre runs an arbitrary preprocessor command",
	matches: (invocation: Invocation): boolean =>
		invocation.name === "rg" &&
		optionArgs(invocation.args).some(
			(arg, at, args) =>
				isLongOption(arg, "pre") && !isRgPatternOption(args[at - 1]),
		),
};

// Each runs a command template once per input, with the input substituted
// into it, so what runs is not in the command line.
const TEMPLATE_RUNNERS: ReadonlySet<string> = new Set([
	"parallel",
	"rush",
	"rust-parallel",
]);

export const opaqueExec: Rule = {
	name: "opaque-exec",
	summary:
		"parallel, rush and rust-parallel run commands built from templates, so what runs cannot be judged",
	matches: (invocation: Invocation): boolean =>
		TEMPLATE_RUNNERS.has(invocation.name),
};
