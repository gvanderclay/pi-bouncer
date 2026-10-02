import type { Invocation } from "../scan/walk.ts";
import type { Rule } from "./rule.ts";

const DOWNLOADERS: ReadonlySet<string> = new Set(["curl", "wget"]);

// How an interpreter's arguments say where its program comes from (per each tool's help).
type Interpreter = {
	readonly inline: string;
	readonly inlineLongs?: readonly string[];
	/** Short options whose value is the next argument when last in a cluster. */
	readonly values?: string;
	readonly stdin?: string;
	/** A shell: `+o` is an option, and a lone `-` ends options like `--`. */
	readonly shell?: boolean;
};

const SHELL: Interpreter = {
	inline: "c",
	values: "oO",
	stdin: "s",
	shell: true,
};
const PYTHON: Interpreter = { inline: "cm", values: "WX" };
const NODE: Interpreter = {
	inline: "ep",
	inlineLongs: ["eval", "print"],
	values: "rC",
};
const INTERPRETERS: ReadonlyMap<string, Interpreter> = new Map([
	["sh", SHELL],
	["bash", SHELL],
	["zsh", SHELL],
	["dash", SHELL],
	["ksh", SHELL],
	// fish(1): -C, -d, -o, -f and -p take values. Taken from the man page, not
	// probed, so letters are over-included: a wrongly consumed script means a deny.
	["fish", { ...SHELL, inlineLongs: ["command"], values: "Cdofp" }],
	["python", PYTHON],
	["python2", PYTHON],
	["python3", PYTHON],
	["node", NODE],
	["nodejs", NODE],
	// perl -h: only -I also takes a separate value (probed: `perl -F x` opens x).
	["perl", { inline: "eE", values: "I" }],
	["ruby", { inline: "e", values: "ICEr" }],
	// Run a file in the current shell: no options.
	["source", { inline: "" }],
	[".", { inline: "" }],
]);

function interpreter(name: string): Interpreter | undefined {
	return /^python3\.\d+$/.test(name)
		? INTERPRETERS.get("python3")
		: INTERPRETERS.get(name);
}

const STDIN_PATHS: ReadonlySet<string> = new Set([
	"-",
	"/dev/stdin",
	"/dev/fd/0",
	"/proc/self/fd/0",
]);

function isStdin(operand: string | undefined): boolean {
	return operand === undefined || STDIN_PATHS.has(operand);
}

type Reading = "inline" | "stdin" | "next" | "option";

function readCluster(tool: Interpreter, cluster: string): Reading {
	for (let at = 1; at < cluster.length; at += 1) {
		const letter = cluster.charAt(at);
		if (cluster.startsWith("-") && tool.inline.includes(letter)) {
			return "inline";
		}
		if (tool.stdin?.includes(letter)) return "stdin";
		// The rest of the cluster is the value; a last letter takes the next argument.
		if (tool.values?.includes(letter)) {
			return at === cluster.length - 1 ? "next" : "option";
		}
	}
	return "option";
}

function readLong(tool: Interpreter, arg: string): Reading {
	const name = arg.slice(2).split("=", 1)[0] ?? "";
	if (tool.inlineLongs?.includes(name)) return "inline";
	return arg.includes("=") ? "option" : "next";
}

function isCluster(tool: Interpreter, arg: string): boolean {
	return /^-./.test(arg) || (tool.shell === true && /^\+./.test(arg));
}

function readArg(tool: Interpreter, arg: string): Reading | "end" | "operand" {
	if (arg === "--" || (arg === "-" && tool.shell)) return "end";
	if (arg === "-") return "stdin";
	if (arg.startsWith("--")) return readLong(tool, arg);
	return isCluster(tool, arg) ? readCluster(tool, arg) : "operand";
}

function readsProgramFromStdin(
	tool: Interpreter,
	args: readonly string[],
): boolean {
	for (let at = 0; at < args.length; at += 1) {
		const arg = args[at] ?? "";
		switch (readArg(tool, arg)) {
			case "end":
				return isStdin(args[at + 1]);
			case "operand":
				return isStdin(arg);
			case "inline":
				return false;
			case "stdin":
				return true;
			case "next":
				at += 1;
				break;
			case "option":
				break;
		}
	}
	return true;
}

function hasDownloader(invocations: readonly Invocation[]): boolean {
	return invocations.some((invocation) => DOWNLOADERS.has(invocation.name));
}

function pipeForm(invocation: Invocation, tool: Interpreter): boolean {
	return (
		hasDownloader(invocation.upstream) &&
		readsProgramFromStdin(tool, invocation.args)
	);
}

function substitutionForm(invocation: Invocation): boolean {
	return hasDownloader(invocation.substitutions);
}

export const remoteScript: Rule = {
	name: "remote-script",
	summary:
		"a downloaded script fed into a shell or interpreter runs unreviewed code",
	matches: (invocation: Invocation): boolean => {
		if (invocation.name === "eval") return substitutionForm(invocation);
		const tool = interpreter(invocation.name);
		if (!tool) return false;
		return pipeForm(invocation, tool) || substitutionForm(invocation);
	},
};
