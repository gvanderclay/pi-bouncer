import { posix } from "node:path";
import type { Invocation } from "../scan/walk.ts";
import { hasLongOption, hasShortFlag, parseArgs } from "./argv.ts";
import type { Rule, Where } from "./rule.ts";

// `grm` is GNU rm from Homebrew coreutils (`grm --version`: "rm (GNU coreutils)").
const RM_NAMES = new Set(["rm", "grm"]);

function isRecursiveRm(invocation: Invocation): boolean {
	return (
		RM_NAMES.has(invocation.name) &&
		(hasShortFlag(invocation.args, "rR") ||
			hasLongOption(invocation.args, "recursive"))
	);
}

export const recursiveRm: Rule = {
	name: "recursive-rm",
	summary: "recursive rm deletes whole directory trees",
	matches: isRecursiveRm,
};

// Fixed: the bouncer config cannot extend it.
const SYSTEM_DIRS: readonly string[] = [
	"/usr",
	"/etc",
	"/bin",
	"/sbin",
	"/var",
	"/opt",
	"/System",
	"/Library",
	"/Applications",
	"/Users",
	"/private",
];

const HOME_DIRS: readonly string[] = [
	"Desktop",
	"Documents",
	"Downloads",
	"Pictures",
	"Movies",
	"Music",
	"Library",
	"Applications",
	"workspace",
	".config",
	".local",
	"pi",
	".pi",
	".ssh",
	".gnupg",
	".aws",
	".kube",
	".docker",
];

function isProtected(path: string, home: string): boolean {
	if (path === "/" || path === home) return true;
	const parent = posix.dirname(path);
	if (SYSTEM_DIRS.includes(path) || SYSTEM_DIRS.includes(parent)) return true;
	return parent === home && HOME_DIRS.includes(posix.basename(path));
}

const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

// Pure string logic: nothing is read from the filesystem, no symlink is followed.
function resolved(operand: string, { cwd, home }: Where): string {
	const expanded = operand.replace(HOME_PREFIX, () => home);
	return posix.resolve(cwd, expanded);
}

function targetsProtected(operand: string, where: Where): boolean {
	const home = posix.resolve(where.home);
	const glob = /(?:^|\/)\*$/.test(operand);
	const path = resolved(glob ? operand.slice(0, -1) || "." : operand, where);
	return isProtected(path, home);
}

export const rmRoot: Rule = {
	name: "rm-root",
	summary:
		"recursive rm of the filesystem root, a system directory or your home directory",
	matches: (invocation: Invocation, where: Where): boolean => {
		if (!isRecursiveRm(invocation)) return false;
		const { args } = invocation;
		if (args.includes("--no-preserve-root")) return true;
		const { operands, afterDashDash = [] } = parseArgs(args);
		return [...operands, ...afterDashDash].some((operand) =>
			targetsProtected(operand, where),
		);
	},
};

export const FIND_NAMES: ReadonlySet<string> = new Set(["find", "gfind"]);

// `gfind` is GNU findutils from Homebrew.
export function findWith(
	invocation: Invocation,
	words: readonly string[],
): boolean {
	return (
		FIND_NAMES.has(invocation.name) &&
		invocation.args.some((arg) => words.includes(arg))
	);
}

export const findDelete: Rule = {
	name: "find-delete",
	summary: "find -delete deletes every file it matches",
	matches: (invocation: Invocation): boolean =>
		findWith(invocation, ["-delete"]),
};
