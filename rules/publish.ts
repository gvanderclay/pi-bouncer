// Releasing packages publicly, and deleting GitHub repositories or releases.
import type { Invocation } from "../scan/walk.ts";
import { type OptionSpec, type ParsedArgs, parseArgs } from "./argv.ts";
import type { Rule } from "./rule.ts";

// Options before the subcommand that take a value (`npm help publish`,
// `pnpm help publish`, `cargo --help`). Yarn has none that matter here.
const SPECS: ReadonlyMap<string, OptionSpec> = new Map([
	[
		"npm",
		{
			shortValues: "wC",
			longValues: [
				"prefix",
				"workspace",
				"registry",
				"tag",
				"otp",
				"access",
				"userconfig",
				"cache",
			],
		},
	],
	[
		"pnpm",
		{
			shortValues: "CF",
			longValues: ["dir", "filter", "tag", "access", "otp", "registry"],
		},
	],
	["yarn", {}],
	["cargo", { shortValues: "CZ", longValues: ["config", "color"] }],
]);

/** A dry run releases nothing: exactly `--dry-run` (and cargo's `-n`). */
function isDryRun(name: string, parsed: ParsedArgs): boolean {
	return (
		parsed.longs.includes("dry-run") ||
		(name === "cargo" && parsed.shorts.includes("n"))
	);
}

/**
 * Yarn 1 runs `yarn publish`, also as `yarn workspace <name> publish`; Yarn 2+
 * runs `yarn npm publish`, also after `yarn workspace <name>` or
 * `yarn workspaces foreach …`.
 */
function yarnPublishes(operands: readonly string[]): boolean {
	return operands.some(
		(operand, at) =>
			operand === "publish" &&
			(at === 0 ||
				operands[at - 1] === "npm" ||
				(at === 2 && operands[0] === "workspace")),
	);
}

function publishes(name: string, operands: readonly string[]): boolean {
	if (name === "yarn") return yarnPublishes(operands);
	// cargo accepts a leading `+toolchain`.
	const [first, second] = operands;
	return (
		(name === "cargo" && first?.startsWith("+") ? second : first) === "publish"
	);
}

export const publish: Rule = {
	name: "publish",
	summary: "publishing releases a package publicly, which cannot be undone",
	matches: ({ name, args }: Invocation): boolean => {
		const spec = SPECS.get(name);
		if (!spec) return false;
		const parsed = parseArgs(args, spec);
		return publishes(name, parsed.operands) && !isDryRun(name, parsed);
	},
};

const GH_DELETES: ReadonlySet<string> = new Set([
	"repo delete",
	"release delete",
]);

export const ghDelete: Rule = {
	name: "gh-delete",
	summary: "deleting a GitHub repository or release destroys it for everyone",
	matches: ({ name, args }: Invocation): boolean => {
		if (name !== "gh") return false;
		// `gh release --help`: `-R, --repo` is a group flag, given before or after the verb.
		const [group, verb] = parseArgs(args, {
			shortValues: "R",
			longValues: ["repo"],
		}).operands;
		return GH_DELETES.has(`${group} ${verb}`);
	},
};
