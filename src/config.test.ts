// The bouncer config loader: every kind of problem, and what falls back.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	projectConfigPath,
	tempAgentDir,
	tempProjectDir,
	writeConfig,
	writeProjectConfig,
} from "../test/harness.ts";
import { loadConfig } from "./config.ts";
import { builtInPolicy } from "./rules/built-in-policy.ts";
import { type Policy, policyEntryName } from "./rules/rule.ts";

const DEFAULT_LOG = { rotateAboveMiB: 5, generations: 5 };

// The shipped levels, in evaluation order: unreadable-command denies first.
const BUILT_IN_LEVELS: readonly (readonly [string, string])[] = [
	["parser-unavailable", "deny"],
	["unparseable", "deny"],
	["inline-too-deep", "deny"],
	["rm-root", "deny"],
	["recursive-rm", "ask"],
	["find-delete", "ask"],
	["find-exec", "ask"],
	["fd-exec", "ask"],
	["rg-pre", "ask"],
	["opaque-exec", "ask"],
	["disk-format", "deny"],
	["dd-device", "deny"],
	["power", "deny"],
	["privilege", "deny"],
	["git-clean", "ask"],
	["git-reset-hard", "ask"],
	["git-checkout-discard", "ask"],
	["git-restore-worktree", "ask"],
	["git-stash-destroy", "ask"],
	["git-push-force", "ask"],
	["git-push-delete", "ask"],
	["remote-script", "ask"],
	["publish", "ask"],
	["gh-delete", "ask"],
	["grep", "deny"],
];

/** A policy as `[rule, level]` rows, in evaluation order. */
function rows(policy: Policy): (readonly [string, string])[] {
	return policy.map((entry) => [policyEntryName(entry), entry.level]);
}

/** The built-in rows with `changes` applied: what an effective policy holds. */
function builtInWith(
	changes: Readonly<Record<string, string>> = {},
): (readonly [string, string])[] {
	return BUILT_IN_LEVELS.map(([rule, level]) => [rule, changes[rule] ?? level]);
}

/**
 * A temp agent dir holding `config` as its route file, that file's path, and
 * a project cwd with no project file.
 */
function route(config?: unknown): {
	agentDir: string;
	path: string;
	cwd: string;
} {
	const agentDir = tempAgentDir();
	const path = join(agentDir, "bouncer.json");
	if (config !== undefined) writeConfig(path, config);
	return { agentDir, path, cwd: tempProjectDir() };
}

test("a missing route file is the built-in policy, with no problems", () => {
	const { agentDir, path, cwd } = route();
	assert.deepEqual(loadConfig(agentDir, { cwd, trusted: true }), {
		policy: builtInPolicy,
		projectTrusted: true,
		log: DEFAULT_LOG,
		startMode: "off",
		files: [
			{ path, loaded: false, problems: [] },
			{
				path: projectConfigPath(cwd),
				loaded: false,
				problems: [],
			},
		],
		problems: [],
	});
});

test("an empty object is the built-in policy, loaded", () => {
	const { agentDir, path, cwd } = route({});
	const config = loadConfig(agentDir, { cwd, trusted: true });
	assert.deepEqual(config.policy, builtInPolicy);
	assert.deepEqual(config.files[0], { path, loaded: true, problems: [] });
});

test("a valid file sets levels and log limits", () => {
	const { agentDir, cwd } = route({
		levels: { "git-push-force": "deny", privilege: "ask" },
		log: { rotateAboveMiB: 0.5, generations: 0, maxAgeDays: 90 },
	});
	const config = loadConfig(agentDir, { cwd, trusted: true });
	assert.deepEqual(
		rows(config.policy),
		builtInWith({ "git-push-force": "deny", privilege: "ask" }),
	);
	assert.deepEqual(config.log, {
		rotateAboveMiB: 0.5,
		generations: 0,
		maxAgeDays: 90,
	});
	assert.deepEqual(config.problems, []);
});

// Each row: the file, the one problem it reports, and the level changes that
// apply.
const problems: readonly (readonly [
	label: string,
	config: unknown,
	problem: string,
	levels: Readonly<Record<string, string>>,
])[] = [
	["broken JSON", '{"levels": {"privilege": "ask"', "not valid JSON", {}],
	["a top-level array", [], "the top level is not a JSON object", {}],
	["a top-level string", '"ask"', "the top level is not a JSON object", {}],
	[
		"an unknown rule",
		{ levels: { "rm-everything": "ask", privilege: "ask" } },
		'levels: unknown rule "rm-everything"',
		{ privilege: "ask" },
	],
	[
		"an unreadable-command deny",
		{ levels: { unparseable: "ask", privilege: "ask" } },
		'levels: "unparseable" is always deny',
		{ privilege: "ask" },
	],
	[
		"a steer rule",
		{ levels: { grep: "ask", privilege: "ask" } },
		'levels: "grep" is always deny',
		{ privilege: "ask" },
	],
	[
		"a level other than ask or deny",
		{ levels: { privilege: "off", "git-clean": "deny" } },
		'levels: "privilege" must be "ask" or "deny"',
		{ "git-clean": "deny" },
	],
	[
		"a levels value that is not an object",
		{ levels: ["privilege"] },
		'"levels" is not an object',
		{},
	],
	[
		"an unknown top-level key",
		{ level: { privilege: "ask" }, levels: { privilege: "ask" } },
		'unknown key "level"',
		{ privilege: "ask" },
	],
	[
		"a rules key",
		{ rules: [], levels: { privilege: "ask" } },
		'"rules" is not supported yet',
		{ privilege: "ask" },
	],
];

for (const [label, config, problem, levels] of problems) {
	test(`${label} is a problem; the valid parts apply`, () => {
		const { agentDir, path, cwd } = route(config);
		const loaded = loadConfig(agentDir, { cwd, trusted: true });
		assert.deepEqual(rows(loaded.policy), builtInWith(levels));
		assert.deepEqual(loaded.log, DEFAULT_LOG);
		const [file] = loaded.files;
		assert.equal(file?.problems.length, 1, String(file?.problems));
		assert.ok(file?.problems[0]?.includes(problem), String(file?.problems[0]));
		assert.deepEqual(loaded.problems, [`${path}: ${file?.problems[0]}`]);
	});
}

test("broken JSON and a non-object top level do not count as loaded", () => {
	for (const config of ["{", "[]"]) {
		const { agentDir, cwd } = route(config);
		assert.equal(
			loadConfig(agentDir, { cwd, trusted: true }).files[0]?.loaded,
			false,
		);
	}
});

test("an unreadable file (a directory) is a problem", () => {
	const { agentDir, path, cwd } = route();
	mkdirSync(path, { recursive: true });
	const config = loadConfig(agentDir, { cwd, trusted: true });
	assert.deepEqual(config.policy, builtInPolicy);
	assert.equal(config.files[0]?.loaded, false);
	assert.match(config.files[0]?.problems[0] ?? "", /could not be read.*EISDIR/);
});

const logProblems: readonly (readonly [
	label: string,
	log: unknown,
	problem: string,
	limits: object,
])[] = [
	["a log that is not an object", 5, '"log" is not an object', DEFAULT_LOG],
	[
		"a zero rotateAboveMiB",
		{ rotateAboveMiB: 0, generations: 2 },
		"log.rotateAboveMiB must be a positive number",
		{ rotateAboveMiB: 5, generations: 2 },
	],
	[
		"a string rotateAboveMiB",
		{ rotateAboveMiB: "5" },
		"log.rotateAboveMiB must be a positive number",
		DEFAULT_LOG,
	],
	[
		"a negative generations",
		{ generations: -1, rotateAboveMiB: 1 },
		"log.generations must be a whole number of 0 or more",
		{ rotateAboveMiB: 1, generations: 5 },
	],
	[
		"a fractional generations",
		{ generations: 1.5 },
		"log.generations must be a whole number of 0 or more",
		DEFAULT_LOG,
	],
	[
		"a zero maxAgeDays",
		{ maxAgeDays: 0 },
		"log.maxAgeDays must be a positive whole number",
		DEFAULT_LOG,
	],
	[
		"a fractional maxAgeDays",
		{ maxAgeDays: 2.5, generations: 1 },
		"log.maxAgeDays must be a positive whole number",
		{ rotateAboveMiB: 5, generations: 1 },
	],
	[
		"an unknown log key",
		{ maxAge: 30, maxAgeDays: 30 },
		'log: unknown key "maxAge"',
		{ ...DEFAULT_LOG, maxAgeDays: 30 },
	],
];

for (const [label, log, problem, limits] of logProblems) {
	test(`${label} is a problem; the valid limits apply`, () => {
		const { agentDir, cwd } = route({ log, levels: { privilege: "ask" } });
		const config = loadConfig(agentDir, { cwd, trusted: true });
		assert.deepEqual(config.log, limits);
		assert.deepEqual(rows(config.policy), builtInWith({ privilege: "ask" }));
		assert.equal(config.problems.length, 1, String(config.problems));
		assert.ok(
			config.problems[0]?.includes(problem),
			String(config.problems[0]),
		);
	});
}

test("every problem in one file is reported", () => {
	const { agentDir, cwd } = route({
		rules: [],
		levels: { nope: "ask", privilege: "maybe" },
		log: { generations: -2 },
	});
	assert.equal(loadConfig(agentDir, { cwd, trusted: true }).problems.length, 4);
});

/** A temp route and project, each holding its config when one is given. */
function routeAndProject(
	routeConfig: unknown,
	projectConfig: unknown,
): { agentDir: string; cwd: string; projectPath: string } {
	const { agentDir, cwd } = route(routeConfig);
	const projectPath = projectConfigPath(cwd);
	if (projectConfig !== undefined) writeProjectConfig(cwd, projectConfig);
	return { agentDir, cwd, projectPath };
}

test("the project file overrides the route's levels entry by entry", () => {
	const { agentDir, cwd } = routeAndProject(
		{ levels: { "git-push-force": "deny", privilege: "ask" } },
		{ levels: { "git-push-force": "ask", "git-clean": "deny" } },
	);
	assert.deepEqual(
		rows(loadConfig(agentDir, { cwd, trusted: true }).policy),
		builtInWith({
			"git-push-force": "ask",
			privilege: "ask",
			"git-clean": "deny",
		}),
	);
});

test("files list the route file, then the project file", () => {
	const { agentDir, cwd, projectPath } = routeAndProject(undefined, {});
	assert.deepEqual(loadConfig(agentDir, { cwd, trusted: true }).files, [
		{
			path: join(agentDir, "bouncer.json"),
			loaded: false,
			problems: [],
		},
		{ path: projectPath, loaded: true, problems: [] },
	]);
});

test("a project file in a parent of the cwd is not read", () => {
	const { agentDir, cwd } = routeAndProject(undefined, {
		levels: { privilege: "ask" },
	});
	const below = join(cwd, "sub");
	mkdirSync(below, { recursive: true });
	const config = loadConfig(agentDir, { cwd: below, trusted: true });
	assert.deepEqual(config.policy, builtInPolicy);
	assert.deepEqual(config.files[1], {
		path: projectConfigPath(below),
		loaded: false,
		problems: [],
	});
});

test("a project log section is ignored with a problem; the route's limits apply", () => {
	const { agentDir, cwd, projectPath } = routeAndProject(
		{ log: { generations: 2 } },
		{ log: { generations: 0, maxAgeDays: 1 } },
	);
	const config = loadConfig(agentDir, { cwd, trusted: true });
	assert.deepEqual(config.log, { rotateAboveMiB: 5, generations: 2 });
	assert.equal(config.problems.length, 1);
	assert.ok(
		config.problems[0]?.startsWith(`${projectPath}: `),
		String(config.problems[0]),
	);
	assert.match(config.problems[0] ?? "", /"log" is ignored in a project/);
});

test("a broken project file falls back to the route's levels", () => {
	const { agentDir, cwd, projectPath } = routeAndProject(
		{ levels: { privilege: "ask" } },
		"{",
	);
	const config = loadConfig(agentDir, { cwd, trusted: true });
	assert.deepEqual(rows(config.policy), builtInWith({ privilege: "ask" }));
	assert.equal(config.files[1]?.loaded, false);
	assert.ok(config.problems[0]?.startsWith(`${projectPath}: not valid JSON`));
});

test("an invalid project entry keeps the route's level for that rule", () => {
	const { agentDir, cwd } = routeAndProject(
		{ levels: { privilege: "ask" } },
		{ levels: { privilege: "never" } },
	);
	assert.deepEqual(
		rows(loadConfig(agentDir, { cwd, trusted: true }).policy),
		builtInWith({ privilege: "ask" }),
	);
});
