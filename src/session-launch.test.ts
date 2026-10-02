import assert from "node:assert/strict";
import { test } from "node:test";
import { type LoadedGate, loadGateSession } from "../test/harness.ts";
import { createModeHolder, type GateMode } from "./mode.ts";

async function gateIn(mode: GateMode): Promise<LoadedGate> {
	const holder = createModeHolder();
	holder.mode = mode;
	return loadGateSession(undefined, undefined, { mode: holder });
}

test("auto mode appends --auto and keeps the launch's args and env", async () => {
	const gate = await gateIn("auto");
	const payload = { args: ["--model", "anthropic/x"], env: { A: "1" } };
	gate.events.emit("session:launch", payload);
	assert.deepEqual(payload.args, ["--model", "anthropic/x", "--auto"]);
	assert.deepEqual(payload.env, { A: "1" });
});

test("YOLO mode appends --yolo", async () => {
	const gate = await gateIn("yolo");
	const payload = { args: [] as string[], env: {} };
	gate.events.emit("session:launch", payload);
	assert.deepEqual(payload.args, ["--yolo"]);
});

test("mode off appends nothing", async () => {
	const gate = await gateIn("off");
	const payload = { args: ["--model", "anthropic/x"], env: { A: "1" } };
	gate.events.emit("session:launch", payload);
	assert.deepEqual(payload.args, ["--model", "anthropic/x"]);
	assert.deepEqual(payload.env, { A: "1" });
});

test("a malformed payload is ignored without throwing", async () => {
	const gate = await gateIn("auto");
	for (const payload of [undefined, null, 42, "args", { env: {} }]) {
		assert.doesNotThrow(() => gate.events.emit("session:launch", payload));
	}
	const wrong = { args: "--auto", env: {} };
	assert.doesNotThrow(() => gate.events.emit("session:launch", wrong));
	assert.equal(wrong.args, "--auto");
});

const PROFILES = {
	profiles: { readonly: { levels: { "recursive-rm": "deny" } } },
	agents: { scout: "readonly", orchestrator: "readonly", ghost: "missing" },
};

async function launchEnv(
	env: Record<string, string>,
	payload: Record<string, unknown>,
	userConfig: unknown = PROFILES,
): Promise<Record<string, string>> {
	const gate = await loadGateSession(undefined, undefined, { userConfig, env });
	await gate.startSession("startup");
	const full = { args: [] as string[], env: {}, ...payload };
	gate.events.emit("session:launch", full);
	return full.env as Record<string, string>;
}

test("an agent with a profile gets its own name", async () => {
	const env = await launchEnv({}, { agent: "scout" });
	assert.deepEqual(env, { PI_BOUNCER_AGENT: "scout" });
});

test("an unmapped agent gets the parent's agent name", async () => {
	const env = await launchEnv(
		{ PI_BOUNCER_AGENT: "orchestrator" },
		{ agent: "stranger" },
	);
	assert.deepEqual(env, { PI_BOUNCER_AGENT: "orchestrator" });
});

test("an agent with a broken profile gets the parent's agent name", async () => {
	const env = await launchEnv(
		{ PI_BOUNCER_AGENT: "orchestrator" },
		{ agent: "ghost" },
	);
	assert.deepEqual(env, { PI_BOUNCER_AGENT: "orchestrator" });
});

test("an unmapped agent with the parent in no profile adds no key", async () => {
	assert.deepEqual(await launchEnv({}, { agent: "stranger" }), {});
	assert.deepEqual(
		await launchEnv({ PI_BOUNCER_AGENT: "stranger" }, { agent: "stranger" }),
		{},
	);
});

test("an existing PI_BOUNCER_AGENT in the launch env is kept", async () => {
	const env = await launchEnv(
		{},
		{ agent: "scout", env: { PI_BOUNCER_AGENT: "mine" } },
	);
	assert.deepEqual(env, { PI_BOUNCER_AGENT: "mine" });
});

test("a non-string agent is ignored", async () => {
	const env = await launchEnv(
		{ PI_BOUNCER_AGENT: "orchestrator" },
		{ agent: 7 },
	);
	assert.deepEqual(env, { PI_BOUNCER_AGENT: "orchestrator" });
});

test("a launch without an agent from a session with no profile adds no key", async () => {
	assert.deepEqual(await launchEnv({}, {}), {});
});

// The event bus catches a listener's throw and logs it, so a throw shows only
// as an "Event handler error" line; this fails on one.
function emitQuietly(gate: LoadedGate, payload: unknown): void {
	const lines: unknown[][] = [];
	const original = console.error;
	console.error = (...a: unknown[]): void => void lines.push(a);
	try {
		gate.events.emit("session:launch", payload);
	} finally {
		console.error = original;
	}
	assert.deepEqual(lines, []);
}

async function profiledGate(mode: GateMode = "auto"): Promise<LoadedGate> {
	const holder = createModeHolder();
	holder.mode = mode;
	const gate = await loadGateSession(undefined, undefined, {
		userConfig: PROFILES,
		env: { PI_BOUNCER_AGENT: "orchestrator" },
		mode: holder,
	});
	await gate.startSession("startup");
	return gate;
}

test("a frozen env does not throw and args keep the mode flag", async () => {
	const gate = await profiledGate();
	const payload = {
		args: [] as string[],
		env: Object.freeze({}),
		agent: "scout",
	};
	emitQuietly(gate, payload);
	assert.deepEqual(payload.args, ["--auto"]);
});

test("a throwing agent or env getter does not throw", async () => {
	const gate = await profiledGate();
	const boom = (): never => {
		throw new Error("boom");
	};
	const badAgent = {
		args: [] as string[],
		env: {},
		get agent(): unknown {
			return boom();
		},
	};
	emitQuietly(gate, badAgent);
	assert.deepEqual(badAgent.args, ["--auto"]);
	const badEnv = {
		args: [] as string[],
		agent: "scout",
		get env(): unknown {
			return boom();
		},
	};
	emitQuietly(gate, badEnv);
	assert.deepEqual(badEnv.args, ["--auto"]);
});

test("an env Proxy whose has trap throws does not throw", async () => {
	const gate = await profiledGate();
	const env = new Proxy(
		{},
		{
			has(): boolean {
				throw new Error("boom");
			},
		},
	);
	const payload = { args: [] as string[], env, agent: "scout" };
	emitQuietly(gate, payload);
	assert.deepEqual(payload.args, ["--auto"]);
});

test("an array env is left alone and a null env adds nothing", async () => {
	const gate = await profiledGate();
	const env: unknown[] = [];
	emitQuietly(gate, { args: [], env, agent: "scout" });
	assert.equal(Object.keys(env).length, 0);
	assert.equal(Object.hasOwn(env, "PI_BOUNCER_AGENT"), false);
	const payload = { args: [] as string[], env: null, agent: "scout" };
	emitQuietly(gate, payload);
	assert.deepEqual(payload.args, ["--auto"]);
});

test("a blank PI_BOUNCER_AGENT counts as unset; a non-blank one is kept", async () => {
	for (const blank of ["", "  "]) {
		const env = await launchEnv(
			{},
			{ agent: "scout", env: { PI_BOUNCER_AGENT: blank } },
		);
		assert.deepEqual(env, { PI_BOUNCER_AGENT: "scout" });
	}
	const kept = await launchEnv(
		{},
		{ agent: "scout", env: { PI_BOUNCER_AGENT: "x" } },
	);
	assert.deepEqual(kept, { PI_BOUNCER_AGENT: "x" });
});

test("an inherited PI_BOUNCER_AGENT does not count as set", async () => {
	const env = Object.create({ PI_BOUNCER_AGENT: "inherited" });
	const gate = await profiledGate();
	gate.events.emit("session:launch", { args: [], env, agent: "scout" });
	assert.equal(Object.hasOwn(env, "PI_BOUNCER_AGENT"), true);
	assert.equal(env.PI_BOUNCER_AGENT, "scout");
});
