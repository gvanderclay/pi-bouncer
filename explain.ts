// Replays a command through the bouncer: every match, and what the bouncer would do
// with a UI, without one, in YOLO mode and in auto mode, under the same route
// and project bouncer config as the live bouncer. It never opens a dialog, calls a
// judge, reads git or runs the command.
//
//   node explain.ts 'rm -rf x'
//   jq -r .command record.json | node explain.ts -
//   node explain.ts --json 'sudo ls'
//   node explain.ts --agent-dir "$HOME/.pi/agent" --cwd /repo 'sudo ls'
//
// The route comes from `PI_CODING_AGENT_DIR` (or `~/.pi/agent`) and the
// project from the current directory unless `--agent-dir` or `--cwd` say
// otherwise.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { agentDir } from "./agent-dir.ts";
import {
	type ConfigFile,
	configRecord,
	type GateConfig,
	loadConfig,
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
 * session in `cwd`, as the live bouncer would; no parser means
 * `parser-unavailable`.
 */
export function explain(
	parse: ParseFn | undefined,
	command: string,
	agentDir: string,
	cwd: string,
): Explanation {
	const config = loadConfig(agentDir, cwd);
	const where = { cwd, home: homedir() };
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

function asText(
	{ matches, withUI, withoutUI, withYolo, withAuto }: Inspection,
	config: GateConfig,
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

const USAGE =
	"usage: node explain.ts [--json] [--agent-dir <path>] [--cwd <path>] <command | ->\n";

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			json: { type: "boolean", default: false },
			"agent-dir": { type: "string" },
			cwd: { type: "string" },
		},
	});
	const [arg] = positionals;
	if (positionals.length !== 1 || arg === undefined) {
		process.stderr.write(USAGE);
		process.exitCode = 2;
		return;
	}
	// `jq -r` ends its output with a newline that the logged command lacks.
	const command =
		arg === "-" ? readFileSync(0, "utf8").replace(/\n$/, "") : arg;
	const { "agent-dir": agentDirFlag, cwd } = values;
	const { inspection, config } = explain(
		await loadParser(),
		command,
		resolve(agentDirFlag ?? agentDir()),
		resolve(cwd ?? process.cwd()),
	);
	const output = values.json
		? JSON.stringify({ ...inspection, config: configRecord(config) }, null, 2)
		: asText(inspection, config);
	process.stdout.write(`${output}\n`);
}

if (import.meta.main) await main();
