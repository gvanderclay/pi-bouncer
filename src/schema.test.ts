// The JSON Schema and the config validator must agree: a config the bouncer
// reads without problems validates, and one it reports problems for does not.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Ajv } from "ajv";
import {
	PREFER_RG,
	projectConfigPath,
	tempAgentDir,
	tempProjectDir,
	writeConfig,
} from "../test/harness.ts";
import { loadConfig } from "./config.ts";
import { builtInPolicy } from "./rules/built-in-policy.ts";
import { policyEntryName } from "./rules/rule.ts";

const schema = JSON.parse(
	readFileSync(
		new URL("../schema/bouncer.schema.json", import.meta.url),
		"utf8",
	),
);
const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(
	schema,
);

function problems(config: unknown): readonly string[] {
	const agentDir = tempAgentDir();
	writeConfig(join(agentDir, "bouncer.json"), config);
	return loadConfig(agentDir, { cwd: tempProjectDir(), trusted: true })
		.problems;
}

const fixture = JSON.parse(
	readFileSync(
		new URL("../test/fixtures/example-config.json", import.meta.url),
		"utf8",
	),
);

const VALID: readonly unknown[] = [
	{},
	fixture,
	{ $schema: schema.$id, levels: {} },
	{ levels: { "recursive-rm": "deny", "rm-root": "ask" } },
	{ levels: { "recursive-rm": "off", "rm-root": "deny" } },
	PREFER_RG,
	{ rules: [] },
	{
		rules: [
			{
				name: "kubectl-delete",
				command: "kubectl",
				args: ["delete"],
				summary: "deletes cluster resources",
			},
			{
				name: "tf",
				command: ["terraform", "tofu"],
				level: "off",
				summary: "s",
			},
			{
				name: "y2",
				command: "yarn",
				summary: "s",
				instead: "Use pnpm.",
				level: "off",
			},
		],
	},
	{ log: { rotateAboveMiB: 0.5, generations: 0, maxAgeDays: 30 } },
	{ startMode: "off" },
	{ trustAgentMade: false },
	{ protect: { home: ["code", ".secrets/keys"], paths: ["/srv/data"] } },
	{ protect: {} },
	{
		auto: {
			models: ["a/b"],
			alwaysAsk: ["git push"],
			environment: ["macOS"],
			firstByProvider: { a: "a/b" },
			jev: { allowAt: 1, denyAt: null, model: "x/y" },
		},
	},
	{ auto: { models: ["a/b"], jev: { denyAt: 0.9 } } },
	{
		profiles: {
			readonly: {
				levels: { "recursive-rm": "deny" },
				rules: [
					{
						name: "no-commit",
						command: "git",
						args: ["commit"],
						level: "deny",
						summary: "a read-only agent does not commit",
					},
				],
				mode: "off",
			},
			worker: {
				levels: { "recursive-rm": "off" },
				protect: { home: ["notes"] },
				mode: "auto",
			},
		},
		agents: { scout: "readonly", builder: "worker" },
	},
	{
		profiles: { "lint-only": { levels: { "recursive-rm": "deny" } } },
		agents: { linter: "lint-only" },
	},
];

// Not covered by the schema: a firstByProvider value missing from models,
// two rules with one name, and an agent naming a profile no file defines.
const INVALID: readonly unknown[] = [
	{ $schema: 1 },
	{ rules: {} },
	{ rules: [{ name: "x", command: "x" }] },
	{ rules: [{ name: "X", command: "x", summary: "s" }] },
	{ rules: [{ name: "rm-root", command: "x", summary: "s" }] },
	{ rules: [{ name: "always-ask", command: "x", summary: "s" }] },
	{ rules: [{ name: "x", command: [], summary: "s" }] },
	{ rules: [{ name: "x", command: " ", summary: "s" }] },
	{ rules: [{ name: "x", command: "x", args: "delete", summary: "s" }] },
	{ rules: [{ name: "x", command: "x", summary: "s", level: "allow" }] },
	{
		rules: [
			{ name: "x", command: "x", summary: "s", instead: "i", level: "ask" },
		],
	},
	{ rules: [{ name: "x", command: "x", summary: "s", other: 1 }] },
	{ levels: { grep: "deny" } },
	{ other: true },
	{ levels: { grep: "ask" } },
	{ levels: { grep: "off", unparseable: "ask" } },
	{ levels: { unparseable: "off" } },
	{ levels: { privilege: "off" } },
	{ levels: { "rm-root": "off" } },
	{ levels: { "no-such-rule": "ask" } },
	{ levels: { "recursive-rm": "allow" } },
	{ levels: [] },
	{ log: { rotateAboveMiB: 0 } },
	{ log: { generations: 1.5 } },
	{ log: { maxAgeDays: 0 } },
	{ log: { other: 1 } },
	{ startMode: "yolo" },
	{ trustAgentMade: "no" },
	{ protect: [] },
	{ protect: { home: "code" } },
	{ protect: { home: ["/abs"] } },
	{ protect: { home: ["~/code"] } },
	{ protect: { home: ["a/../b"] } },
	{ protect: { home: [""] } },
	{ protect: { paths: ["relative"] } },
	{ protect: { paths: [1] } },
	{ protect: { other: [] } },
	{ auto: {} },
	{ auto: { models: [] } },
	{ auto: { models: ["no-slash"] } },
	{ auto: { models: ["a/b"], alwaysAsk: [" "] } },
	{ auto: { models: ["a/b"], environment: "x" } },
	{ auto: { models: ["a/b"], firstByProvider: { a: "bad" } } },
	{ auto: { models: ["a/b"], other: 1 } },
	{ auto: { models: ["a/b"], jev: { allowAt: 0.5 } } },
	{ auto: { models: ["a/b"], jev: { allowAt: null } } },
	{ auto: { models: ["a/b"], jev: { denyAt: 1.1 } } },
	{ auto: { models: ["a/b"], jev: { model: "bad" } } },
	{ auto: { models: ["a/b"], jev: { other: 1 } } },
	{ profiles: { w: { mode: "yolo" } } },
	{ profiles: { w: { colour: 1 } } },
	{ profiles: { "Bad Name": {} } },
	{ profiles: { w: { levels: { "rm-root": "off" } } } },
	{ profiles: { w: {} }, agents: { scout: 1 } },
];

test("every config the bouncer reads without problems validates", () => {
	for (const config of VALID) {
		assert.deepEqual(problems(config), [], JSON.stringify(config));
		assert.ok(validate(config), JSON.stringify([config, validate.errors]));
	}
});

test("every config the bouncer reports problems for fails validation", () => {
	for (const config of INVALID) {
		assert.notDeepEqual(problems(config), [], JSON.stringify(config));
		assert.equal(validate(config), false, JSON.stringify(config));
	}
});

const examplesDir = new URL("../examples/", import.meta.url);
const examples = readdirSync(examplesDir).map((name) => ({
	name,
	config: JSON.parse(readFileSync(new URL(name, examplesDir), "utf8")),
}));

test("every example config validates and loads with no problems", () => {
	assert.ok(examples.length >= 5);
	for (const { name, config } of examples) {
		assert.deepEqual(problems(config), [], name);
		assert.ok(validate(config), JSON.stringify([name, validate.errors]));
	}
});

test("the project example loads with no problems in an untrusted project", () => {
	const cwd = tempProjectDir();
	const project = examples.find(({ name }) => name === "project.json");
	writeConfig(projectConfigPath(cwd), project?.config);
	const config = loadConfig(tempAgentDir(), { cwd, trusted: false });
	assert.deepEqual(config.problems, []);
	assert.ok(
		config.files.some((file) => file.loaded && file.path.includes(cwd)),
	);
	assert.ok(
		config.policy.some(
			(entry) => entry.kind === "rule" && entry.rule.name === "db-reset",
		),
	);
});

test("the schema's levels are exactly the rules a config can set", () => {
	const names = builtInPolicy.flatMap((entry) =>
		entry.kind === "unreadable" ? [] : [entry.rule.name],
	);
	assert.deepEqual(Object.keys(schema.definitions.levels.properties), names);
});

test("the schema refuses every built-in name for a custom rule", () => {
	const names = ["always-ask", ...builtInPolicy.map(policyEntryName)];
	const taken = schema.definitions.rules.items.properties.name.not.enum;
	assert.deepEqual(taken, names);
});
