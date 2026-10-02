import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	type LoadedGate,
	loadGateSession,
	type Notice,
	PREFER_RG,
	tempProjectDir,
	uiContext,
} from "../test/harness.ts";
import { SCHEMA_URL } from "./commands.ts";

async function run(gate: LoadedGate, args: string): Promise<Notice[]> {
	const { ctx, notices } = uiContext(tempProjectDir());
	await gate.runCommand("bouncer", args, ctx);
	return notices;
}

async function started(
	userConfig: unknown = {},
	env: Readonly<Record<string, string>> = {},
): Promise<LoadedGate> {
	const gate = await loadGateSession(undefined, undefined, {
		userConfig,
		env,
	});
	await gate.startSession("startup");
	return gate;
}

async function text(gate: LoadedGate, args: string): Promise<string> {
	const notices = await run(gate, args);
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.level, "info");
	return notices[0]?.message ?? "";
}

test("/bouncer reports the mode, files, levels, log and auto mode", async () => {
	const gate = await started({ levels: { "recursive-rm": "deny" } });
	const status = await text(gate, "");
	assert.equal(await text(gate, "status"), status);
	const lines = status.split("\n");
	assert.equal(lines[0], "Bouncer mode: normal");
	assert.equal(lines[2], "Parser: loaded");
	assert.ok(
		lines.includes(`- ${join(gate.agentDir, "bouncer.json")} (loaded)`),
	);
	assert.ok(lines.includes("Project: trusted"));
	const deny = lines.find((line) => line.startsWith("Deny: "));
	assert.match(deny ?? "", /recursive-rm/);
	assert.ok(lines.includes(`Log: ${join(gate.logDir, "log.jsonl")}`));
	assert.ok(
		lines.includes(
			"Auto mode: no judge list (auto.models), so it cannot turn on",
		),
	);
});

test("/bouncer status names YOLO mode and a missing parser", async () => {
	const gate = await loadGateSession(() => Promise.reject(new Error("gone")));
	await gate.startSession("startup");
	await gate.runCommand("yolo", "on", uiContext().ctx);
	const lines = (await text(gate, "status")).split("\n");
	assert.equal(lines[0], "Bouncer mode: YOLO");
	assert.equal(lines[2], "Parser: missing, so every bash command is denied");
});

test("/bouncer rules lists every entry with its level and summary", async () => {
	const gate = await started({ ...PREFER_RG, levels: { "git-clean": "deny" } });
	const lines = (await text(gate, "rules")).split("\n");
	assert.equal(lines.length, 27);
	assert.ok(
		lines.includes("unparseable (deny): the command is not valid bash"),
	);
	assert.ok(
		lines.includes(
			"git-clean (deny): git clean deletes untracked files for good",
		),
	);
	assert.ok(
		lines.includes(
			"bouncer-escape (deny): starting pi with --yolo, or choosing a bouncer profile, from bash sidesteps the user's rules",
		),
	);
	assert.match(lines.at(-1) ?? "", /^grep \(deny\): .*rg/);
});

test("/bouncer status and rules show rules turned off", async () => {
	const [grep] = PREFER_RG.rules;
	const gate = await started({
		levels: { "git-clean": "off" },
		rules: [{ ...grep, level: "off" }],
	});
	const status = (await text(gate, "status")).split("\n");
	assert.ok(status.includes("Off: git-clean, grep"), status.join("\n"));
	assert.ok(!status.find((l) => l.startsWith("Ask: "))?.includes("git-clean"));
	assert.ok(!status.some((l) => l.startsWith("rm-root also protects")));
	const rules = (await text(gate, "rules")).split("\n");
	assert.equal(rules.length, 27);
	assert.ok(
		rules.includes(
			"git-clean (off): git clean deletes untracked files for good",
		),
	);
	assert.match(rules.at(-1) ?? "", /^grep \(off\): /);
});

test("/bouncer status lists the paths protect adds", async () => {
	const gate = await started({
		protect: { home: ["code"], paths: ["/srv/x"] },
	});
	const status = (await text(gate, "status")).split("\n");
	assert.ok(status.includes("rm-root also protects: ~/code, /srv/x"));
});

test("/bouncer explain replays a command under the session's config", async () => {
	const gate = await started({ levels: { "recursive-rm": "deny" } });
	const lines = (await text(gate, "explain rm -rf  dist")).split("\n");
	assert.equal(lines[0], "recursive-rm (deny): rm -rf  dist");
	assert.ok(lines.includes("with a UI: deny (recursive-rm)"));
	assert.ok(lines.includes("trust: trusted (this session)"));
});

test("/bouncer init writes the user config once", async () => {
	const gate = await started(null);
	const path = join(gate.agentDir, "bouncer.json");
	assert.equal(
		await text(gate, "init"),
		`Wrote ${path}. Your editor completes its keys from the schema; changes apply at the next session start or /reload.`,
	);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		$schema: SCHEMA_URL,
		levels: {},
	});
	gate.writeRouteConfig({ levels: { power: "ask" } });
	assert.equal(
		await text(gate, "init"),
		`${path} already exists; left as it is.`,
	);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		levels: { power: "ask" },
	});
});

test("/bouncer check re-reads the config without applying it", async () => {
	const gate = await started();
	assert.equal(
		(await text(gate, "check")).split("\n")[0],
		"No config problems.",
	);
	gate.writeRouteConfig({ levels: { nope: "ask" }, startMode: "yolo" });
	const lines = (await text(gate, "check")).split("\n");
	assert.equal(lines[0], "Config problems; these parts would be ignored:");
	assert.ok(lines.includes('  - levels: unknown rule "nope"'));
	assert.match(await text(gate, "status"), /\(absent\)/);
});

test("/bouncer with an unknown subcommand shows its usage", async () => {
	const gate = await started();
	for (const args of ["frobnicate", "explain", "explain   "]) {
		assert.deepEqual(await run(gate, args), [
			{
				message: "Usage: /bouncer [status|rules|explain <command>|init|check]",
				level: "warning",
			},
		]);
	}
});

const WELCOME = {
	message:
		"Bouncer is on: it asks before destructive bash commands. /bouncer shows rules and config.",
	level: "info",
};

test("with no user config, the first session start in a process says the bouncer is on", async () => {
	const gate = await loadGateSession(undefined, undefined, {
		userConfig: null,
	});
	const first = uiContext();
	await gate.startSession("startup", first.ctx);
	assert.deepEqual(first.notices, [WELCOME]);
	const again = uiContext();
	await gate.startSession("new", again.ctx);
	assert.deepEqual(again.notices, []);
	const reloaded = await loadGateSession(undefined, undefined, {
		userConfig: null,
		mode: gate.mode,
	});
	const afterReload = uiContext();
	await reloaded.startSession("reload", afterReload.ctx);
	assert.deepEqual(afterReload.notices, []);
});

test("no first-run notice with a user config, or without a UI", async () => {
	const withFile = await loadGateSession();
	const { ctx, notices } = uiContext();
	await withFile.startSession("startup", ctx);
	assert.deepEqual(notices, []);
	const headless = await loadGateSession(undefined, undefined, {
		userConfig: null,
	});
	await headless.startSession("startup");
	const later = uiContext();
	await headless.startSession("new", later.ctx);
	assert.deepEqual(later.notices, [WELCOME]);
});

const PROFILED = {
	profiles: { readonly: { levels: { "recursive-rm": "deny" } } },
	agents: { scout: "readonly" },
};

const PROFILE_LINES: readonly [
	string,
	unknown,
	Readonly<Record<string, string>>,
	string,
][] = [
	["no agent name", PROFILED, {}, "Profile: none"],
	[
		"a profile",
		PROFILED,
		{ PI_SUBAGENT_AGENT: "scout" },
		"Profile: readonly (agent scout, from PI_SUBAGENT_AGENT)",
	],
	[
		"an unmapped agent",
		PROFILED,
		{ PI_SUBAGENT_AGENT: "wanderer" },
		"Profile: none; agent wanderer (from PI_SUBAGENT_AGENT) has no profile",
	],
	[
		"a broken profile",
		{ profiles: { readonly: { mode: "yolo" } }, agents: { scout: "readonly" } },
		{ PI_BOUNCER_AGENT: "scout" },
		'Profile: none; "readonly" for agent scout is broken, so the normal rules apply',
	],
];

for (const [label, config, env, line] of PROFILE_LINES) {
	test(`/bouncer status shows the profile line for ${label}`, async () => {
		const lines = (await text(await started(config, env), "status")).split(
			"\n",
		);
		assert.equal(lines[1], line);
		assert.equal(lines[0], "Bouncer mode: normal");
	});
}

test("/bouncer check reports a profile problem for the session's agent", async () => {
	const gate = await started(PROFILED, { PI_SUBAGENT_AGENT: "scout" });
	gate.writeRouteConfig({
		...PROFILED,
		profiles: { readonly: { mode: "yolo" } },
	});
	const lines = (await text(gate, "check")).split("\n");
	assert.equal(lines[0], "Config problems; these parts would be ignored:");
	assert.ok(
		lines.includes(
			'  - profiles.readonly.mode: "yolo" is not allowed: YOLO mode starts only with pi --yolo or /yolo',
		),
	);
});

test("/bouncer explain replays a command under the session's profile", async () => {
	const gate = await started(PROFILED, { PI_SUBAGENT_AGENT: "scout" });
	const lines = (await text(gate, "explain rm -rf dist")).split("\n");
	assert.equal(lines[0], "recursive-rm (deny): rm -rf dist");
});
