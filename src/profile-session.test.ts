import assert from "node:assert/strict";
import { test } from "node:test";
import {
	allowingRegistry,
	JUDGE,
	modeRecords,
	registryUI,
} from "../test/auto-harness.ts";
import {
	bashCall,
	type LoadedGate,
	loadGateSession,
	type Notice,
	scriptedUI,
	tempProjectDir,
	uiContext,
	writeProjectConfig,
} from "../test/harness.ts";

const READONLY = {
	profiles: { readonly: { levels: { "recursive-rm": "deny" } } },
	agents: { scout: "readonly" },
};

async function started(
	userConfig: unknown,
	env: Readonly<Record<string, string>> = {},
): Promise<LoadedGate> {
	const gate = await loadGateSession(undefined, undefined, {
		userConfig,
		env,
	});
	await gate.startSession("startup");
	return gate;
}

async function call(
	gate: LoadedGate,
	command: string,
	answers: (string | undefined)[] = [],
): Promise<{ blocked: boolean; reason: string; dialogs: number }> {
	const ui = scriptedUI(answers);
	const result = await gate.handler(bashCall(command), ui.ctx);
	return {
		blocked: result?.block === true,
		reason: result?.reason ?? "",
		dialogs: ui.dialogs.length,
	};
}

test("a profile that denies recursive-rm denies it with no dialog; without the agent it asks", async () => {
	const scout = await started(READONLY, { PI_SUBAGENT_AGENT: "scout" });
	const denied = await call(scout, "rm -rf build");
	assert.equal(denied.blocked, true);
	assert.equal(denied.dialogs, 0);
	assert.match(denied.reason, /\(rule: recursive-rm\)/);
	const plain = await started(READONLY);
	assert.equal((await call(plain, "rm -rf build", [undefined])).dialogs, 1);
});

test("PI_BOUNCER_AGENT wins over PI_SUBAGENT_AGENT", async () => {
	const config = {
		profiles: {
			strict: { levels: { "recursive-rm": "deny" } },
			lax: { levels: { "recursive-rm": "off" } },
		},
		agents: { orchestrator: "strict", scout: "lax" },
	};
	const env = { PI_BOUNCER_AGENT: "orchestrator", PI_SUBAGENT_AGENT: "scout" };
	const gate = await started(config, env);
	const denied = await call(gate, "rm -rf build");
	assert.equal(denied.blocked, true);
	assert.match(denied.reason, /\(rule: recursive-rm\)/);
});

test("a loosening profile lets rm -rf build run, but rm -rf ~ is still denied", async () => {
	const config = {
		profiles: { worker: { levels: { "recursive-rm": "off" } } },
		agents: { builder: "worker" },
	};
	const gate = await started(config, { PI_DADDY_DEFINITION: "builder" });
	const build = await call(gate, "rm -rf build");
	assert.deepEqual(build, { blocked: false, reason: "", dialogs: 0 });
	const home = await call(gate, "rm -rf ~");
	assert.equal(home.blocked, true);
	assert.match(home.reason, /\(rule: rm-root\)/);
});

function writeProject(config: unknown): string {
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, config);
	return cwd;
}

async function inProject(
	userConfig: unknown,
	projectConfig: unknown,
	env: Readonly<Record<string, string>>,
	trusted: boolean,
): Promise<{ gate: LoadedGate; notices: Notice[] }> {
	const gate = await loadGateSession(undefined, undefined, {
		userConfig,
		env,
	});
	const cwd = writeProject(projectConfig);
	const { ctx, notices } = uiContext(cwd, trusted);
	await gate.startSession("startup", ctx);
	return { gate, notices };
}

test("an untrusted project's profile can add a deny; lowering a level is refused and reported", async () => {
	const user = { profiles: { base: {} }, agents: { scout: "base" } };
	const project = {
		profiles: {
			base: { levels: { "git-clean": "deny", "recursive-rm": "off" } },
		},
	};
	const { gate, notices } = await inProject(
		user,
		project,
		{ PI_BOUNCER_AGENT: "scout" },
		false,
	);
	const clean = await call(gate, "git clean -fd");
	assert.equal(clean.blocked, true);
	assert.match(clean.reason, /\(rule: git-clean\)/);
	assert.equal((await call(gate, "rm -rf build", [undefined])).dialogs, 1);
	assert.equal(notices.length, 1);
	assert.match(
		notices[0]?.message ?? "",
		/config\.json: profiles\.base\.levels: "recursive-rm" would loosen the rule, and the project is not trusted$/,
	);
});

const BROKEN = {
	profiles: { readonly: { mode: "yolo" } },
	agents: { scout: "readonly" },
};

test("a broken profile leaves the normal rules and warns once, naming it", async () => {
	const gate = await loadGateSession(undefined, undefined, {
		userConfig: BROKEN,
		env: { PI_SUBAGENT_AGENT: "scout" },
	});
	const { ctx, notices } = uiContext();
	await gate.startSession("startup", ctx);
	assert.equal(notices.length, 1);
	const lines = (notices[0]?.message ?? "").split("\n");
	assert.equal(
		lines.at(-1),
		'profile "readonly" for agent scout is broken, so this session uses the normal rules',
	);
	assert.equal((await call(gate, "rm -rf build", [undefined])).dialogs, 1);
});

async function modeGate(
	profileMode: string,
	flags: Readonly<Record<string, boolean>>,
	extra: object = { auto: { models: [JUDGE] } },
): Promise<{ gate: LoadedGate; notices: Notice[] }> {
	const userConfig = {
		...extra,
		profiles: { kid: { mode: profileMode } },
		agents: { scout: "kid" },
	};
	const gate = await loadGateSession(undefined, undefined, {
		userConfig,
		flags,
		env: { PI_BOUNCER_AGENT: "scout" },
	});
	const { ctx, notices } = registryUI(allowingRegistry());
	await gate.startSession("startup", ctx);
	return { gate, notices };
}

test('a profile with mode "auto" and a judge list starts auto with no flag', async () => {
	const { gate } = await modeGate("auto", {});
	assert.equal(gate.mode.mode, "auto");
	assert.deepEqual(modeRecords(gate.records()), [["auto", true, "config"]]);
});

test('--yolo with a profile of mode "off" starts YOLO', async () => {
	const { gate } = await modeGate("off", { yolo: true });
	assert.equal(gate.mode.mode, "yolo");
});

test('--auto with a profile of mode "off" starts auto', async () => {
	const { gate } = await modeGate("off", { auto: true });
	assert.equal(gate.mode.mode, "auto");
});

test('a profile of mode "off" beats startMode "auto"', async () => {
	const extra = { startMode: "auto", auto: { models: [JUDGE] } };
	const { gate, notices } = await modeGate("off", {}, extra);
	assert.equal(gate.mode.mode, "off");
	assert.deepEqual(notices, []);
});

test('a profile with mode "auto" and no judge list stays off with the refusal', async () => {
	const { gate, notices } = await modeGate("auto", {}, {});
	assert.equal(gate.mode.mode, "off");
	assert.equal(notices.length, 1);
	assert.match(notices[0]?.message ?? "", /^Auto mode stays off: /);
	assert.equal(notices[0]?.level, "warning");
});

test("the session record carries config.profile and each call record the agent and profile", async () => {
	const gate = await started(READONLY, { PI_SUBAGENT_AGENT: "scout" });
	await call(gate, "rm -rf build");
	await call(gate, "rm -rf dist");
	const [session, ...calls] = gate.records();
	const config = session?.config as { profile?: unknown };
	assert.deepEqual(config.profile, {
		state: "profile",
		agent: "scout",
		from: "PI_SUBAGENT_AGENT",
		name: "readonly",
	});
	assert.equal(calls.length, 2);
	for (const record of calls) {
		const { agent, profile } = record as { agent?: unknown; profile?: unknown };
		assert.deepEqual([agent, profile], ["scout", "readonly"]);
	}
});

test("a session with no agent name logs neither", async () => {
	const gate = await started(READONLY);
	await call(gate, "rm -rf build", [undefined]);
	const [session, record] = gate.records();
	assert.equal(record?.type, "call");
	assert.equal(Object.hasOwn(session?.config as object, "profile"), false);
	assert.equal(Object.hasOwn(record ?? {}, "agent"), false);
	assert.equal(Object.hasOwn(record ?? {}, "profile"), false);
});
