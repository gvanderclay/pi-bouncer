// Pushes that overwrite or delete history on a remote.
import type { Invocation } from "../scan/walk.ts";
import { givesLong, type ParsedArgs, parseArgs } from "./argv.ts";
import { gitCommand } from "./git.ts";
import type { Rule } from "./rule.ts";

/**
 * The parsed arguments of a real (not dry-run) `git push`. `man git-push`:
 * `-n, --dry-run`; `-o <option>, --push-option=<option>`.
 */
function pushArgs(invocation: Invocation): ParsedArgs | undefined {
	const git = gitCommand(invocation);
	if (git?.subcommand !== "push") return undefined;
	const parsed = parseArgs(git.args, {
		shortValues: "o",
		longValues: ["push-option", "repo", "receive-pack", "exec"],
	});
	const dryRun =
		parsed.shorts.includes("n") || parsed.longs.includes("dry-run");
	return dryRun ? undefined : parsed;
}

/** Every operand, before and after `--`: the repository and the refspecs. */
function operands(parsed: ParsedArgs): readonly string[] {
	return [...parsed.operands, ...(parsed.afterDashDash ?? [])];
}

export const gitPushForce: Rule = {
	name: "git-push-force",
	summary: "a force or mirror push overwrites history on the remote",
	matches: (invocation: Invocation): boolean => {
		const parsed = pushArgs(invocation);
		if (!parsed) return false;
		return (
			parsed.shorts.includes("f") ||
			givesLong(parsed, "force") ||
			givesLong(parsed, "mirror") ||
			operands(parsed).some((operand) => operand.startsWith("+"))
		);
	},
};

export const gitPushDelete: Rule = {
	name: "git-push-delete",
	summary:
		"deleting or pruning remote refs destroys branches and tags on the remote",
	matches: (invocation: Invocation): boolean => {
		const parsed = pushArgs(invocation);
		if (!parsed) return false;
		return (
			parsed.shorts.includes("d") ||
			givesLong(parsed, "delete") ||
			givesLong(parsed, "prune") ||
			operands(parsed).some((operand) => /^:./.test(operand))
		);
	},
};
