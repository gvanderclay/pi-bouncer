// Replays commands through explain.ts's exported function with the real parser.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "unbash";
import { explain } from "../explain.ts";
import type { Inspection, ParseFn } from "../gate.ts";
import {
	tempAgentDir,
	tempProjectDir,
	writeConfig,
	writeProjectConfig,
} from "./harness.ts";

const RM_X = { rule: "recursive-rm", level: "ask", source: "rm -rf x" };

/** The replay's inspection under a route and project with no config. */
function inspected(parser: ParseFn | undefined, command: string): Inspection {
	return explain(parser, command, tempAgentDir(), tempProjectDir()).inspection;
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
	const { inspection } = explain(parse, "sudo ls", agentDir, tempProjectDir());
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
		cwd,
	);
	assert.deepEqual(
		config.files.map(({ path, loaded }) => [path, loaded]),
		[
			[join(agentDir, "bouncer.json"), true],
			[join(cwd, ".pi", "bouncer.json"), true],
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

/** The replay's `withYolo` under a route config setting `levels`. */
function withYolo(
	command: string,
	levels: object = {},
): Inspection["withYolo"] {
	const agentDir = tempAgentDir();
	writeConfig(join(agentDir, "bouncer.json"), { levels });
	return explain(parse, command, agentDir, tempProjectDir()).inspection
		.withYolo;
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

/** A route dir whose bouncer config is `config`. */
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
		const { inspection } = explain(parse, command, agentDir, tempProjectDir());
		assert.deepEqual(inspection.withAuto, expected);
	});
}

const EXPLAIN = fileURLToPath(new URL("../explain.ts", import.meta.url));

/** `node explain.ts` on `command` under a route whose bouncer config is `config`. */
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
