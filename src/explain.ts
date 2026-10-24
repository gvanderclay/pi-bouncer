// Replays a command under the same config as the live bouncer. It opens no
// dialog, calls no judge, reads no git and never runs the command.
//
//   node explain.ts 'rm -rf x'
//   jq -r .command record.json | node explain.ts -
//   node explain.ts --json 'sudo ls'
//   node explain.ts --agent-dir "$HOME/.pi/agent" --cwd /repo 'sudo ls'
//   node explain.ts --agent scout 'rm -rf x'
//   node explain.ts --untrusted 'git push --force'
//   node explain.ts read ~/.ssh/id_ed25519
//   node explain.ts write .git/config
//   node explain.ts grep ~
//
// A first word of `read`, `write`, `grep`, `find` or `ls` with a path after
// it replays a file call; a tool word on its own, or `--` before the command,
// keeps the bash meaning.
// Agent dir: `PI_CODING_AGENT_DIR` or `~/.pi/agent`; project: the current
// directory, unless `--agent-dir` or `--cwd` say otherwise. Trust: `--trusted` or
// `--untrusted`, else Pi's saved decision in the agent dir's `trust.json` (none
// is untrusted); without Pi's package it refuses to guess. Profile: `--agent
// <name>` replays under that agent's profile; without it the normal rules run.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { agentDir } from "./agent-dir.ts";
import type { AgentSource } from "./agent-env.ts";
import {
	type ConfigFile,
	configRecord,
	type GateConfig,
	loadConfig,
	type Project,
} from "./config.ts";
import { errorText } from "./error-text.ts";
import { type Direction, type FileTool, readFileCall } from "./file-call.ts";
import {
	type AutoWould,
	autoWould,
	type Inspection,
	inspect,
	type ParseFn,
	yoloWould,
} from "./gate.ts";
import { type Spellings, spellings } from "./path-spellings.ts";
import { importPi } from "./pi-package.ts";
import type { Ranking } from "./rank.ts";
import { fileMatches, type PathMatch, rankFile } from "./rules/path-rank.ts";
import type { RuleName } from "./verdict.ts";

export type Explanation = {
	readonly inspection: Inspection;
	readonly config: GateConfig;
};

export function explain(
	parse: ParseFn | undefined,
	command: string,
	agentDir: string,
	project: Project,
	agent?: AgentSource,
): Explanation {
	const config = loadConfig(agentDir, project, agent);
	const where = { cwd: project.cwd, home: homedir() };
	const alwaysAsk = config.auto?.alwaysAsk ?? [];
	const inspection = inspect(parse, command, config.policy, where, alwaysAsk);
	return { inspection, config };
}

function described(would: {
	readonly kind: string;
	readonly rule?: RuleName;
}): string {
	return would.rule !== undefined
		? `${would.kind} (${would.rule})`
		: would.kind;
}

function fileState({ path, loaded, problems }: ConfigFile): string {
	if (loaded) return `${path} (loaded)`;
	return problems.length > 0 ? `${path} (not loaded)` : `${path} (absent)`;
}

function configLine(config: GateConfig): string {
	const files = config.files.map(fileState).join(", ");
	const problems = config.problems.join("; ");
	return problems
		? `config: ${files}; problems: ${problems}`
		: `config: ${files}`;
}

export type Trust = { readonly trusted: boolean; readonly source: string };

/** The tools `explain <tool> <path>` takes: `write` covers an `edit` too. */
export const EXPLAINED_TOOLS = ["read", "write", "grep", "find", "ls"] as const;

export function explainedTool(word: string): FileTool | undefined {
	return EXPLAINED_TOOLS.find((tool) => tool === word);
}

export function asText(
	{ matches, withUI, withoutUI, withYolo, withAuto }: Inspection,
	config: GateConfig,
	trust: Trust,
): string {
	const lines = matches.map(
		({ rule, level, source }) => `${rule} (${level}): ${source}`,
	);
	if (lines.length === 0) lines.push("no rule matched");
	lines.push(`with a UI: ${described(withUI)}`);
	lines.push(`without a UI: ${described(withoutUI)}`);
	lines.push(`with YOLO: ${described(withYolo)}`);
	lines.push(`with auto: ${described(withAuto)}`);
	lines.push(configLine(config));
	const state = trust.trusted ? "trusted" : "untrusted";
	lines.push(`trust: ${state} (${trust.source})`);
	return lines.join("\n");
}

// Loads unbash as index.ts does; a failed load is `parser-unavailable`.
async function loadParser(): Promise<ParseFn | undefined> {
	try {
		const { parse } = await import("unbash");
		return parse;
	} catch {
		return undefined;
	}
}

export type FileExplanation = {
	readonly tool: FileTool;
	readonly direction: Direction;
	readonly paths: Spellings;
	readonly matches: readonly PathMatch[];
	readonly withUI: FileWould;
	readonly withoutUI: FileWould;
	readonly withYolo: FileWould;
	readonly withAuto: AutoWould;
	readonly config: GateConfig;
};

export type FileWould =
	| { readonly kind: "allow" }
	| { readonly kind: "ask"; readonly rule: RuleName }
	| { readonly kind: "deny"; readonly rule: RuleName };

function uiWould(ranking: Ranking | undefined): FileWould {
	if (!ranking) return { kind: "allow" };
	if (ranking.kind === "deny") {
		return { kind: "deny", rule: ranking.verdict.rule };
	}
	return { kind: "ask", rule: ranking.fallback.rule };
}

// No one can answer a dialog, so an ask becomes the deny its fallback names.
function noUiWould(ranking: Ranking | undefined): FileWould {
	if (!ranking) return { kind: "allow" };
	return {
		kind: "deny",
		rule:
			ranking.kind === "deny" ? ranking.verdict.rule : ranking.fallback.rule,
	};
}

/**
 * A file access ranked against `config`, with no dialog, judge or change:
 * `read` reads, `write` writes, and `grep`, `find` and `ls` search. The
 * caller picks the config: the session's, so the answer is what the live gate
 * would do, or one loaded from disk.
 */
export function explainFile(
	config: GateConfig,
	tool: FileTool,
	path: string,
	agentDir: string,
	project: Project,
): FileExplanation {
	const given = readFileCall(tool, { path });
	if (given.kind !== "ok") {
		throw new Error(`the bouncer could not read the path ${path}`);
	}
	const { access } = given;
	const home = homedir();
	const paths = spellings(access, project.cwd, home);
	const where = { cwd: project.cwd, home, agentDir };
	const { policy } = config;
	const ranked = (mode: "normal" | "yolo" | "auto"): Ranking | undefined =>
		rankFile(access, paths, policy, where, mode);
	return {
		tool,
		direction: access.direction,
		paths,
		matches: fileMatches(access, paths, policy, where),
		withUI: uiWould(ranked("normal")),
		withoutUI: noUiWould(ranked("normal")),
		withYolo: yoloWould(ranked("yolo")),
		withAuto: autoWould(ranked("auto")),
		config,
	};
}

function spellingList({ typed, all }: Spellings): string {
	return [...new Set([typed, ...all])].join(", ");
}

export function fileAsText(e: FileExplanation, trust: Trust): string {
	const { tool, paths, matches } = e;
	const found = matches.map(({ rule, level }) => `${rule} (${level})`);
	const lines = [
		`${tool} ${paths.typed}`,
		`spellings: ${spellingList(paths)}`,
		`matches: ${found.length > 0 ? found.join(", ") : "none"}`,
		`with UI: ${described(e.withUI)}`,
		`without UI: ${described(e.withoutUI)}`,
		`YOLO: ${described(e.withYolo)}`,
		`auto: ${described(e.withAuto)}`,
		configLine(e.config),
	];
	const state = trust.trusted ? "trusted" : "untrusted";
	lines.push(`trust: ${state} (${trust.source})`);
	return lines.join("\n");
}

// A project with a bouncer config needs trust, so this is what Pi reported at
// startup unless the user trusted the project for that session only.
async function savedTrust(agentDir: string, cwd: string): Promise<Trust> {
	let pi: Awaited<ReturnType<typeof importPi>>;
	try {
		pi = await importPi();
	} catch (error) {
		throw new Error(
			`cannot read Pi's trust decisions (${String(error)}); pass --trusted or --untrusted`,
		);
	}
	const decision = new pi.ProjectTrustStore(agentDir).get(cwd);
	if (decision === null)
		return { trusted: false, source: "no saved Pi decision" };
	const source = `Pi's saved decision in ${join(agentDir, "trust.json")}`;
	return { trusted: decision, source };
}

async function resolveTrust(
	flags: { readonly trusted: boolean; readonly untrusted: boolean },
	agentDir: string,
	cwd: string,
): Promise<Trust> {
	if (flags.trusted) return { trusted: true, source: "--trusted" };
	if (flags.untrusted) return { trusted: false, source: "--untrusted" };
	return await savedTrust(agentDir, cwd);
}

const USAGE = [
	"usage: node explain.ts [--json] [--agent <name>] [--agent-dir <path>] [--cwd <path>] [--trusted | --untrusted] <command | ->",
	"       node explain.ts [--json] [--agent <name>] [--agent-dir <path>] [--cwd <path>] [--trusted | --untrusted] <read|write|grep|find|ls> <path>",
	"       node explain.ts [flags] -- <command>",
].join("\n");

// What both forms share once the flags and the trust decision are settled.
type Target = {
	readonly json: boolean;
	readonly route: string;
	readonly project: Project;
	readonly agent: AgentSource | undefined;
	readonly trust: Trust;
};

type Given = {
	readonly json: boolean;
	readonly agentFlag: string | undefined;
	readonly agentDirFlag: string | undefined;
	readonly cwdFlag: string | undefined;
	readonly trusted: boolean;
	readonly untrusted: boolean;
	readonly tool: FileTool | undefined;
	readonly arg: string;
};

function parseCommand(): Given | undefined {
	const { values, positionals, tokens } = parseArgs({
		allowPositionals: true,
		tokens: true,
		options: {
			json: { type: "boolean", default: false },
			agent: { type: "string" },
			"agent-dir": { type: "string" },
			cwd: { type: "string" },
			trusted: { type: "boolean", default: false },
			untrusted: { type: "boolean", default: false },
		},
	});
	if (values.trusted && values.untrusted) return undefined;
	// `--` keeps a first word such as `read` a bash command.
	const bash = tokens.some((token) => token.kind === "option-terminator");
	const [first = "", second] = positionals;
	// A tool word with a path after it names a file call; a tool word on its
	// own stays a bash command, as `/bouncer explain ls` does.
	const tool =
		bash || positionals.length !== 2 ? undefined : explainedTool(first);
	if (bash ? positionals.length === 0 : positionals.length !== (tool ? 2 : 1)) {
		return undefined;
	}
	// `--` joins the words back; a quoted command is one positional.
	let arg = first;
	if (tool) arg = second ?? "";
	else if (bash) arg = positionals.join(" ");
	return {
		json: values.json,
		agentFlag: values.agent,
		agentDirFlag: values["agent-dir"],
		cwdFlag: values.cwd,
		trusted: values.trusted,
		untrusted: values.untrusted,
		tool,
		arg,
	};
}

async function fileOutput(
	{ json, route, project, agent, trust }: Target,
	tool: FileTool,
	path: string,
): Promise<string> {
	const config = loadConfig(route, project, agent);
	const explanation = explainFile(config, tool, path, route, project);
	const record = {
		...explanation,
		config: configRecord(explanation.config),
		trust,
	};
	return json
		? JSON.stringify(record, null, 2)
		: fileAsText(explanation, trust);
}

async function commandOutput(
	{ json, route, project, agent, trust }: Target,
	text: string,
): Promise<string> {
	// `jq -r` ends its output with a newline that the logged command lacks.
	const command =
		text === "-" ? readFileSync(0, "utf8").replace(/\n$/, "") : text;
	const { inspection, config } = explain(
		await loadParser(),
		command,
		route,
		project,
		agent,
	);
	const record = { ...inspection, config: configRecord(config), trust };
	return json
		? JSON.stringify(record, null, 2)
		: asText(inspection, config, trust);
}

async function main(): Promise<void> {
	const given = parseCommand();
	if (!given) {
		process.stderr.write(`${USAGE}\n`);
		process.exitCode = 2;
		return;
	}
	const route = resolve(given.agentDirFlag ?? agentDir());
	const cwd = resolve(given.cwdFlag ?? process.cwd());
	let trust: Trust;
	try {
		trust = await resolveTrust(given, route, cwd);
	} catch (error) {
		process.stderr.write(`explain.ts: ${errorText(error)}\n`);
		process.exitCode = 2;
		return;
	}
	// Trimmed, and blank means none, as agentFrom reads the live variables.
	const agent = given.agentFlag?.trim()
		? { name: given.agentFlag.trim(), variable: "--agent" }
		: undefined;
	const target = {
		json: given.json,
		route,
		project: { cwd, trusted: trust.trusted },
		agent,
		trust,
	};
	const output =
		given.tool !== undefined
			? await fileOutput(target, given.tool, given.arg)
			: await commandOutput(target, given.arg);
	process.stdout.write(`${output}\n`);
}

if (import.meta.main) await main();
