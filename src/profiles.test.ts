import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFrom } from "./agent-env.ts";
import { chooseProfile, profiledAgents } from "./profile-resolve.ts";
import {
	type ParsedProfile,
	type Profile,
	validAgents,
	validProfiles,
	withProfile,
} from "./profiles.ts";
import type { CustomRule } from "./rules/custom.ts";

const AGENT_CASES = [
	["none set", {}, undefined],
	[
		"first variable wins",
		{
			PI_BOUNCER_AGENT: "a",
			PI_SUBAGENT_AGENT: "b",
			PI_DADDY_DEFINITION: "c",
		},
		{ name: "a", variable: "PI_BOUNCER_AGENT" },
	],
	[
		"second beats third",
		{ PI_SUBAGENT_AGENT: "b", PI_DADDY_DEFINITION: "c" },
		{ name: "b", variable: "PI_SUBAGENT_AGENT" },
	],
	[
		"a blank value is skipped",
		{ PI_BOUNCER_AGENT: "  ", PI_DADDY_DEFINITION: "c" },
		{ name: "c", variable: "PI_DADDY_DEFINITION" },
	],
	[
		"the name is trimmed",
		{ PI_BOUNCER_AGENT: " scout " },
		{ name: "scout", variable: "PI_BOUNCER_AGENT" },
	],
	[
		"only blank values",
		{ PI_BOUNCER_AGENT: "", PI_SUBAGENT_AGENT: " " },
		undefined,
	],
] as const;

for (const [label, env, expected] of AGENT_CASES) {
	test(`agentFrom: ${label}`, () => {
		assert.deepEqual(agentFrom(env), expected);
	});
}

const YOLO =
	'profiles.w.mode: "yolo" is not allowed: YOLO mode starts only with pi --yolo or /yolo';

const BROKEN_CASES: [string, unknown, string][] = [
	["an unknown key", { w: { colour: 1 } }, 'profiles.w: unknown key "colour"'],
	[
		"a bad level",
		{ w: { levels: { "rm-root": "off" } } },
		'profiles.w.levels: "rm-root" must be "ask" or "deny"; it is in the always-deny set, so it cannot be off',
	],
	["mode yolo", { w: { mode: "yolo" } }, YOLO],
	[
		"a bad mode",
		{ w: { mode: "on" } },
		'profiles.w.mode must be "off" or "auto"',
	],
	["a non-object profile", { w: 3 }, "profiles.w: is not an object"],
	[
		"a bad profile name",
		{ "Bad Name": {} },
		"profiles.Bad Name: the name must be lowercase letters, digits and dashes",
	],
	[
		"a bad rule",
		{ w: { rules: [{ name: "x" }] } },
		'profiles.w.rules[0]: "command" must be a program name or a list of them',
	],
	[
		"a bad protect",
		{ w: { protect: { home: "x" } } },
		'profiles.w: "protect.home" must be a list',
	],
];

for (const [label, value, problem] of BROKEN_CASES) {
	test(`validProfiles: ${label} makes the profile broken`, () => {
		const problems: string[] = [];
		const parsed = validProfiles(value, problems);
		assert.deepEqual(problems, [problem]);
		const name = Object.keys(value as object)[0] as string;
		assert.deepEqual(parsed[name], { kind: "broken", problems: [problem] });
	});
}

test("validProfiles: a valid profile parses whole", () => {
	const problems: string[] = [];
	const parsed = validProfiles(
		{
			readonly: {
				levels: { publish: "deny" },
				rules: [
					{
						name: "no-commit",
						command: "git",
						args: ["commit"],
						level: "deny",
						summary: "a read-only agent does not commit",
					},
				],
				protect: { home: ["notes"] },
				mode: "off",
			},
		},
		problems,
	);
	assert.deepEqual(problems, []);
	assert.deepEqual(parsed, {
		readonly: {
			kind: "ok",
			profile: {
				levels: { publish: "deny" },
				rules: [
					{
						name: "no-commit",
						command: ["git"],
						args: ["commit"],
						level: "deny",
						summary: "a read-only agent does not commit",
					},
				],
				protect: { home: ["notes"], paths: [] },
				mode: "off",
			},
		},
	});
});

test("validProfiles: a broken profile does not hide a good one", () => {
	const problems: string[] = [];
	const parsed = validProfiles({ a: { mode: "yolo" }, b: {} }, problems);
	assert.equal(parsed["a"]?.kind, "broken");
	assert.deepEqual(parsed["b"], {
		kind: "ok",
		profile: { levels: {}, rules: [] },
	});
});

test("validProfiles: profiles must be an object", () => {
	const problems: string[] = [];
	assert.deepEqual(validProfiles([], problems), {});
	assert.deepEqual(problems, ['"profiles" is not an object']);
});

test("validAgents: a valid map", () => {
	const problems: string[] = [];
	const agents = validAgents(
		{ scout: "readonly" },
		problems,
		new Set(["readonly"]),
	);
	assert.deepEqual(agents, { scout: "readonly" });
	assert.deepEqual(problems, []);
});

const AGENT_PROBLEMS: [string, unknown, string][] = [
	[
		"a value that is not a string",
		{ scout: 3 },
		"agents.scout: must be a profile name (a string)",
	],
	[
		"a profile neither file defines",
		{ scout: "ghost" },
		'agents.scout: profile "ghost" is not defined',
	],
	["a non-object", "x", '"agents" is not an object'],
];

for (const [label, value, problem] of AGENT_PROBLEMS) {
	test(`validAgents: ${label}`, () => {
		const problems: string[] = [];
		const agents = validAgents(value, problems, new Set(["readonly"]));
		assert.deepEqual(problems, [problem]);
		assert.deepEqual(agents, {});
	});
}

const SCOUT = { name: "scout", variable: "PI_SUBAGENT_AGENT" };
const NORMAL = { levels: {}, rules: [], startMode: "off" } as const;

function ok(part: Partial<Profile> = {}): ParsedProfile {
	return { kind: "ok", profile: { levels: {}, rules: [], ...part } };
}

const BROKEN: ParsedProfile = { kind: "broken", problems: ["x"] };

function steer(name: string): CustomRule {
	return {
		name,
		command: ["x"],
		args: [],
		summary: "s",
		level: "deny",
		instead: "use y",
	} as const;
}

function choose(
	user: Parameters<typeof chooseProfile>[1],
	project: Parameters<typeof chooseProfile>[2],
	trusted = false,
): ReturnType<typeof chooseProfile> {
	return chooseProfile(SCOUT, user, project, trusted, NORMAL);
}

const FROM = { agent: "scout", from: "PI_SUBAGENT_AGENT" };

test("chooseProfile: no agent name means no profile", () => {
	const user = { agents: { scout: "r" }, profiles: { r: ok() } };
	assert.deepEqual(chooseProfile(undefined, user, {}, true, NORMAL), {
		problems: [],
	});
});

test("chooseProfile: an unmapped agent", () => {
	assert.deepEqual(
		choose({ agents: { other: "r" }, profiles: { r: ok() } }, {}),
		{
			choice: { state: "unmapped", ...FROM },
			problems: [],
		},
	);
});

test("chooseProfile: a mapped agent gets the user's profile as the layer", () => {
	const profile = {
		levels: { publish: "deny" },
		rules: [],
		mode: "off",
	} as const;
	const user = { agents: { scout: "r" }, profiles: { r: ok(profile) } };
	assert.deepEqual(choose(user, {}), {
		choice: { state: "profile", ...FROM, name: "r" },
		layer: profile,
		problems: [],
	});
});

const BROKEN_CHOICES: [
	string,
	Parameters<typeof chooseProfile>[1],
	Parameters<typeof chooseProfile>[2],
][] = [
	["a profile neither file defines", { agents: { scout: "ghost" } }, {}],
	[
		"a broken user definition",
		{ agents: { scout: "r" }, profiles: { r: BROKEN } },
		{},
	],
	[
		"a broken user definition even when the project defines it well",
		{ agents: { scout: "r" }, profiles: { r: BROKEN } },
		{ profiles: { r: ok({ levels: { publish: "deny" } }) } },
	],
	[
		"a broken project definition with no user definition",
		{ agents: { scout: "r" } },
		{ profiles: { r: BROKEN } },
	],
];

for (const [label, user, project] of BROKEN_CHOICES) {
	test(`chooseProfile: ${label} is broken, with no layer and no new problem`, () => {
		assert.deepEqual(choose(user, project, true), {
			choice: { state: "broken", ...FROM, name: user.agents?.["scout"] },
			problems: [],
		});
	});
}

test("chooseProfile: a broken project definition is dropped and the user's stands", () => {
	const user = {
		agents: { scout: "r" },
		profiles: { r: ok({ levels: { publish: "deny" } }) },
	};
	const result = choose(user, { profiles: { r: BROKEN } }, true);
	assert.equal(result.choice?.state, "profile");
	assert.deepEqual(result.layer, { levels: { publish: "deny" }, rules: [] });
	assert.deepEqual(result.problems, []);
});

test("chooseProfile: a trusted project's agents entry overrides the user's", () => {
	const user = { agents: { scout: "a" }, profiles: { a: ok(), b: ok() } };
	const result = choose(user, { agents: { scout: "b" } }, true);
	assert.deepEqual(result.choice, { state: "profile", ...FROM, name: "b" });
});

const REPLACE =
	'agents: "scout" would replace the user config\'s profile, and the project is not trusted';

test("chooseProfile: an untrusted project may not re-map an agent the user maps", () => {
	const user = { agents: { scout: "a" }, profiles: { a: ok(), b: ok() } };
	const result = choose(user, { agents: { scout: "b" } });
	assert.deepEqual(result.choice, { state: "profile", ...FROM, name: "a" });
	assert.deepEqual(result.problems, [REPLACE]);
});

test("chooseProfile: an untrusted project may not map to a user's profile", () => {
	const user = { profiles: { a: ok() } };
	const result = choose(user, { agents: { scout: "a" } });
	assert.deepEqual(result.choice, { state: "unmapped", ...FROM });
	assert.deepEqual(result.problems, [REPLACE]);
});

test("chooseProfile: an untrusted project's entry stands when the user has neither", () => {
	const project = {
		agents: { scout: "lint" },
		profiles: { lint: ok({ levels: { "recursive-rm": "deny" } }) },
	};
	const result = choose({}, project);
	assert.deepEqual(result.choice, { state: "profile", ...FROM, name: "lint" });
	assert.deepEqual(result.layer, {
		levels: { "recursive-rm": "deny" },
		rules: [],
	});
	assert.deepEqual(result.problems, []);
});

test("chooseProfile: an untrusted project's broken profile, with no user definition, is broken", () => {
	const result = choose(
		{ agents: { scout: "p" } },
		{ profiles: { p: BROKEN } },
	);
	assert.deepEqual(result, {
		choice: {
			state: "broken",
			agent: "scout",
			from: "PI_SUBAGENT_AGENT",
			name: "p",
		},
		problems: [],
	});
});

test("chooseProfile: an untrusted project's profile the user maps but does not define only tightens", () => {
	const result = choose(
		{ agents: { scout: "p" } },
		{ profiles: { p: ok({ levels: { "recursive-rm": "deny" } }) } },
	);
	assert.deepEqual(result, {
		choice: {
			state: "profile",
			agent: "scout",
			from: "PI_SUBAGENT_AGENT",
			name: "p",
		},
		layer: { levels: { "recursive-rm": "deny" }, rules: [] },
		problems: [],
	});
});

test("chooseProfile: an untrusted project's profile the user maps but does not define cannot lower a level", () => {
	const result = choose(
		{ agents: { scout: "p" } },
		{
			profiles: {
				p: ok({ levels: { "recursive-rm": "off", publish: "deny" } }),
			},
		},
	);
	assert.deepEqual(result, {
		choice: {
			state: "profile",
			agent: "scout",
			from: "PI_SUBAGENT_AGENT",
			name: "p",
		},
		layer: { levels: { publish: "deny" }, rules: [] },
		problems: [
			'profiles.p.levels: "recursive-rm" would loosen the rule, and the project is not trusted',
		],
	});
});

const P = "profiles.r.";
const USER = { agents: { scout: "r" }, profiles: { r: ok() } };

const PROJECT_LAYERS: [
	string,
	Partial<Profile>,
	boolean,
	Partial<Profile>,
	string[],
][] = [
	[
		"an untrusted project raising a level",
		{ levels: { "recursive-rm": "deny" } },
		false,
		{ levels: { "recursive-rm": "deny" } },
		[],
	],
	[
		"an untrusted project lowering a level",
		{ levels: { "recursive-rm": "off" } },
		false,
		{},
		[
			`${P}levels: "recursive-rm" would loosen the rule, and the project is not trusted`,
		],
	],
	[
		"a trusted project lowering a level",
		{ levels: { "recursive-rm": "off" } },
		true,
		{ levels: { "recursive-rm": "off" } },
		[],
	],
	[
		"a trusted project lowering an always-deny rule",
		{ levels: { "rm-root": "ask" } },
		true,
		{},
		[
			`${P}levels: "rm-root" is in the always-deny set; a project config cannot loosen it`,
		],
	],
	[
		"an untrusted project lowering an always-deny rule",
		{ levels: { "rm-root": "ask" } },
		false,
		{},
		[
			`${P}levels: "rm-root" is in the always-deny set; a project config cannot loosen it`,
		],
	],
	[
		"an untrusted project's steer rule",
		{ rules: [steer("s1")] },
		false,
		{},
		[`${P}rules: "s1" is a steer rule, and the project is not trusted`],
	],
	[
		"a trusted project's steer rule",
		{ rules: [steer("s1")] },
		true,
		{ rules: [steer("s1")] },
		[],
	],
	[
		"a trusted project's mode auto",
		{ mode: "auto" },
		true,
		{ mode: "auto" },
		[],
	],
	["a trusted project's mode off", { mode: "off" }, true, { mode: "off" }, []],
	[
		"an untrusted project's mode auto",
		{ mode: "auto" },
		false,
		{},
		[
			`${P}mode: "auto" would loosen the session, and the project is not trusted`,
		],
	],
	[
		"an untrusted project's mode off",
		{ mode: "off" },
		false,
		{ mode: "off" },
		[],
	],
	[
		"an untrusted project's protect",
		{ protect: { home: ["notes"], paths: [] } },
		false,
		{ protect: { home: ["notes"], paths: [] } },
		[],
	],
];

for (const [label, part, trusted, applied, problems] of PROJECT_LAYERS) {
	test(`chooseProfile: ${label}`, () => {
		const result = choose(USER, { profiles: { r: ok(part) } }, trusted);
		assert.deepEqual(result.layer, { levels: {}, rules: [], ...applied });
		assert.deepEqual(result.problems, problems);
	});
}

test("chooseProfile: project levels are checked against the user profile's levels", () => {
	const user = {
		agents: { scout: "r" },
		profiles: { r: ok({ levels: { "recursive-rm": "deny" } }) },
	};
	const project = {
		profiles: { r: ok({ levels: { "recursive-rm": "ask" } }) },
	};
	const result = choose(user, project);
	assert.deepEqual(result.layer?.levels, { "recursive-rm": "deny" });
	assert.equal(result.problems.length, 1);
});

test("chooseProfile: project rules add to the user profile's; a reused name is refused", () => {
	const mine = {
		name: "keep",
		command: ["x"],
		args: [],
		summary: "s",
		level: "ask",
	} as const;
	const theirs = { ...mine, name: "extra" };
	const user = {
		agents: { scout: "r" },
		profiles: { r: ok({ rules: [mine] }) },
	};
	const project = { profiles: { r: ok({ rules: [mine, theirs] }) } };
	const result = choose(user, project, true);
	assert.deepEqual(result.layer?.rules, [mine, theirs]);
	assert.deepEqual(result.problems, [
		`${P}rules: "keep" is already a rule in the user config`,
	]);
});

const KEEP = {
	name: "keep",
	command: ["x"],
	args: [],
	summary: "s",
	level: "ask",
} as const;

test("withProfile: no layer leaves the normal rules as they are", () => {
	assert.deepEqual(withProfile(NORMAL, undefined), NORMAL);
});

test("withProfile: profile levels win over normal levels", () => {
	const normal = {
		...NORMAL,
		levels: { publish: "deny", "git-clean": "ask" },
	} as const;
	const layer = { levels: { publish: "ask" }, rules: [] } as const;
	assert.deepEqual(withProfile(normal, layer).levels, {
		publish: "ask",
		"git-clean": "ask",
	});
});

test("withProfile: a user profile may set rm-root to ask", () => {
	const layer = { levels: { "rm-root": "ask" }, rules: [] } as const;
	assert.deepEqual(withProfile(NORMAL, layer).levels, { "rm-root": "ask" });
});

test("withProfile: a profile rule replaces a normal rule of the same name in place", () => {
	const other = { ...KEEP, name: "other" };
	const normal = { ...NORMAL, rules: [KEEP, other] };
	const off = { ...KEEP, level: "off" } as const;
	const added = { ...KEEP, name: "added" };
	const result = withProfile(normal, { levels: {}, rules: [off, added] });
	assert.deepEqual(result.rules, [off, other, added]);
});

test("withProfile: protect is the union", () => {
	const normal = { ...NORMAL, protect: { home: ["a"], paths: ["/x"] } };
	const layer = {
		levels: {},
		rules: [],
		protect: { home: ["a", "b"], paths: [] },
	};
	assert.deepEqual(withProfile(normal, layer).protect, {
		home: ["a", "b"],
		paths: ["/x"],
	});
});

test("withProfile: no protect on either side stays absent", () => {
	assert.equal(
		"protect" in withProfile(NORMAL, { levels: {}, rules: [] }),
		false,
	);
});

const MODES: [
	string,
	"off" | "auto",
	"off" | "auto" | undefined,
	"off" | "auto",
][] = [
	["absent leaves startMode off", "off", undefined, "off"],
	["absent leaves startMode auto", "auto", undefined, "auto"],
	["off replaces startMode auto", "auto", "off", "off"],
	["auto replaces startMode off", "off", "auto", "auto"],
];

for (const [label, startMode, mode, expected] of MODES) {
	test(`withProfile: mode ${label}`, () => {
		const layer = { levels: {}, rules: [], ...(mode && { mode }) };
		assert.equal(
			withProfile({ ...NORMAL, startMode }, layer).startMode,
			expected,
		);
	});
}

test("profiledAgents: only agents whose profile resolves", () => {
	const user = {
		agents: { scout: "r", broken: "b", ghost: "nope" },
		profiles: { r: ok(), b: BROKEN },
	};
	const project = {
		agents: { builder: "w", sneaky: "r" },
		profiles: { w: ok() },
	};
	assert.deepEqual([...profiledAgents(user, project, false)].sort(), [
		"builder",
		"scout",
	]);
});

test("profiledAgents: a trusted project's re-mapping counts", () => {
	const user = { agents: { scout: "r" }, profiles: { r: ok() } };
	const project = { agents: { scout: "b" }, profiles: { b: BROKEN } };
	assert.deepEqual([...profiledAgents(user, project, true)], []);
	assert.deepEqual([...profiledAgents(user, project, false)], ["scout"]);
});
