// Rules a config file defines under `rules`: a program name, words that must
// follow it in order, and a level, or an `instead` text for a steer rule.
import { argvOf } from "../always-ask.ts";
import { isObject } from "../json.ts";
import { commandName } from "../scan/normalize.ts";
import type { Invocation } from "../scan/walk.ts";
import type { ConfigLevel } from "../verdict.ts";
import { builtInEntries } from "./built-in-policy.ts";
import { hiddenArgvs } from "./hidden-exec.ts";
import type { PolicyEntry, Rule } from "./rule.ts";

export type CustomRule = {
	readonly name: string;
	readonly command: readonly string[];
	readonly args: readonly string[];
	readonly summary: string;
	readonly level: ConfigLevel;
	/** Only on a steer rule: what the deny tells the model to do. */
	readonly instead?: string;
};

function inOrder(argv: readonly string[], words: readonly string[]): boolean {
	let found = 0;
	for (const word of argv) if (word === words[found]) found += 1;
	return found === words.length;
}

export function customRule({ name, command, args, summary }: CustomRule): Rule {
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

/** The rule's policy entry; undefined when it is off. */
export function customEntry(custom: CustomRule): PolicyEntry | undefined {
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
	"level",
	"summary",
	"instead",
]);

// The problem with one entry, or "" when it is valid.
function entryProblem(entry: Readonly<Record<string, unknown>>): string {
	const { name, command, args = [], summary, instead, level } = entry;
	const extra = Object.keys(entry).find((key) => !KEYS.has(key));
	if (extra) return `unknown key "${extra}"`;
	if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
		return '"name" must be lowercase letters, digits and dashes';
	}
	if (builtInEntries.has(name) || name === "always-ask") {
		return `"${name}" is a built-in rule's name`;
	}
	const commandOk =
		isText(command) || (isTextList(command) && command.length > 0);
	if (!commandOk) return '"command" must be a program name or a list of them';
	if (!isTextList(args)) return '"args" must be a list of words';
	if (!isText(summary)) return '"summary" must be a sentence';
	if (instead !== undefined && !isText(instead)) {
		return '"instead" must be a sentence';
	}
	const levels =
		instead === undefined ? ["ask", "deny", "off"] : ["deny", "off"];
	if (level !== undefined && !levels.includes(level as string)) {
		return `"level" must be ${levels.map((l) => `"${l}"`).join(", ")}`;
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
		const problem = isObject(entry) ? entryProblem(entry) : "is not an object";
		const name = isObject(entry) ? entry["name"] : undefined;
		if (!problem && rules.some((rule) => rule.name === name)) {
			problems.push(`rules[${at}]: "${name}" is defined twice`);
		} else if (problem) {
			problems.push(`rules[${at}]: ${problem}`);
		} else {
			rules.push(asRule(entry as Readonly<Record<string, unknown>>));
		}
	});
	return rules;
}

function asRule(entry: Readonly<Record<string, unknown>>): CustomRule {
	const { command, args = [], instead, level } = entry;
	return {
		name: entry["name"] as string,
		command: typeof command === "string" ? [command] : (command as string[]),
		args: args as string[],
		summary: entry["summary"] as string,
		level: (level ?? (instead === undefined ? "ask" : "deny")) as ConfigLevel,
		...(instead !== undefined && { instead: instead as string }),
	};
}

/**
 * A project's rules beside the user's: a name the user config already uses is
 * refused, and so is an untrusted project's steer rule, whose text reaches
 * the model.
 */
export function projectRules(
	rules: readonly CustomRule[],
	userRules: readonly CustomRule[],
	trusted: boolean,
	problems: string[],
): CustomRule[] {
	return rules.filter(({ name, instead }) => {
		if (userRules.some((rule) => rule.name === name)) {
			problems.push(`rules: "${name}" is already a rule in the user config`);
			return false;
		}
		if (instead !== undefined && !trusted) {
			problems.push(
				`rules: "${name}" is a steer rule, and the project is not trusted`,
			);
			return false;
		}
		return true;
	});
}
