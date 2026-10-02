import { AGENT_VARIABLES } from "../agent-env.ts";
import { commandName } from "../scan/normalize.ts";
import type { Invocation } from "../scan/walk.ts";
import type { EnvParts } from "../scan/wrappers.ts";
import { ENV_SHORT_VALUES, envParts } from "../scan/wrappers.ts";
import { hasShortFlag, isLongOption, optionArgs } from "./argv.ts";
import type { Rule } from "./rule.ts";

function startsYolo(invocation: Invocation): boolean {
	return (
		invocation.name === "pi" &&
		optionArgs(invocation.args).some(
			(arg) => arg === "--yolo" || arg.startsWith("--yolo="),
		)
	);
}

const DECLARERS: ReadonlySet<string> = new Set([
	"export",
	"declare",
	"typeset",
	"readonly",
	"local",
]);

function isVariable(name: string): boolean {
	return (AGENT_VARIABLES as readonly string[]).includes(name);
}

// `VAR` or `VAR=value`.
function namesVariable(arg: string): boolean {
	return isVariable(arg.split("=", 1)[0] ?? "");
}

function setsVariable(invocation: Invocation): boolean {
	if (invocation.assignments.some(isVariable)) return true;
	if (invocation.name === "env") {
		return envParts(invocation.args).assignments.some(namesVariable);
	}
	return DECLARERS.has(invocation.name) && invocation.args.some(namesVariable);
}

// The value of each `env -u VAR`, `-uVAR` and `--unset[=]VAR`.
function unsetValues(args: readonly string[]): string[] {
	const values: string[] = [];
	args.forEach((arg, at) => {
		if (isLongOption(arg, "unset")) {
			values.push(
				arg.includes("=")
					? arg.slice(arg.indexOf("=") + 1)
					: (args[at + 1] ?? ""),
			);
		} else if (/^-[A-Za-z]/.test(arg) && arg.includes("u")) {
			const rest = arg.slice(arg.indexOf("u") + 1);
			values.push(rest === "" ? (args[at + 1] ?? "") : rest);
		}
	});
	return values;
}

// The command env runs: its operand, or the first word of its -S string
// after any NAME=value words.
function runsPi({ command, split }: EnvParts): boolean {
	const words = split?.split(/\s+/).filter((word) => word !== "") ?? [];
	const first = command[0] ?? words.find((word) => !/^\w+=/.test(word));
	return first !== undefined && commandName(first) === "pi";
}

// `env -i` or `env -` running pi: the profile variables are gone.
function clearsEnvironmentForPi(parts: EnvParts): boolean {
	const { options } = parts;
	const clears =
		options.includes("-") ||
		hasShortFlag(options, "i", ENV_SHORT_VALUES) ||
		options.some((arg) => isLongOption(arg, "ignore-environment"));
	return clears && runsPi(parts);
}

function clearsVariable(invocation: Invocation): boolean {
	if (invocation.name === "unset") return invocation.args.some(isVariable);
	if (invocation.name !== "env") return false;
	const parts = envParts(invocation.args);
	return (
		unsetValues(optionArgs(parts.options)).some(isVariable) ||
		clearsEnvironmentForPi(parts)
	);
}

export const bouncerEscape: Rule = {
	name: "bouncer-escape",
	summary:
		"starting pi with --yolo, or choosing a bouncer profile, from bash sidesteps the user's rules",
	matches: (invocation: Invocation): boolean =>
		startsYolo(invocation) ||
		setsVariable(invocation) ||
		clearsVariable(invocation),
};
