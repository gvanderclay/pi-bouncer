import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AUTO_STATUS,
	autoVerdict,
	JUDGE,
	judgedUI,
	listGate,
	noUI,
	registryUI,
} from "../test/auto-harness.ts";
import {
	bashCall,
	type FakeRegistry,
	type LoadedGate,
	verdict,
} from "../test/harness.ts";

const PAUSED_STATUS = "<warning>🤖 AUTO (paused)</warning>";
const DENY = verdict("deny", "Not asked for.");
const ALLOW = verdict("allow", "Routine.");

function gateAnswering(
	replies: readonly string[],
): Promise<{ gate: LoadedGate; fake: FakeRegistry }> {
	return listGate([JUDGE], { [JUDGE]: { reply: replies } });
}

async function judge(
	gate: LoadedGate,
	fake: FakeRegistry,
	count: number,
): Promise<void> {
	for (let i = 0; i < count; i += 1) {
		await gate.handler(bashCall("rm -rf dist"), noUI(fake));
	}
}

test("three judge denies in a row pause auto mode", async () => {
	const { gate, fake } = await gateAnswering([DENY]);
	await judge(gate, fake, 2);
	const ui = judgedUI(fake, ["Deny"]);
	await gate.handler(bashCall("rm -rf dist"), ui.ctx);
	assert.equal(ui.statuses["bouncer"], PAUSED_STATUS);
	assert.equal(gate.mode.mode, "auto");
	const paused = judgedUI(fake, ["Deny"]);
	const result = await gate.handler(bashCall("rm -rf dist"), paused.ctx);
	assert.equal(result?.block, true);
	assert.equal(fake.requests.length, 3);
	assert.equal(paused.dialogs.length, 1);
	const record = gate.records().at(-1);
	assert.deepEqual(record?.auto, { verdict: "paused", tried: [] });
});

test("deny, deny, allow, deny, deny does not pause", async () => {
	const { gate, fake } = await gateAnswering([
		DENY,
		DENY,
		ALLOW,
		DENY,
		DENY,
		ALLOW,
	]);
	await judge(gate, fake, 5);
	const ui = judgedUI(fake);
	assert.equal(await gate.handler(bashCall("rm -rf dist"), ui.ctx), undefined);
	assert.deepEqual(ui.dialogs, []);
	assert.equal(fake.requests.length, 6);
});

test("twenty denies in a session pause, however spread out", async () => {
	const replies = Array.from({ length: 20 }, () => [DENY, DENY, ALLOW]).flat();
	const { gate, fake } = await gateAnswering(replies);
	// The 20th deny is the 29th call; no three of them come in a row.
	await judge(gate, fake, 28);
	assert.equal(autoVerdict(gate.records().at(-1)), "deny");
	await judge(gate, fake, 1);
	assert.equal(fake.requests.length, 29);
	await judge(gate, fake, 1);
	assert.equal(fake.requests.length, 29);
	assert.equal(autoVerdict(gate.records().at(-1)), "paused");
});

async function pausedGate(
	replies: readonly string[] = [DENY, DENY, DENY, ALLOW],
): Promise<{ gate: LoadedGate; fake: FakeRegistry }> {
	const made = await gateAnswering(replies);
	await judge(made.gate, made.fake, 3);
	return made;
}

for (const choice of ["Allow once", "Allow for this session"]) {
	test(`while paused, ${choice} allows the call and resumes`, async () => {
		const { gate, fake } = await pausedGate();
		const ui = judgedUI(fake, [choice]);
		assert.equal(
			await gate.handler(bashCall("rm -rf dist"), ui.ctx),
			undefined,
		);
		assert.equal(ui.statuses["bouncer"], AUTO_STATUS);
		const next = judgedUI(fake);
		assert.equal(
			await gate.handler(bashCall("rm -rf build"), next.ctx),
			undefined,
		);
		assert.equal(fake.requests.length, 4);
		assert.deepEqual(next.dialogs, []);
	});
}

test("while paused, Deny does not resume", async () => {
	const { gate, fake } = await pausedGate();
	await gate.handler(bashCall("rm -rf dist"), judgedUI(fake, ["Deny"]).ctx);
	const next = judgedUI(fake, ["Deny"]);
	await gate.handler(bashCall("rm -rf dist"), next.ctx);
	assert.equal(next.dialogs.length, 1);
	assert.equal(fake.requests.length, 3);
});

test("while paused and without a UI, calls block with the no-UI reason", async () => {
	const { gate, fake } = await pausedGate();
	const result = await gate.handler(bashCall("rm -rf dist"), noUI(fake));
	assert.match(
		result?.reason ?? "",
		/recursive rm deletes whole directory trees/,
	);
	assert.equal(fake.requests.length, 3);
});

test("a session start clears the pause and the counts; the mode stays auto", async () => {
	const { gate, fake } = await pausedGate([
		DENY,
		DENY,
		DENY,
		DENY,
		DENY,
		ALLOW,
	]);
	const { ctx, statuses } = registryUI(fake);
	await gate.startSession("new", ctx);
	assert.equal(gate.mode.mode, "auto");
	assert.equal(statuses["bouncer"], AUTO_STATUS);
	await judge(gate, fake, 2);
	assert.equal(fake.requests.length, 5);
	await judge(gate, fake, 1);
	assert.equal(fake.requests.length, 6);
});

test("pausing and resuming write no record of their own", async () => {
	const { gate, fake } = await pausedGate();
	await gate.handler(
		bashCall("rm -rf dist"),
		judgedUI(fake, ["Allow once"]).ctx,
	);
	const types = gate.records().map((record) => record.type);
	assert.deepEqual(types, ["session", "auto", "call", "call", "call", "call"]);
});

test("auto mode blocks grep with no judge call and no notice", async () => {
	const { gate, fake } = await gateAnswering([ALLOW]);
	const ui = judgedUI(fake);
	const result = await gate.handler(bashCall("grep x f"), ui.ctx);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /\(rule: grep\)/);
	assert.equal(fake.requests.length, 0);
	assert.deepEqual(ui.dialogs, []);
	assert.deepEqual(ui.notices, []);
});

test("grep blocks in a row do not pause auto mode", async () => {
	const { gate, fake } = await gateAnswering([ALLOW]);
	for (let i = 0; i < 4; i += 1) {
		await gate.handler(bashCall("grep x f"), noUI(fake));
	}
	const ui = judgedUI(fake);
	assert.equal(await gate.handler(bashCall("rm -rf dist"), ui.ctx), undefined);
	assert.equal(ui.statuses["bouncer"], AUTO_STATUS);
	assert.deepEqual(ui.dialogs, []);
	assert.equal(fake.requests.length, 1);
});
