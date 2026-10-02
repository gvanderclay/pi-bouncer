import type { Invocation } from "../scan/walk.ts";
import {
	hasLongOption,
	hasShortFlag,
	isLongOption,
	optionArgs,
} from "./argv.ts";
import { FIND_NAMES, findWith } from "./filesystem.ts";
import type { Rule } from "./rule.ts";

const FIND_EXEC_ACTIONS: readonly string[] = [
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
const FD_NAMES: ReadonlySet<string> = new Set(["fd", "fdfind"]);
const FD_VALUE_LETTERS = "dEteSoxXcjC";

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

// Each substitutes its input into a command template, so what runs is not in the command line.
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

// The argv after a find action, up to its `;` or `+`.
function findArgvs(args: readonly string[]): string[][] {
	return args.flatMap((arg, at) => {
		if (!FIND_EXEC_ACTIONS.includes(arg)) return [];
		const rest = args.slice(at + 1);
		const end = rest.findIndex((word) => word === ";" || word === "+");
		return [end === -1 ? rest : rest.slice(0, end)];
	});
}

// fd's command is the slot's value and every argument after it.
function fdArgv(args: readonly string[], at: number): string[] | undefined {
	const arg = args[at] ?? "";
	for (const name of ["exec", "exec-batch"]) {
		if (!isLongOption(arg, name)) continue;
		const equals = arg.indexOf("=");
		if (equals === -1) return args.slice(at + 1);
		return [arg.slice(equals + 1), ...args.slice(at + 1)];
	}
	if (!/^-[A-Za-z]/.test(arg)) return undefined;
	for (let letter = 1; letter < arg.length; letter += 1) {
		const char = arg.charAt(letter);
		if ("xX".includes(char)) {
			const inline = arg.slice(letter + 1);
			const rest = args.slice(at + 1);
			return inline ? [inline, ...rest] : rest;
		}
		if (FD_VALUE_LETTERS.includes(char)) return undefined;
	}
	return undefined;
}

/**
 * The commands find (`-exec`, `-execdir`, `-ok`, `-okdir`) and fd (`-x`,
 * `-X`, `--exec`, `--exec-batch`) run, which the scan does not peel.
 */
export function hiddenArgvs(invocation: Invocation): string[][] {
	const { name, args } = invocation;
	if (FIND_NAMES.has(name)) return findArgvs(args);
	if (!FD_NAMES.has(name)) return [];
	return optionArgs(args).flatMap((_, at) => {
		const argv = fdArgv(args, at);
		return argv && argv.length > 0 ? [argv] : [];
	});
}
