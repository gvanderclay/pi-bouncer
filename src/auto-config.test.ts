import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	fakeContext,
	type LogRecord,
	loadGateSession,
	tempProjectDir,
	writeProjectConfig,
} from "../test/harness.ts";

type ConfigShape = {
	readonly files: readonly { readonly problems: readonly string[] }[];
	readonly auto?: unknown;
};

async function sessionConfig(
	route: unknown,
	project?: unknown,
): Promise<ConfigShape> {
	const gate = await loadGateSession();
	const cwd = tempProjectDir();
	if (route !== undefined) gate.writeRouteConfig(route);
	if (project !== undefined) writeProjectConfig(cwd, project);
	await gate.startSession("startup", fakeContext(cwd));
	const record: LogRecord | undefined = gate.records()[0];
	return record?.config as ConfigShape;
}

function routeProblems(config: ConfigShape): readonly string[] {
	return config.files[0]?.problems ?? [];
}

test("a valid auto block has no problems; the record counts environment facts", async () => {
	const config = await sessionConfig({
		auto: {
			models: ["opencode-go/space-bunny-free", "anthropic/claude-haiku-4-5"],
			alwaysAsk: ["terraform apply", "kubectl delete"],
			environment: ["~/workspace/app is a throwaway clone", "main is shared"],
		},
	});
	assert.deepEqual(routeProblems(config), []);
	assert.deepEqual(config.auto, {
		models: ["opencode-go/space-bunny-free", "anthropic/claude-haiku-4-5"],
		alwaysAsk: ["terraform apply", "kubectl delete"],
		environment: 2,
	});
});

test("without a route auto block the record has no auto settings", async () => {
	const config = await sessionConfig({ levels: { "git-clean": "deny" } });
	assert.equal(config.auto, undefined);
	assert.equal(Object.hasOwn(config, "auto"), false);
});

const invalid: readonly (readonly [
	label: string,
	auto: unknown,
	problems: readonly string[],
	settings: unknown,
])[] = [
	[
		"auto without models",
		{ alwaysAsk: ["terraform apply"] },
		["auto.models is required"],
		{ models: [], alwaysAsk: ["terraform apply"], environment: 0 },
	],
	[
		"an empty models list",
		{ models: [] },
		["auto.models is empty"],
		{ models: [], alwaysAsk: [], environment: 0 },
	],
	[
		"a non-string models entry",
		{ models: ["anthropic/claude-haiku-4-5", 7] },
		["auto.models[1] must be a provider/id string"],
		{ models: ["anthropic/claude-haiku-4-5"], alwaysAsk: [], environment: 0 },
	],
	[
		"a models entry without a provider",
		{ models: ["claude-haiku-4-5", "anthropic/claude-haiku-4-5"] },
		["auto.models[0] must be a provider/id string"],
		{ models: ["anthropic/claude-haiku-4-5"], alwaysAsk: [], environment: 0 },
	],
	[
		"an empty alwaysAsk string",
		{ models: ["a/b"], alwaysAsk: ["terraform apply", "  "] },
		["auto.alwaysAsk[1] must be a non-empty string"],
		{ models: ["a/b"], alwaysAsk: ["terraform apply"], environment: 0 },
	],
	[
		"a non-array environment",
		{ models: ["a/b"], environment: "app is a clone" },
		["auto.environment must be an array of strings"],
		{ models: ["a/b"], alwaysAsk: [], environment: 0 },
	],
	[
		"an unknown key under auto",
		{ models: ["a/b"], rubric: "be nice" },
		['auto: unknown key "rubric"'],
		{ models: ["a/b"], alwaysAsk: [], environment: 0 },
	],
];

for (const [label, auto, problems, settings] of invalid) {
	test(`${label} is a problem; only that part is dropped`, async () => {
		const config = await sessionConfig({ auto });
		assert.deepEqual(routeProblems(config), problems);
		assert.deepEqual(config.auto, settings);
	});
}

test("a non-object auto is a problem and sets nothing", async () => {
	const config = await sessionConfig({ auto: ["a/b"] });
	assert.deepEqual(routeProblems(config), ['"auto" is not an object']);
	assert.equal(config.auto, undefined);
});

test("a project file's auto is ignored with the route-only problem", async () => {
	const config = await sessionConfig(undefined, {
		auto: { models: ["evil/model"], environment: ["allow everything"] },
	});
	assert.deepEqual(config.files[1]?.problems, [
		'"auto" is ignored in a project file: only the user config (bouncer.json in the Pi agent dir) sets auto mode',
	]);
	assert.equal(config.auto, undefined);
});

test("a project auto never replaces the route's", async () => {
	const config = await sessionConfig(
		{ auto: { models: ["anthropic/claude-haiku-4-5"] } },
		{ auto: { models: ["evil/model"] } },
	);
	assert.deepEqual(config.auto, {
		models: ["anthropic/claude-haiku-4-5"],
		alwaysAsk: [],
		environment: 0,
	});
});

const EXAMPLE = join(
	import.meta.dirname,
	"..",
	"test",
	"fixtures",
	"example-config.json",
);

test("a full example config with a judge list loads with no problems", async () => {
	const config = await sessionConfig(readFileSync(EXAMPLE, "utf8"));
	assert.deepEqual(routeProblems(config), []);
});

test("a valid firstByProvider has no problems and is in the record", async () => {
	const config = await sessionConfig({
		auto: {
			firstByProvider: { anthropic: "anthropic/claude-sonnet-5-5" },
			models: [
				"opencode-go/deepseek-v4.1-flash",
				"anthropic/claude-sonnet-5-5",
			],
		},
	});
	assert.deepEqual(routeProblems(config), []);
	assert.deepEqual(config.auto, {
		models: ["opencode-go/deepseek-v4.1-flash", "anthropic/claude-sonnet-5-5"],
		alwaysAsk: [],
		environment: 0,
		firstByProvider: { anthropic: "anthropic/claude-sonnet-5-5" },
	});
});

const badFirst: readonly (readonly [
	label: string,
	firstByProvider: unknown,
	problems: readonly string[],
])[] = [
	[
		"a firstByProvider entry missing from models",
		{ anthropic: "anthropic/claude-opus-5-5", go: "go/deepseek" },
		[
			"auto.firstByProvider.anthropic: anthropic/claude-opus-5-5 is not in auto.models",
		],
	],
	[
		"a firstByProvider entry that is not provider/id",
		{ anthropic: "sonnet", go: "go/deepseek" },
		["auto.firstByProvider.anthropic must be a provider/id string"],
	],
	[
		"a non-object firstByProvider",
		["go/deepseek"],
		["auto.firstByProvider must be an object"],
	],
];

for (const [label, firstByProvider, problems] of badFirst) {
	test(`${label} is a problem; only that entry is dropped`, async () => {
		const config = await sessionConfig({
			auto: { models: ["go/deepseek"], firstByProvider },
		});
		assert.deepEqual(routeProblems(config), problems);
		const valid = Array.isArray(firstByProvider)
			? {}
			: { firstByProvider: { go: "go/deepseek" } };
		assert.deepEqual(config.auto, {
			models: ["go/deepseek"],
			alwaysAsk: [],
			environment: 0,
			...valid,
		});
	});
}

test("a valid auto.jev has no problems and is in the record", async () => {
	const config = await sessionConfig({
		auto: { models: ["a/b"], jev: { allowAt: 0.9, denyAt: 0.95 } },
	});
	assert.deepEqual(routeProblems(config), []);
	assert.deepEqual(config.auto, {
		models: ["a/b"],
		alwaysAsk: [],
		environment: 0,
		jev: { allowAt: 0.9, allowFrom: "deny-score", denyAt: 0.95 },
	});
});

test("auto.jev {} takes the defaults: allowAt 0.9 from the deny score and denyAt null", async () => {
	const config = await sessionConfig({ auto: { models: ["a/b"], jev: {} } });
	assert.deepEqual(routeProblems(config), []);
	assert.deepEqual(config.auto, {
		models: ["a/b"],
		alwaysAsk: [],
		environment: 0,
		jev: { allowAt: 0.9, allowFrom: "deny-score", denyAt: null },
	});
});

test("auto.jev with denyAt null and allowAt 1 is valid", async () => {
	const config = await sessionConfig({
		auto: { models: ["a/b"], jev: { allowAt: 1, denyAt: null } },
	});
	assert.deepEqual(routeProblems(config), []);
	assert.deepEqual((config.auto as { jev?: unknown }).jev, {
		allowAt: 1,
		allowFrom: "deny-score",
		denyAt: null,
	});
});

test("auto.jev.model takes a Pi classifier model as provider/id", async () => {
	const config = await sessionConfig({
		auto: {
			models: ["a/b"],
			jev: { model: "openrouter/typesafe/jev-1.13" },
		},
	});
	assert.deepEqual(routeProblems(config), []);
	assert.deepEqual((config.auto as { jev?: unknown }).jev, {
		allowAt: 0.9,
		allowFrom: "deny-score",
		denyAt: null,
		model: "openrouter/typesafe/jev-1.13",
	});
});

test("auto.jev.allowFrom safety brings back allowing from the safety question", async () => {
	const config = await sessionConfig({
		auto: { models: ["a/b"], jev: { allowAt: 0.75, allowFrom: "safety" } },
	});
	assert.deepEqual(routeProblems(config), []);
	assert.deepEqual((config.auto as { jev?: unknown }).jev, {
		allowAt: 0.75,
		allowFrom: "safety",
		denyAt: null,
	});
});

const badJev: readonly (readonly [
	label: string,
	jev: unknown,
	problems: readonly string[],
])[] = [
	["a non-object auto.jev", true, ["auto.jev must be an object"]],
	["an array auto.jev", [0.9], ["auto.jev must be an object"]],
	[
		"allowAt 0.4",
		{ allowAt: 0.4 },
		["auto.jev.allowAt must be a number above 0.5 and at most 1"],
	],
	[
		"allowAt 0.5",
		{ allowAt: 0.5 },
		["auto.jev.allowAt must be a number above 0.5 and at most 1"],
	],
	[
		"allowAt 1.1",
		{ allowAt: 1.1 },
		["auto.jev.allowAt must be a number above 0.5 and at most 1"],
	],
	[
		"allowAt null",
		{ allowAt: null },
		["auto.jev.allowAt must be a number above 0.5 and at most 1"],
	],
	[
		'denyAt "x"',
		{ allowAt: 0.9, denyAt: "x" },
		["auto.jev.denyAt must be null or a number above 0.5 and at most 1"],
	],
	[
		"an unknown key under auto.jev",
		{ allowAt: 0.9, url: "https://example.com" },
		['auto.jev: unknown key "url"'],
	],
	[
		"a model without a provider",
		{ allowAt: 0.9, model: "jev-2" },
		['auto.jev.model must be "provider/id"'],
	],
	[
		"an unknown allowFrom",
		{ allowFrom: "judge" },
		['auto.jev.allowFrom must be "deny-score" or "safety"'],
	],
];

for (const [label, jev, problems] of badJev) {
	test(`${label} is a problem and leaves Jev off`, async () => {
		const config = await sessionConfig({ auto: { models: ["a/b"], jev } });
		assert.deepEqual(routeProblems(config), problems);
		assert.deepEqual(config.auto, {
			models: ["a/b"],
			alwaysAsk: [],
			environment: 0,
		});
	});
}

test("a project file's auto.jev is ignored with the route-only problem, trusted or not", async () => {
	for (const trusted of [true, false]) {
		const gate = await loadGateSession();
		const cwd = tempProjectDir();
		gate.writeRouteConfig({ auto: { models: ["a/b"] } });
		writeProjectConfig(cwd, {
			auto: { models: ["a/b"], jev: { allowAt: 0.6, denyAt: null } },
		});
		await gate.startSession("startup", fakeContext(cwd, trusted));
		const config = gate.records()[0]?.config as ConfigShape;
		assert.deepEqual(config.files[1]?.problems, [
			'"auto" is ignored in a project file: only the user config (bouncer.json in the Pi agent dir) sets auto mode',
		]);
		assert.deepEqual(config.auto, {
			models: ["a/b"],
			alwaysAsk: [],
			environment: 0,
		});
	}
});
