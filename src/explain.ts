// Replays a command under the same config as the live bouncer. It opens no
// dialog, calls no judge, reads no git and never runs the command.
//
//   node explain.ts 'rm -rf x'
//   jq -r .command record.json | node explain.ts -
//   node explain.ts --json 'sudo ls'
//   node explain.ts --agent-dir "$HOME/.pi/agent" --cwd /repo 'sudo ls'
//   node explain.ts --untrusted 'git push --force'
//
// Agent dir: `PI_CODING_AGENT_DIR` or `~/.pi/agent`; project: the current
// directory, unless `--agent-dir` or `--cwd` say otherwise. Trust: `--trusted` or
// `--untrusted`, else Pi's saved decision in the agent dir's `trust.json` (none
// is untrusted); without Pi's package it refuses to guess.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { agentDir } from "./agent-dir.ts";
import {
	type ConfigFile,
	configRecord,
	type GateConfig,
	loadConfig,
	type Project,
} from "./config.ts";
import { errorText } from "./error-text.ts";
import {
	type AutoWould,
	type Inspection,
	inspect,
	type ParseFn,
	type Would,
} from "./gate.ts";
import { importPi } from "./pi-package.ts";

export type Explanation = {
	readonly inspection: Inspection;
	readonly config: GateConfig;
};

export function explain(
	parse: ParseFn | undefined,
	command: string,
	agentDir: string,
	project: Project,
): Explanation {
	const config = loadConfig(agentDir, project);
	const where = { cwd: project.cwd, home: homedir() };
	const alwaysAsk = config.auto?.alwaysAsk ?? [];
	const inspection = inspect(parse, command, config.policy, where, alwaysAsk);
	return { inspection, config };
}

function described(would: Would | AutoWould): string {
	return "rule" in would ? `${would.kind} (${would.rule})` : would.kind;
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

const USAGE =
	"usage: node explain.ts [--json] [--agent-dir <path>] [--cwd <path>] [--trusted | --untrusted] <command | ->\n";

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			json: { type: "boolean", default: false },
			"agent-dir": { type: "string" },
			cwd: { type: "string" },
			trusted: { type: "boolean", default: false },
			untrusted: { type: "boolean", default: false },
		},
	});
	const [arg] = positionals;
	const bothTrust = values.trusted && values.untrusted;
	if (positionals.length !== 1 || arg === undefined || bothTrust) {
		process.stderr.write(USAGE);
		process.exitCode = 2;
		return;
	}
	// `jq -r` ends its output with a newline that the logged command lacks.
	const command =
		arg === "-" ? readFileSync(0, "utf8").replace(/\n$/, "") : arg;
	const route = resolve(values["agent-dir"] ?? agentDir());
	const cwd = resolve(values.cwd ?? process.cwd());
	let trust: Trust;
	try {
		trust = await resolveTrust(values, route, cwd);
	} catch (error) {
		process.stderr.write(`explain.ts: ${errorText(error)}\n`);
		process.exitCode = 2;
		return;
	}
	const { inspection, config } = explain(await loadParser(), command, route, {
		cwd,
		trusted: trust.trusted,
	});
	const record = { ...inspection, config: configRecord(config), trust };
	const output = values.json
		? JSON.stringify(record, null, 2)
		: asText(inspection, config, trust);
	process.stdout.write(`${output}\n`);
}

if (import.meta.main) await main();
