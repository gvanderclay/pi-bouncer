// Auto mode through the bouncer's Pi events: the /auto command, the judge-list
// check, the footer status and the notices. Each load gets a fresh mode
// holder unless a test passes one, as /reload does.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AUTO_OFF,
	AUTO_ON,
	AUTO_STATUS,
	allowingRegistry,
	JUDGE,
	listedGate,
	modeRecords,
	onModel,
	registryUI,
	YOLO_STATUS,
} from "./auto-harness.ts";
import {
	bashCall,
	fakeRegistry,
	type LoadedGate,
	loadGateSession,
	SESSION_ID,
	uiContext,
	verdict,
} from "./harness.ts";

test("/auto with a resolvable list shows the auto status and notifies once", async () => {
	const gate = await listedGate();
	const { ctx, notices, statuses } = registryUI(allowingRegistry());
	await gate.runCommand("auto", "", ctx);
	assert.deepEqual(statuses, { bouncer: AUTO_STATUS });
	assert.deepEqual(notices, [AUTO_ON]);
	assert.equal(gate.mode.mode, "auto");
});

for (const args of ["off", ""]) {
	test(`/auto ${args || "(again)"} turns auto mode off and clears the status`, async () => {
		const gate = await listedGate();
		await gate.runCommand("auto", "", registryUI(allowingRegistry()).ctx);
		const { ctx, notices, statuses } = registryUI(allowingRegistry());
		await gate.runCommand("auto", args, ctx);
		assert.deepEqual(statuses, { bouncer: undefined });
		assert.deepEqual(notices, [AUTO_OFF]);
		assert.equal(gate.mode.mode, "off");
	});
}

test("/auto on while on only notifies", async () => {
	const gate = await listedGate();
	await gate.runCommand("auto", "on", registryUI(allowingRegistry()).ctx);
	const { ctx, notices, statuses } = registryUI(allowingRegistry());
	await gate.runCommand("auto", "on", ctx);
	assert.deepEqual(notices, [AUTO_ON]);
	assert.deepEqual(statuses, {});
	assert.equal(gate.mode.mode, "auto");
});

test("/auto with an unknown argument warns and changes nothing", async () => {
	const gate = await listedGate();
	const { ctx, notices, statuses } = registryUI(allowingRegistry());
	await gate.runCommand("auto", "maybe", ctx);
	assert.deepEqual(notices, [
		{ message: "Usage: /auto [on|off|status]", level: "warning" },
	]);
	assert.deepEqual(statuses, {});
	assert.equal(gate.mode.mode, "off");
});

test("/auto with no judge list refuses and names the skill", async () => {
	const gate = await loadGateSession();
	await gate.startSession("startup");
	const { ctx, notices, statuses } = registryUI(allowingRegistry());
	await gate.runCommand("auto", "", ctx);
	assert.equal(gate.mode.mode, "off");
	assert.deepEqual(statuses, {});
	assert.deepEqual(notices, [
		{
			message:
				"Auto mode stays off: the route's bouncer config has no judge list (auto.models). The auto-judge-list skill can make one.",
			level: "warning",
		},
	]);
});

test("/auto with no entry that resolves refuses, naming each entry", async () => {
	const gate = await listedGate(["gone/one", "fake/locked"]);
	const fake = fakeRegistry({
		"fake/locked": { auth: false, reply: verdict("allow", "x") },
	});
	const { ctx, notices } = registryUI(fake);
	await gate.runCommand("auto", "", ctx);
	assert.equal(gate.mode.mode, "off");
	assert.deepEqual(notices, [
		{
			message:
				"Auto mode stays off: no judge-list entry resolves (gone/one: model not found; fake/locked: no configured auth). The auto-judge-list skill can fix the list.",
			level: "warning",
		},
	]);
	assert.deepEqual(fake.requests, []);
});

test("/auto while in YOLO mode leaves YOLO for auto", async () => {
	const gate = await listedGate();
	await gate.runCommand("yolo", "", uiContext().ctx);
	const { ctx, notices, statuses } = registryUI(allowingRegistry());
	await gate.runCommand("auto", "", ctx);
	assert.equal(gate.mode.mode, "auto");
	assert.deepEqual(statuses, { bouncer: AUTO_STATUS });
	assert.deepEqual(notices, [AUTO_ON]);
});

test("/yolo while in auto mode leaves auto for YOLO", async () => {
	const gate = await listedGate();
	await gate.runCommand("auto", "", registryUI(allowingRegistry()).ctx);
	const { ctx, statuses } = uiContext();
	await gate.runCommand("yolo", "", ctx);
	assert.equal(gate.mode.mode, "yolo");
	assert.deepEqual(statuses, { bouncer: YOLO_STATUS });
});

test("/yolo off in auto mode leaves auto mode on", async () => {
	const gate = await listedGate();
	await gate.runCommand("auto", "", registryUI(allowingRegistry()).ctx);
	await gate.runCommand("yolo", "off", uiContext().ctx);
	assert.equal(gate.mode.mode, "auto");
});

test("a session start keeps auto mode and shows its status", async () => {
	const gate = await listedGate();
	await gate.runCommand("auto", "", registryUI(allowingRegistry()).ctx);
	const { ctx, statuses } = registryUI(allowingRegistry());
	await gate.startSession("new", ctx);
	assert.equal(gate.mode.mode, "auto");
	assert.deepEqual(statuses, { bouncer: AUTO_STATUS });
});

const HEAD_KEYS = ["v", "type", "time", "sessionId", "sessionFile", "cwd"];

test("/auto then /auto off writes two auto records with the usual head", async () => {
	const gate = await listedGate();
	await gate.runCommand("auto", "", registryUI(allowingRegistry()).ctx);
	await gate.runCommand("auto", "off", registryUI(allowingRegistry()).ctx);
	const records = gate.records().filter((record) => record.type === "auto");
	assert.deepEqual(modeRecords(records), [
		["auto", true, "command"],
		["auto", false, "command"],
	]);
	for (const record of records) {
		assert.deepEqual(Object.keys(record), [...HEAD_KEYS, "on", "how"]);
		assert.equal(record.v, 1);
		assert.equal(record.sessionId, SESSION_ID);
	}
});

test("/yolo then /auto writes yolo on, yolo off, then auto on", async () => {
	const gate = await listedGate();
	await gate.runCommand("yolo", "", uiContext().ctx);
	await gate.runCommand("auto", "", registryUI(allowingRegistry()).ctx);
	await gate.runCommand("yolo", "", uiContext().ctx);
	assert.deepEqual(modeRecords(gate.records()), [
		["yolo", true, "command"],
		["yolo", false, "command"],
		["auto", true, "command"],
		["auto", false, "command"],
		["yolo", true, "command"],
	]);
	const yolo = gate.records().find((record) => record.type === "yolo");
	assert.deepEqual(Object.keys(yolo ?? {}), [...HEAD_KEYS, "on", "how"]);
});

test("a refused /auto writes no record", async () => {
	const gate = await listedGate(["gone/one"]);
	await gate.runCommand("auto", "", registryUI(allowingRegistry()).ctx);
	assert.deepEqual(modeRecords(gate.records()), []);
});

test("session records carry auto beside yolo, true after a reload in auto mode", async () => {
	const first = await listedGate();
	assert.equal(first.records().at(-1)?.auto, false);
	await first.runCommand("auto", "", registryUI(allowingRegistry()).ctx);
	const reloaded = await loadGateSession(undefined, first.logDir, {
		mode: first.mode,
	});
	reloaded.writeRouteConfig({ auto: { models: [JUDGE] } });
	await reloaded.startSession("reload", registryUI(allowingRegistry()).ctx);
	const session = reloaded.records().at(-1);
	assert.equal(session?.type, "session");
	assert.equal(session?.auto, true);
	assert.equal(session?.yolo, false);
});

/** A bouncer loaded with `flags`, its route listing `models`; no session yet. */
async function flaggedGate(
	flags: Readonly<Record<string, boolean>>,
	models: readonly string[] | undefined = [JUDGE],
	mode?: LoadedGate["mode"],
): Promise<LoadedGate> {
	const gate = await loadGateSession(undefined, undefined, {
		flags,
		...(mode && { mode }),
	});
	if (models) gate.writeRouteConfig({ auto: { models } });
	return gate;
}

test("with --auto and a resolvable list the first session starts in auto mode", async () => {
	const gate = await flaggedGate({ auto: true });
	const { ctx, statuses, notices } = registryUI(allowingRegistry());
	await gate.startSession("startup", ctx);
	assert.equal(gate.mode.mode, "auto");
	assert.deepEqual(statuses, { bouncer: AUTO_STATUS });
	assert.deepEqual(notices, [AUTO_ON]);
	const records = gate.records();
	assert.deepEqual(
		records.map((record) => record.type),
		["auto", "session"],
	);
	assert.deepEqual(modeRecords(records), [["auto", true, "flag"]]);
	assert.equal(records[1]?.auto, true);
});

test("with --auto and no resolvable list the mode stays off with the refusal", async () => {
	const gate = await flaggedGate({ auto: true }, ["gone/one"]);
	const { ctx, notices } = registryUI(allowingRegistry());
	await gate.startSession("startup", ctx);
	assert.equal(gate.mode.mode, "off");
	assert.deepEqual(notices, [
		{
			message:
				"Auto mode stays off: no judge-list entry resolves (gone/one: model not found). The auto-judge-list skill can fix the list.",
			level: "warning",
		},
	]);
	assert.equal(gate.records().at(-1)?.auto, false);
});

test("--auto with --yolo is an error and leaves the mode off, with no mode record", async () => {
	const gate = await flaggedGate({ auto: true, yolo: true });
	const { ctx, notices } = registryUI(allowingRegistry());
	await gate.startSession("startup", ctx);
	assert.equal(gate.mode.mode, "off");
	assert.deepEqual(notices, [
		{
			message:
				"Bouncer: --auto and --yolo cannot be used together; the bouncer starts with neither.",
			level: "error",
		},
	]);
	assert.deepEqual(modeRecords(gate.records()), []);
});

test("--auto applies once: /auto off then a reload stays off", async () => {
	const first = await flaggedGate({ auto: true });
	await first.startSession("startup", registryUI(allowingRegistry()).ctx);
	await first.runCommand("auto", "off");
	const reloaded = await flaggedGate({ auto: true }, [JUDGE], first.mode);
	await reloaded.startSession("reload", registryUI(allowingRegistry()).ctx);
	assert.equal(reloaded.mode.mode, "off");
});

/** A bouncer whose route sets `startMode`, with `flags`; no session yet. */
async function startModeGate(
	startMode: unknown,
	flags: Readonly<Record<string, boolean>> = {},
	models: readonly string[] = [JUDGE],
	mode?: LoadedGate["mode"],
): Promise<LoadedGate> {
	const gate = await loadGateSession(undefined, undefined, {
		flags,
		...(mode && { mode }),
	});
	gate.writeRouteConfig({ startMode, auto: { models } });
	return gate;
}

test('startMode "auto" starts the first session in auto mode, recorded as config', async () => {
	const gate = await startModeGate("auto");
	const { ctx, statuses, notices } = registryUI(allowingRegistry());
	await gate.startSession("startup", ctx);
	assert.equal(gate.mode.mode, "auto");
	assert.deepEqual(statuses, { bouncer: AUTO_STATUS });
	assert.deepEqual(notices, [AUTO_ON]);
	assert.deepEqual(modeRecords(gate.records()), [["auto", true, "config"]]);
});

test('startMode "auto" with no resolvable list stays off with the refusal', async () => {
	const gate = await startModeGate("auto", {}, ["gone/one"]);
	const { ctx, notices } = registryUI(allowingRegistry());
	await gate.startSession("startup", ctx);
	assert.equal(gate.mode.mode, "off");
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.level, "warning");
});

test('--yolo overrides startMode "auto"', async () => {
	const gate = await startModeGate("auto", { yolo: true });
	await gate.startSession("startup", registryUI(allowingRegistry()).ctx);
	assert.equal(gate.mode.mode, "yolo");
	assert.deepEqual(modeRecords(gate.records()), [["yolo", true, "flag"]]);
});

test('startMode "off" or absent starts in normal mode', async () => {
	for (const startMode of ["off", undefined]) {
		const gate = await startModeGate(startMode);
		await gate.startSession("startup", registryUI(allowingRegistry()).ctx);
		assert.equal(gate.mode.mode, "off");
	}
});

test('startMode "auto" applies once: /auto off then a reload stays off', async () => {
	const first = await startModeGate("auto");
	await first.startSession("startup", registryUI(allowingRegistry()).ctx);
	await first.runCommand("auto", "off");
	const reloaded = await startModeGate("auto", {}, [JUDGE], first.mode);
	await reloaded.startSession("reload", registryUI(allowingRegistry()).ctx);
	assert.equal(reloaded.mode.mode, "off");
});

for (const [startMode, problem] of [
	[
		"yolo",
		'"startMode": "yolo" is not allowed: YOLO mode starts only with pi --yolo or /yolo',
	],
	["normal", '"startMode" must be "off" or "auto"'],
] as const) {
	test(`startMode ${JSON.stringify(startMode)} is a problem and starts off`, async () => {
		const gate = await startModeGate(startMode);
		await gate.startSession("startup", registryUI(allowingRegistry()).ctx);
		assert.equal(gate.mode.mode, "off");
		const record = gate.records().at(-1);
		const config = record?.config as {
			files: { problems: string[] }[];
		};
		assert.deepEqual(config.files[0]?.problems, [problem]);
	});
}

/** The one `/auto status` notice for `gate`, with `fake` as the registry. */
async function statusNotice(
	gate: LoadedGate,
	fake: ReturnType<typeof fakeRegistry>,
	provider?: string,
): Promise<string> {
	const { ctx: base, notices, statuses } = registryUI(fake);
	const ctx = provider === undefined ? base : onModel(base, provider);
	const before = gate.records().length;
	const mode = gate.mode.mode;
	await gate.runCommand("auto", "status", ctx);
	assert.equal(gate.mode.mode, mode);
	assert.deepEqual(statuses, {});
	assert.equal(gate.records().length, before);
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.level, "info");
	return notices[0]?.message ?? "";
}

test("/auto status lists the mode, each entry's resolve state and the prefixes, calling no model", async () => {
	const gate = await listedGate(["gone/one", JUDGE], {
		alwaysAsk: ["terraform apply"],
	});
	const fake = allowingRegistry();
	assert.equal(
		await statusNotice(gate, fake),
		[
			"Bouncer auto mode: off (paused: no)",
			"Judge list:",
			"- gone/one: model not found",
			"- fake/judge: resolves",
			"Last failures this session: none",
			"Always ask: terraform apply",
			"0 environment facts",
		].join("\n"),
	);
	assert.deepEqual(fake.requests, []);
});

test("/auto status shows a model's last failure until the next session start", async () => {
	const first = "fake/first";
	const fake = fakeRegistry({
		[first]: { reply: { throws: "ECONNRESET" } },
		[JUDGE]: { reply: verdict("allow", "routine") },
	});
	const gate = await listedGate([first, JUDGE], {
		environment: ["a throwaway clone", "no prod access"],
	});
	await gate.runCommand("auto", "", registryUI(fake).ctx);
	await gate.handler(bashCall("rm -rf dist"), registryUI(fake).ctx);
	const calls = fake.requests.length;
	assert.equal(
		await statusNotice(gate, fake),
		[
			"Bouncer auto mode: auto (paused: no)",
			"Judge list:",
			"- fake/first: resolves",
			"- fake/judge: resolves",
			"Last failures this session:",
			"- fake/first: ECONNRESET",
			"Always ask: none",
			"2 environment facts",
		].join("\n"),
	);
	assert.equal(fake.requests.length, calls);
	await gate.startSession("new", registryUI(fake).ctx);
	assert.match(
		await statusNotice(gate, fake),
		/\nLast failures this session: none\n/,
	);
});

test("/auto status with no judge list names the skill", async () => {
	const gate = await loadGateSession();
	await gate.startSession("startup");
	assert.equal(
		await statusNotice(gate, allowingRegistry()),
		[
			"Bouncer auto mode: off (paused: no)",
			"Judge list: none. The auto-judge-list skill can make one.",
			"Last failures this session: none",
			"Always ask: none",
			"0 environment facts",
		].join("\n"),
	);
});

test("/auto status shows firstByProvider and marks this session's provider", async () => {
	const gate = await listedGate(["go/deepseek", JUDGE], {
		firstByProvider: { fake: JUDGE, go: "go/deepseek" },
	});
	const fake = allowingRegistry();
	const lines = [
		"Bouncer auto mode: off (paused: no)",
		"Judge list:",
		"- go/deepseek: model not found",
		"- fake/judge: resolves",
		"First by provider:",
	];
	const tail = [
		"Last failures this session: none",
		"Always ask: none",
		"0 environment facts",
	];
	assert.equal(
		await statusNotice(gate, fake, "fake"),
		[
			...lines,
			"- fake: fake/judge (this session)",
			"- go: go/deepseek",
			...tail,
		].join("\n"),
	);
	assert.equal(
		await statusNotice(gate, fake),
		[...lines, "- fake: fake/judge", "- go: go/deepseek", ...tail].join("\n"),
	);
});
