// Rules a config file defines under `rules`: a program name and words that
// must follow it in order, or path globs for Pi's file tools; then a level, or
// an `instead` text for a steer rule.
import { argvOf } from "../always-ask.ts";
import { isObject } from "../json.ts";
import type { PathLevels } from "../project-config.ts";
import { commandName } from "../scan/normalize.ts";
import type { Invocation } from "../scan/walk.ts";
import type { ConfigLevel } from "../verdict.ts";
import { builtInEntries } from "./built-in-policy.ts";
import { hiddenArgvs } from "./hidden-exec.ts";
import { compilePattern } from "./path-patterns.ts";
import type {
	PathEntry,
	PathLevel,
	PathRule,
	PolicyEntry,
	Rule,
} from "./rule.ts";

export type CommandRule = {
	readonly name: string;
	readonly command: readonly string[];
	readonly args: readonly string[];
	readonly summary: string;
	readonly level: ConfigLevel;
	/** Only on a steer rule: what the deny tells the model to do. */
	readonly instead?: string;
};

export type CustomPathRule = {
	readonly name: string;
	readonly paths: readonly string[];
	readonly summary: string;
	/** A plain level sets both directions; a direction an object leaves out is off. */
	readonly level: PathLevel | PathLevels;
	/** Only on a steer rule: what the deny tells the model to do. */
	readonly instead?: string;
	/** Set on an untrusted project's rule: it can only make a path stricter. */
	readonly raiseOnly?: true;
};

export type CustomRule = CommandRule | CustomPathRule;

function inOrder(argv: readonly string[], words: readonly string[]): boolean {
	let found = 0;
	for (const word of argv) if (word === words[found]) found += 1;
	return found === words.length;
}

export function customRule({
	name,
	command,
	args,
	summary,
}: CommandRule): Rule {
	const names = new Set(command.map(commandName));
	const hit = ([program, ...rest]: readonly string[]): boolean =>
		program !== undefined &&
		names.has(commandName(program)) &&
		inOrder(rest, args);
	return {
		name,
		summary,
		matches: (invocation: Invocation): boolean =>
			hit(argvOf(invocation)) || hiddenArgvs(invocation).some(hit),
	};
}

export function customPathRule({
	name,
	paths,
	summary,
}: CustomPathRule): PathRule {
	// validRules has compiled every pattern already.
	const patterns = paths.flatMap((path) => compilePattern(path) ?? []);
	return { name, summary, patterns };
}

/** The rule as `/bouncer` lists it when it is off. */
export function offRule(custom: CustomRule): Rule | PathRule {
	return "paths" in custom ? customPathRule(custom) : customRule(custom);
}

function pathEntry(custom: CustomPathRule): PathEntry | undefined {
	const { level, instead, raiseOnly } = custom;
	const named: PathLevels =
		typeof level === "string" ? { read: level, write: level } : level;
	const levels = { read: named.read ?? "off", write: named.write ?? "off" };
	if (levels.read === "off" && levels.write === "off") return undefined;
	return {
		kind: "path",
		rule: customPathRule(custom),
		levels,
		...(instead !== undefined && { instead }),
		...(raiseOnly && { raiseOnly }),
	};
}

/** The rule's policy entry; undefined when it is off. */
export function customEntry(custom: CustomRule): PolicyEntry | undefined {
	if ("paths" in custom) return pathEntry(custom);
	const rule = customRule(custom);
	const { level, instead } = custom;
	if (level === "off") return undefined;
	if (instead !== undefined) {
		return { kind: "steer", rule, instead, level: "deny" };
	}
	return { kind: "rule", rule, level };
}

function isText(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function isTextList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isText);
}

const KEYS = new Set([
	"name",
	"command",
	"args",
	"paths",
	"level",
	"summary",
	"instead",
]);

function listed(levels: readonly string[]): string {
	return levels.map((l) => `"${l}"`).join(", ");
}

// A path rule's level: one of `allowed`, or an object naming "read" and/or
// "write" with one of `allowed` each.
function pathLevelOk(level: unknown, allowed: readonly string[]): boolean {
	if (typeof level === "string") return allowed.includes(level);
	if (!isObject(level)) return false;
	const given = Object.entries(level);
	return (
		given.length > 0 &&
		given.every(
			([key, value]) =>
				(key === "read" || key === "write") &&
				allowed.includes(value as string),
		)
	);
}

function commandProblem(entry: Readonly<Record<string, unknown>>): string {
	const { command, args = [], instead, level } = entry;
	const commandOk =
		isText(command) || (isTextList(command) && command.length > 0);
	if (!commandOk) return '"command" must be a program name or a list of them';
	if (!isTextList(args)) return '"args" must be a list of words';
	if (!isText(entry["summary"])) return '"summary" must be a sentence';
	if (instead !== undefined && !isText(instead)) {
		return '"instead" must be a sentence';
	}
	const levels =
		instead === undefined ? ["ask", "deny", "off"] : ["deny", "off"];
	if (level !== undefined && !levels.includes(level as string)) {
		return `"level" must be ${listed(levels)}`;
	}
	return "";
}

function pathProblem(entry: Readonly<Record<string, unknown>>): string {
	const { paths, instead, level } = entry;
	if (!isTextList(paths) || paths.length === 0) {
		return '"paths" must be a list of path patterns';
	}
	if (entry["args"] !== undefined) {
		return '"args" is only for a rule with "command"';
	}
	if (!isText(entry["summary"])) return '"summary" must be a sentence';
	if (instead !== undefined && !isText(instead)) {
		return '"instead" must be a sentence';
	}
	const levels =
		instead === undefined ? ["allow", "ask", "deny", "off"] : ["deny", "off"];
	if (level !== undefined && !pathLevelOk(level, levels)) {
		return `"level" must be ${listed(levels)}, or an object with "read" and/or "write"`;
	}
	return "";
}

// The problem with entry `at`, or "" when it is valid.
function entryProblem(entry: unknown, at: number): string {
	const here = `rules[${at}]`;
	if (!isObject(entry)) return `${here}: is not an object`;
	const { name, command, paths } = entry;
	const extra = Object.keys(entry).find((key) => !KEYS.has(key));
	if (extra) return `${here}: unknown key "${extra}"`;
	if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
		return `${here}: "name" must be lowercase letters, digits and dashes`;
	}
	if (paths !== undefined && name.startsWith("path-")) {
		return `rules: "${name}": names starting with "path-" are kept for built-in path groups`;
	}
	if (builtInEntries.has(name) || name === "always-ask") {
		return `${here}: "${name}" is a built-in rule's name`;
	}
	if (command !== undefined && paths !== undefined) {
		return `${here}: a rule takes "command" or "paths", not both`;
	}
	const problem =
		paths === undefined ? commandProblem(entry) : pathProblem(entry);
	if (problem) return `${here}: ${problem}`;
	const bad = isTextList(paths)
		? paths.find((path) => compilePattern(path) === undefined)
		: undefined;
	if (bad !== undefined) {
		return `rules: "${name}": path pattern "${bad}" is not valid`;
	}
	return "";
}

/** Valid entries; each invalid one is a problem and is skipped whole. */
export function validRules(value: unknown, problems: string[]): CustomRule[] {
	if (!Array.isArray(value)) {
		problems.push('"rules" is not a list');
		return [];
	}
	const rules: CustomRule[] = [];
	value.forEach((entry: unknown, at) => {
		const problem = entryProblem(entry, at);
		const name = isObject(entry) ? entry["name"] : undefined;
		if (!problem && rules.some((rule) => rule.name === name)) {
			problems.push(`rules[${at}]: "${name}" is defined twice`);
		} else if (problem) {
			problems.push(problem);
		} else {
			rules.push(asRule(entry as Readonly<Record<string, unknown>>));
		}
	});
	return rules;
}

function asRule(entry: Readonly<Record<string, unknown>>): CustomRule {
	const { command, paths, args = [], instead, level } = entry;
	const common = {
		name: entry["name"] as string,
		summary: entry["summary"] as string,
		...(instead !== undefined && { instead: instead as string }),
	};
	const fallback = instead === undefined ? "ask" : "deny";
	if (paths !== undefined) {
		return {
			...common,
			paths: paths as string[],
			level: (level ?? fallback) as PathLevel | PathLevels,
		};
	}
	return {
		...common,
		command: typeof command === "string" ? [command] : (command as string[]),
		args: args as string[],
		level: (level ?? fallback) as ConfigLevel,
	};
}

// Whether a path rule names `allow` in either direction.
function allows({ level }: CustomPathRule): boolean {
	return typeof level === "string"
		? level === "allow"
		: level.read === "allow" || level.write === "allow";
}

/**
 * A project's rules beside the user's: a name the user config already uses is
 * refused, and so is an untrusted project's steer rule, whose text reaches
 * the model, and its `allow` path rule. An untrusted project's path rules are
 * raise-only, so an `ask` cannot lower a deny before it.
 */
export function projectRules(
	rules: readonly CustomRule[],
	userRules: readonly CustomRule[],
	trusted: boolean,
	problems: string[],
): CustomRule[] {
	return rules.flatMap((rule): CustomRule[] => {
		const { name, instead } = rule;
		if (userRules.some((user) => user.name === name)) {
			problems.push(`rules: "${name}" is already a rule in the user config`);
			return [];
		}
		if (trusted) return [rule];
		if (instead !== undefined) {
			problems.push(
				`rules: "${name}" is a steer rule, and the project is not trusted`,
			);
			return [];
		}
		if (!("paths" in rule)) return [rule];
		if (allows(rule)) {
			problems.push(
				`rules: "${name}" allows a path, and the project is not trusted`,
			);
			return [];
		}
		return [{ ...rule, raiseOnly: true }];
	});
}
