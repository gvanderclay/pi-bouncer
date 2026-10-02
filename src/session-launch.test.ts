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
