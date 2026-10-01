// Replays a command through the bouncer: every match, and what the bouncer would do
// with a UI, without one, in YOLO mode and in auto mode, under the same route
// and project bouncer config as the live bouncer. It never opens a dialog, calls a
// judge, reads git or runs the command.
//
//   node explain.ts 'rm -rf x'
//   jq -r .command record.json | node explain.ts -
//   node explain.ts --json 'sudo ls'
//   node explain.ts --agent-dir "$HOME/.pi/agent" --cwd /repo 'sudo ls'
//   node explain.ts --untrusted 'git push --force'
//
// The route comes from `PI_CODING_AGENT_DIR` (or `~/.pi/agent`) and the
// project from the current directory unless `--agent-dir` or `--cwd` say
// otherwise. The project's trust state comes from `--trusted` or
// `--untrusted`, else from Pi's saved decision in the route's `trust.json`
// (no saved decision is untrusted); without Pi's package it refuses to guess.
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
import {
	type AutoWould,
	type Inspection,
	inspect,
	type ParseFn,
	type Would,
} from "./gate.ts";

/** One replay: what the bouncer would do, and the config it ran under. */
export type Explanation = {
	readonly inspection: Inspection;
	readonly config: GateConfig;
};

/**
 * Replays `command` under the bouncer config of the route in `agentDir` for a
 * session in `project`, which Pi trusts or not, as the live bouncer would; no parser means `parser-unavailable`.
 */
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

// One line: every config file looked for, then every problem.
function configLine(config: GateConfig): string {
	const files = config.files.map(fileState).join(", ");
	const problems = config.problems.join("; ");
	return problems
		? `config: ${files}; problems: ${problems}`
		: `config: ${files}`;
}

/** The trust state a replay used, and where it came from. */
type Trust = { readonly trusted: boolean; readonly source: string };

function asText(
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

/**
 * The trust state for `cwd` from the route's saved Pi decisions: trusted only
 * when a decision says so. A project with a bouncer config needs trust, so
 * this is what Pi reported at startup unless the user trusted the project for
 * that session only. An error when Pi's package cannot be loaded.
 */
async function savedTrust(agentDir: string, cwd: string): Promise<Trust> {
	let pi: typeof import("@earendil-works/pi-coding-agent");
	try {
		pi = await import("@earendil-works/pi-coding-agent");
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

/**
 * The trust state `--trusted` or `--untrusted` names, else Pi's saved
 * decision for `cwd` in the route `agentDir`; an error when that cannot be read.
 */
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
		process.stderr.write(
			`explain.ts: ${error instanceof Error ? error.message : String(error)}\n`,
		);
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
