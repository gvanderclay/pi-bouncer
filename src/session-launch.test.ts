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
