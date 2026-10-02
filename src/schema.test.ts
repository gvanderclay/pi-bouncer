// The JSON Schema and the config validator must agree: a config the bouncer
// reads without problems validates, and one it reports problems for does not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Ajv } from "ajv";
import { tempAgentDir, tempProjectDir, writeConfig } from "../test/harness.ts";
import { loadConfig } from "./config.ts";
import { builtInPolicy } from "./rules/built-in-policy.ts";

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
	{ log: { rotateAboveMiB: 0.5, generations: 0, maxAgeDays: 30 } },
	{ startMode: "off" },
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
];

// Not covered by the schema: a firstByProvider value missing from models.
const INVALID: readonly unknown[] = [
	{ $schema: 1 },
	{ rules: [] },
	{ other: true },
	{ levels: { grep: "ask" } },
	{ levels: { unparseable: "ask" } },
	{ levels: { "no-such-rule": "ask" } },
	{ levels: { "recursive-rm": "allow" } },
	{ levels: [] },
	{ log: { rotateAboveMiB: 0 } },
	{ log: { generations: 1.5 } },
	{ log: { maxAgeDays: 0 } },
	{ log: { other: 1 } },
	{ startMode: "yolo" },
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

test("the schema's levels are exactly the rules a config can set", () => {
	const names = builtInPolicy.flatMap((entry) =>
		entry.kind === "rule" ? [entry.rule.name] : [],
	);
	assert.deepEqual(Object.keys(schema.properties.levels.properties), names);
});
