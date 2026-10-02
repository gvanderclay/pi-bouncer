import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "unbash";
import {
	projectConfigPath,
	tempAgentDir,
	tempProjectDir,
	writeConfig,
	writeProjectConfig,
} from "../test/harness.ts";
import { explain } from "./explain.ts";
import type { Inspection, ParseFn } from "./gate.ts";

const RM_X = { rule: "recursive-rm", level: "ask", source: "rm -rf x" };

function inspected(parser: ParseFn | undefined, command: string): Inspection {
	return explain(parser, command, tempAgentDir(), {
		cwd: tempProjectDir(),
		trusted: true,
	}).inspection;
}

test("rm -rf x is one ask: asked with a UI, denied without", () => {
	assert.deepEqual(inspected(parse, "rm -rf x"), {
		matches: [RM_X],
		withUI: { kind: "ask" },
		withoutUI: { kind: "deny", rule: "recursive-rm" },
		withYolo: { kind: "allow" },
		withAuto: { kind: "judge" },
	});
});

test("sudo ls is a privilege deny both ways", () => {
	assert.deepEqual(inspected(parse, "sudo ls"), {
		matches: [{ rule: "privilege", level: "deny", source: "sudo ls" }],
		withUI: { kind: "deny", rule: "privilege" },
		withoutUI: { kind: "deny", rule: "privilege" },
		withYolo: { kind: "deny", rule: "privilege" },
		withAuto: { kind: "deny", rule: "privilege" },
	});
});

test("ls matches nothing and is allowed both ways", () => {
	assert.deepEqual(inspected(parse, "ls"), {
		matches: [],
		withUI: { kind: "allow" },
		withoutUI: { kind: "allow" },
		withYolo: { kind: "allow" },
		withAuto: { kind: "allow" },
	});
});

test("two asks on one line are listed in order", () => {
	assert.deepEqual(inspected(parse, "rm -rf x && git reset --hard"), {
		matches: [
			RM_X,
			{ rule: "git-reset-hard", level: "ask", source: "git reset --hard" },
		],
		withUI: { kind: "ask" },
		withoutUI: { kind: "deny", rule: "recursive-rm" },
		withYolo: { kind: "allow" },
		withAuto: { kind: "judge" },
	});
});

test("a deny after an ask wins with a UI", () => {
	assert.deepEqual(inspected(parse, "rm -rf x && sudo ls"), {
		matches: [RM_X, { rule: "privilege", level: "deny", source: "sudo ls" }],
		withUI: { kind: "deny", rule: "privilege" },
		withoutUI: { kind: "deny", rule: "privilege" },
		withYolo: { kind: "deny", rule: "privilege" },
		withAuto: { kind: "deny", rule: "privilege" },
	});
});

test("grep alone is a steer block in every mode", () => {
	const deny = { kind: "deny", rule: "grep" };
	assert.deepEqual(inspected(parse, "grep y f"), {
		matches: [{ rule: "grep", level: "deny", source: "grep y f" }],
		withUI: deny,
		withoutUI: deny,
		withYolo: deny,
		withAuto: deny,
	});
});

test("grep is a steer block in every mode", () => {
	const deny = { kind: "deny", rule: "grep" };
	assert.deepEqual(inspected(parse, "rm -rf x && grep y f"), {
		matches: [RM_X, { rule: "grep", level: "deny", source: "grep y f" }],
		withUI: deny,
		withoutUI: deny,
		withYolo: deny,
		withAuto: deny,
	});
});

test("a real deny after grep wins in every mode", () => {
	const deny = { kind: "deny", rule: "privilege" };
	assert.deepEqual(inspected(parse, "grep y f && sudo ls"), {
		matches: [
			{ rule: "grep", level: "deny", source: "grep y f" },
			{ rule: "privilege", level: "deny", source: "sudo ls" },
		],
		withUI: deny,
		withoutUI: deny,
		withYolo: deny,
		withAuto: deny,
	});
});

test("with no parser, every command is parser-unavailable", () => {
	assert.deepEqual(inspected(undefined, "ls"), {
		matches: [{ rule: "parser-unavailable", level: "deny", source: "ls" }],
		withUI: { kind: "deny", rule: "parser-unavailable" },
		withoutUI: { kind: "deny", rule: "parser-unavailable" },
		withYolo: { kind: "deny", rule: "parser-unavailable" },
		withAuto: { kind: "deny", rule: "parser-unavailable" },
	});
});

test("with privilege set to ask, sudo ls is asked with a UI and denied without", () => {
	const agentDir = tempAgentDir();
	writeConfig(join(agentDir, "bouncer.json"), {
		levels: { privilege: "ask" },
	});
	const { inspection } = explain(parse, "sudo ls", agentDir, {
		cwd: tempProjectDir(),
		trusted: true,
	});
	assert.deepEqual(inspection, {
		matches: [{ rule: "privilege", level: "ask", source: "sudo ls" }],
		withUI: { kind: "ask" },
		withoutUI: { kind: "deny", rule: "privilege" },
		withYolo: { kind: "deny", rule: "privilege" },
		withAuto: { kind: "deny", rule: "privilege" },
	});
});

test("the route and project config drive the replay, and come back with it", () => {
	const agentDir = tempAgentDir();
	const cwd = tempProjectDir();
	writeConfig(join(agentDir, "bouncer.json"), {
		levels: { "git-push-force": "deny", privilege: "ask" },
	});
	writeProjectConfig(cwd, { levels: { "git-push-force": "ask" } });
	const { inspection, config } = explain(
		parse,
		"git push --force && sudo ls",
		agentDir,
		{ cwd, trusted: true },
	);
	assert.deepEqual(
		config.files.map(({ path, loaded }) => [path, loaded]),
		[
			[join(agentDir, "bouncer.json"), true],
			[projectConfigPath(cwd), true],
		],
	);
	assert.deepEqual(inspection, {
		matches: [
			{ rule: "git-push-force", level: "ask", source: "git push --force" },
			{ rule: "privilege", level: "ask", source: "sudo ls" },
		],
		withUI: { kind: "ask" },
		withoutUI: { kind: "deny", rule: "git-push-force" },
		withYolo: { kind: "deny", rule: "privilege" },
		withAuto: { kind: "deny", rule: "privilege" },
	});
});

function withYolo(
	command: string,
	levels: object = {},
): Inspection["withYolo"] {
	const agentDir = tempAgentDir();
	writeConfig(join(agentDir, "bouncer.json"), { levels });
	return explain(parse, command, agentDir, {
		cwd: tempProjectDir(),
		trusted: true,
	}).inspection.withYolo;
}

const yoloRows: readonly (readonly [
	label: string,
	command: string,
	levels: object,
	expected: Inspection["withYolo"],
])[] = [
	["an ask", "rm -rf x", {}, { kind: "allow" }],
	["sudo", "sudo ls", {}, { kind: "deny", rule: "privilege" }],
	["rm-root", "rm -rf ~", {}, { kind: "deny", rule: "rm-root" }],
	[
		"an unparseable command",
		'echo "x',
		{},
		{ kind: "deny", rule: "unparseable" },
	],
	[
		"sudo with privilege lowered to ask",
		"sudo ls",
		{ privilege: "ask" },
		{ kind: "deny", rule: "privilege" },
	],
	[
		"a push with git-push-force raised to deny",
		"git push --force",
		{ "git-push-force": "deny" },
		{ kind: "allow" },
	],
	[
		"a raised deny beside sudo",
		"git push --force && sudo ls",
		{ "git-push-force": "deny" },
		{ kind: "deny", rule: "privilege" },
	],
];

for (const [label, command, levels, expected] of yoloRows) {
	test(`with YOLO: ${label} is ${expected.kind}`, () => {
		assert.deepEqual(withYolo(command, levels), expected);
	});
}

function routeWith(config: object): string {
	const agentDir = tempAgentDir();
	writeConfig(join(agentDir, "bouncer.json"), config);
	return agentDir;
}

const autoRows: readonly (readonly [
	label: string,
	command: string,
	config: object,
	expected: Inspection["withAuto"],
])[] = [
	["an ask", "rm -rf dist", {}, { kind: "judge" }],
	["no match", "ls", {}, { kind: "allow" }],
	["sudo", "sudo ls", {}, { kind: "deny", rule: "privilege" }],
	[
		"sudo with privilege lowered to ask",
		"sudo ls",
		{ levels: { privilege: "ask" } },
		{ kind: "deny", rule: "privilege" },
	],
	[
		"a push with git-push-force raised to deny",
		"git push --force",
		{ levels: { "git-push-force": "deny" } },
		{ kind: "deny", rule: "git-push-force" },
	],
	[
		"an unparseable command",
		'echo "x',
		{},
		{ kind: "deny", rule: "unparseable" },
	],
	[
		"an alwaysAsk prefix",
		"terraform apply",
		{ auto: { models: ["fake/judge"], alwaysAsk: ["terraform apply"] } },
		{ kind: "ask", rule: "always-ask" },
	],
	[
		"an alwaysAsk prefix beside a rule ask",
		"rm -rf dist && terraform apply",
		{ auto: { models: ["fake/judge"], alwaysAsk: ["terraform apply"] } },
		{ kind: "ask", rule: "always-ask" },
	],
];

for (const [label, command, config, expected] of autoRows) {
	test(`with auto: ${label} is ${expected.kind}`, () => {
		const agentDir = routeWith(config);
		const { inspection } = explain(parse, command, agentDir, {
			cwd: tempProjectDir(),
			trusted: true,
		});
		assert.deepEqual(inspection.withAuto, expected);
	});
}

const EXPLAIN = fileURLToPath(new URL("./explain.ts", import.meta.url));

function run(command: string, config: object, json = false): string {
	const args = ["--agent-dir", routeWith(config), "--cwd", tempProjectDir()];
	return execFileSync(
		process.execPath,
		[EXPLAIN, ...args, ...(json ? ["--json"] : []), command],
		{ encoding: "utf8" },
	);
}

const TERRAFORM = {
	auto: { models: ["fake/judge"], alwaysAsk: ["terraform apply"] },
};

const cliRows: readonly (readonly [
	command: string,
	config: object,
	line: string,
	json: Inspection["withAuto"],
])[] = [
	["rm -rf dist", {}, "with auto: judge", { kind: "judge" }],
	[
		"sudo ls",
		{},
		"with auto: deny (privilege)",
		{ kind: "deny", rule: "privilege" },
	],
	[
		"sudo ls",
		{ levels: { privilege: "ask" } },
		"with auto: deny (privilege)",
		{ kind: "deny", rule: "privilege" },
	],
	[
		"git push --force",
		{ levels: { "git-push-force": "deny" } },
		"with auto: deny (git-push-force)",
		{ kind: "deny", rule: "git-push-force" },
	],
	[
		"terraform apply",
		TERRAFORM,
		"with auto: ask (always-ask)",
		{ kind: "ask", rule: "always-ask" },
	],
];

for (const [command, config, line, json] of cliRows) {
	test(`explain.ts prints "${line}" after with YOLO for ${command}, and --json has withAuto`, () => {
		const lines = run(command, config).split("\n");
		const at = lines.findIndex((text) => text.startsWith("with YOLO: "));
		assert.equal(lines[at + 1], line);
		assert.deepEqual(JSON.parse(run(command, config, true)).withAuto, json);
	});
}

function loosenedPush(): { agentDir: string; cwd: string } {
	const agentDir = routeWith({ levels: { "git-push-force": "deny" } });
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { levels: { "git-push-force": "ask" } });
	return { agentDir, cwd };
}

test("an untrusted project cannot loosen git-push-force in the replay; a trusted one can", () => {
	const { agentDir, cwd } = loosenedPush();
	const untrusted = explain(parse, "git push --force", agentDir, {
		cwd,
		trusted: false,
	});
	assert.deepEqual(untrusted.inspection.withUI, {
		kind: "deny",
		rule: "git-push-force",
	});
	assert.ok(
		untrusted.config.problems.some((problem) =>
			problem.includes('"git-push-force" would loosen the rule'),
		),
		JSON.stringify(untrusted.config.problems),
	);
	const trusted = explain(parse, "git push --force", agentDir, {
		cwd,
		trusted: true,
	});
	assert.deepEqual(trusted.inspection.withUI, { kind: "ask" });
});

for (const trusted of [true, false]) {
	test(`a project setting rm-root to ask is still denied in the replay (trusted: ${trusted})`, () => {
		const cwd = tempProjectDir();
		writeProjectConfig(cwd, { levels: { "rm-root": "ask" } });
		const { inspection } = explain(parse, "rm -rf /", tempAgentDir(), {
			cwd,
			trusted,
		});
		assert.deepEqual(inspection.withUI, { kind: "deny", rule: "rm-root" });
	});
}

function runArgs(args: readonly string[]): {
	status: number | null;
	stdout: string;
	stderr: string;
} {
	const { status, stdout, stderr } = spawnSync(
		process.execPath,
		[EXPLAIN, ...args],
		{ encoding: "utf8" },
	);
	return { status, stdout, stderr };
}

test("explain.ts --untrusted and --trusted set the trust state and say so", () => {
	const { agentDir, cwd } = loosenedPush();
	const where = ["--agent-dir", agentDir, "--cwd", cwd];
	const untrusted = runArgs([...where, "--untrusted", "git push --force"]);
	assert.equal(untrusted.status, 0, untrusted.stderr);
	assert.match(untrusted.stdout, /^with a UI: deny \(git-push-force\)$/m);
	assert.match(untrusted.stdout, /^trust: untrusted \(--untrusted\)$/m);
	assert.match(
		untrusted.stdout,
		/"git-push-force" would loosen the rule, and the project is not trusted/,
	);
	const trusted = runArgs([
		...where,
		"--trusted",
		"--json",
		"git push --force",
	]);
	assert.equal(trusted.status, 0, trusted.stderr);
	const json = JSON.parse(trusted.stdout);
	assert.deepEqual(json.withUI, { kind: "ask" });
	assert.deepEqual(json.trust, { trusted: true, source: "--trusted" });
	assert.equal(json.config.projectTrusted, true);
});

test("explain.ts without a trust flag uses Pi's saved decision for the cwd", () => {
	const { agentDir, cwd } = loosenedPush();
	writeConfig(join(agentDir, "trust.json"), { [realpathSync(cwd)]: false });
	const where = ["--agent-dir", agentDir, "--cwd", cwd];
	const result = runArgs([...where, "git push --force"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^with a UI: deny \(git-push-force\)$/m);
	assert.match(
		result.stdout,
		/^trust: untrusted \(Pi's saved decision in .*trust\.json\)$/m,
	);
});

test("explain.ts without a trust flag or a saved decision treats a project with a config as untrusted", () => {
	const { agentDir, cwd } = loosenedPush();
	const result = runArgs([
		"--agent-dir",
		agentDir,
		"--cwd",
		cwd,
		"--json",
		"git push --force",
	]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout).trust, {
		trusted: false,
		source: "no saved Pi decision",
	});
});

test("explain.ts with both trust flags is a usage error", () => {
	const result = runArgs(["--trusted", "--untrusted", "ls"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /--trusted/);
});
