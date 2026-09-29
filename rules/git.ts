// git operations that throw away uncommitted or stashed work.
import type { Invocation } from "../scan/walk.ts";
import {
	givesLong,
	type OptionSpec,
	type ParsedArgs,
	parseArgs,
} from "./argv.ts";
import type { Rule } from "./rule.ts";

/** A git subcommand and the arguments after it. */
export type GitCommand = {
	readonly subcommand: string;
	readonly args: readonly string[];
};

// Global options that take a separate value (`man git` SYNOPSIS, git 2.55.0).
// `--opt=value` forms are one argument; any other option is a bare flag.
const GLOBAL_VALUES: ReadonlySet<string> = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--attr-source",
]);

/** The subcommand of a `git` invocation, skipping git's global options. */
export function gitCommand(invocation: Invocation): GitCommand | undefined {
	if (invocation.name !== "git") return undefined;
	const { args } = invocation;
	for (let at = 0; at < args.length; at += 1) {
		const arg = args[at] ?? "";
		if (!arg.startsWith("-")) {
			return { subcommand: arg, args: args.slice(at + 1) };
		}
		if (GLOBAL_VALUES.has(arg)) at += 1;
	}
	return undefined;
}

/** The parsed arguments of `git <subcommand>`, or undefined for anything else. */
function gitArgs(
	invocation: Invocation,
	subcommand: string,
	spec?: OptionSpec,
): ParsedArgs | undefined {
	const git = gitCommand(invocation);
	return git?.subcommand === subcommand ? parseArgs(git.args, spec) : undefined;
}

/** `git clean` deletes unless it is a dry run (it may run without -f when clean.requireForce is off). */
function cleanDeletes(parsed: ParsedArgs): boolean {
	return !(parsed.shorts.includes("n") || parsed.longs.includes("dry-run"));
}

export const gitClean: Rule = {
	name: "git-clean",
	summary: "git clean deletes untracked files for good",
	matches: (invocation: Invocation): boolean => {
		const parsed = gitArgs(invocation, "clean", {
			shortValues: "e",
			longValues: ["exclude"],
		});
		return parsed !== undefined && cleanDeletes(parsed);
	},
};

export const gitResetHard: Rule = {
	name: "git-reset-hard",
	summary: "git reset --hard discards uncommitted changes",
	matches: (invocation: Invocation): boolean => {
		const parsed = gitArgs(invocation, "reset");
		return parsed !== undefined && givesLong(parsed, "hard");
	},
};

const WHOLE_TREE: ReadonlySet<string> = new Set([".", "./", ":/", ":/:", "*"]);

function isWholeTree(operand: string): boolean {
	return WHOLE_TREE.has(operand) || operand.startsWith(":(");
}

function checkoutDiscards(parsed: ParsedArgs): boolean {
	return (
		(parsed.afterDashDash?.length ?? 0) > 0 ||
		parsed.shorts.includes("f") ||
		givesLong(parsed, "force") ||
		givesLong(parsed, "pathspec-from-file") ||
		parsed.operands.some(isWholeTree)
	);
}

function switchDiscards(parsed: ParsedArgs): boolean {
	return (
		parsed.shorts.includes("f") ||
		givesLong(parsed, "force") ||
		givesLong(parsed, "discard-changes")
	);
}

export const gitCheckoutDiscard: Rule = {
	name: "git-checkout-discard",
	summary:
		"checking out paths or forcing a checkout discards working-tree changes",
	matches: (invocation: Invocation): boolean => {
		const checkout = gitArgs(invocation, "checkout", {
			shortValues: "bB",
			longValues: ["orphan", "conflict"],
		});
		if (checkout) return checkoutDiscards(checkout);
		const switched = gitArgs(invocation, "switch", {
			shortValues: "cC",
			longValues: ["create", "force-create", "orphan", "conflict"],
		});
		return switched !== undefined && switchDiscards(switched);
	},
};

/** Only unstaging: staged exactly, and no worktree flag. */
function onlyUnstages(parsed: ParsedArgs): boolean {
	const staged = parsed.shorts.includes("S") || parsed.longs.includes("staged");
	const worktree = parsed.shorts.includes("W") || givesLong(parsed, "worktree");
	return staged && !worktree;
}

export const gitRestoreWorktree: Rule = {
	name: "git-restore-worktree",
	summary: "git restore of the working tree discards uncommitted changes",
	matches: (invocation: Invocation): boolean => {
		const parsed = gitArgs(invocation, "restore", {
			shortValues: "s",
			longValues: ["source", "pathspec-from-file"],
		});
		return parsed !== undefined && !onlyUnstages(parsed);
	},
};

const STASH_DESTROY: ReadonlySet<string> = new Set(["drop", "clear"]);

export const gitStashDestroy: Rule = {
	name: "git-stash-destroy",
	summary: "git stash drop and clear destroy stashed work",
	matches: (invocation: Invocation): boolean => {
		const verb = gitArgs(invocation, "stash")?.operands[0];
		return verb !== undefined && STASH_DESTROY.has(verb);
	},
};
