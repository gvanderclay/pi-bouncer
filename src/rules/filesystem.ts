import { posix } from "node:path";
import { rmOfAgentMade } from "../agent-made.ts";
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
	// A directory the agent made this session is its own to delete.
	matches: (invocation: Invocation, { agentMade }: Where): boolean =>
		isRecursiveRm(invocation) &&
		!(agentMade && rmOfAgentMade(agentMade, invocation)),
};

// A config's `protect` adds to these lists and never removes from them.
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
	"/home",
	"/root",
	"/boot",
	"/lib",
	"/lib64",
	"/srv",
	"/dev",
	"/proc",
	"/sys",
	"/snap",
	"/nix",
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

/** Added by config: `home` names below the home directory, `paths` absolute. */
export type Protect = {
	readonly home: readonly string[];
	readonly paths: readonly string[];
};

// A system directory and its direct children; a home folder itself.
function isProtected(path: string, home: string, extra: Protect): boolean {
	if (path === "/" || path === home) return true;
	const parent = posix.dirname(path);
	const system = [...SYSTEM_DIRS, ...extra.paths];
	if (system.includes(path) || system.includes(parent)) return true;
	const folders = [...HOME_DIRS, ...extra.home];
	return folders.some((name) => posix.join(home, name) === path);
}

const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

// Pure string logic: nothing is read from the filesystem, no symlink is followed.
function resolved(operand: string, { cwd, home }: Where): string {
	const expanded = operand.replace(HOME_PREFIX, () => home);
	return posix.resolve(cwd, expanded);
}

function targetsProtected(
	operand: string,
	where: Where,
	extra: Protect,
): boolean {
	const home = posix.resolve(where.home);
	const glob = /(?:^|\/)\*$/.test(operand);
	const path = resolved(glob ? operand.slice(0, -1) || "." : operand, where);
	return isProtected(path, home, extra);
}

export function rmRootProtecting(extra: Protect): Rule {
	return {
		name: "rm-root",
		summary:
			"recursive rm of a protected path (the filesystem root, a system directory, your home directory, or a path the user's config protects)",
		matches: (invocation: Invocation, where: Where): boolean => {
			if (!isRecursiveRm(invocation)) return false;
			const { args } = invocation;
			if (args.includes("--no-preserve-root")) return true;
			const { operands, afterDashDash = [] } = parseArgs(args);
			return [...operands, ...afterDashDash].some((operand) =>
				targetsProtected(operand, where, extra),
			);
		},
	};
}

export const rmRoot: Rule = rmRootProtecting({ home: [], paths: [] });

// macOS's built-in `trash` (also trash-cli's alias), trash-cli's `trash-put`.
const TRASH_NAMES: readonly string[] = ["trash", "trash-put"];

// `gio trash` is GLib's; `trash-dir` is trash-cli's one option with a value.
function trashOperands(
	invocation: Invocation,
	names: ReadonlySet<string>,
): readonly string[] {
	const { name, args } = invocation;
	const gio = name === "gio" && args[0] === "trash";
	if (!gio && !names.has(name)) return [];
	const rest = gio ? args.slice(1) : args;
	const { operands, afterDashDash = [] } = parseArgs(rest, {
		longValues: ["trash-dir"],
	});
	return [...operands, ...afterDashDash];
}

/** `command`: the config's `trashCommand`, a program name or path. */
export function trashRootFor(extra: Protect, command?: string): Rule {
	const names = new Set(TRASH_NAMES);
	if (command) names.add(posix.basename(command));
	return {
		name: "trash-root",
		summary:
			"moving a protected path (the filesystem root, a system directory, your home directory, or a path the user's config protects) to the trash",
		matches: (invocation: Invocation, where: Where): boolean =>
			trashOperands(invocation, names).some((operand) =>
				targetsProtected(operand, where, extra),
			),
	};
}

export const trashRoot: Rule = trashRootFor({ home: [], paths: [] });

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
