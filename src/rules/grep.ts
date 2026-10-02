// Also matches grep in find's and fd's command slot, which the scan does not peel.
import { commandName } from "../scan/normalize.ts";
import type { Invocation } from "../scan/walk.ts";
import { isLongOption, optionArgs } from "./argv.ts";
import { FIND_NAMES } from "./filesystem.ts";
import {
	FD_NAMES,
	FD_VALUE_LETTERS,
	FIND_EXEC_ACTIONS,
} from "./hidden-exec.ts";
import type { Rule } from "./rule.ts";

const GREP_NAMES: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep"]);

function isGrep(word: string | undefined): boolean {
	return word !== undefined && GREP_NAMES.has(commandName(word));
}

function findCommands(args: readonly string[]): (string | undefined)[] {
	return args.flatMap((arg, at) =>
		FIND_EXEC_ACTIONS.includes(arg) ? [args[at + 1]] : [],
	);
}

function fdSlot(arg: string, next: string | undefined): string | undefined {
	for (const name of ["exec", "exec-batch"]) {
		if (!isLongOption(arg, name)) continue;
		const equals = arg.indexOf("=");
		return equals === -1 ? next : arg.slice(equals + 1);
	}
	if (!/^-[A-Za-z]/.test(arg)) return undefined;
	for (let at = 1; at < arg.length; at += 1) {
		const letter = arg.charAt(at);
		if ("xX".includes(letter)) return arg.slice(at + 1) || next;
		if (FD_VALUE_LETTERS.includes(letter)) return undefined;
	}
	return undefined;
}

function fdCommands(args: readonly string[]): (string | undefined)[] {
	return optionArgs(args).map((arg, at) => fdSlot(arg, args[at + 1]));
}

export const grep: Rule = {
	name: "grep",
	summary: "grep is not allowed here",
	matches: ({ name, args }: Invocation): boolean => {
		if (GREP_NAMES.has(name)) return true;
		if (FIND_NAMES.has(name)) return findCommands(args).some(isGrep);
		if (FD_NAMES.has(name)) return fdCommands(args).some(isGrep);
		return false;
	},
};

export const grepInstead =
	"Run the search with rg instead: it is recursive and uses regex by default; add -F for a fixed string and -n for line numbers.";
