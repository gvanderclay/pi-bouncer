import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AUTO_ON,
	AUTO_STATUS,
	allowingRegistry,
	JUDGE,
	judgedUI,
	listedGate,
	listGate,
	modeRecords,
	noUI,
} from "../test/auto-harness.ts";
import {
	bashCall,
	fakeRegistry,
	loadGateSession,
	verdict,
} from "../test/harness.ts";

const BASE_CHOICES = [
	"Allow once",
	"Allow for this session",
	"Deny",
	"Deny with reason",
	"Deny and stop",
];
const AUTO_CHOICE = "🤖 Auto mode";
const RESUME_CHOICE = "🤖 Auto mode (resume)";
const YOLO_CHOICE = "⚠️ Allow all (YOLO)";

test("with a resolvable list the choices end with Auto mode, then YOLO", async () => {
	const gate = await listedGate();
	const ui = judgedUI(allowingRegistry(), ["Deny"]);
	await gate.handler(bashCall("rm -rf dist"), ui.ctx);
	assert.deepEqual(ui.dialogs[0]?.options, [
		...BASE_CHOICES,
		AUTO_CHOICE,
		YOLO_CHOICE,
	]);
});

test("with no list the choice is absent", async () => {
	const gate = await loadGateSession();
	await gate.startSession("startup");
	const ui = judgedUI(allowingRegistry(), ["Deny"]);
	await gate.handler(bashCall("rm -rf dist"), ui.ctx);
	assert.deepEqual(ui.dialogs[0]?.options, [...BASE_CHOICES, YOLO_CHOICE]);
});

test("with no entry that resolves the choice is absent", async () => {
	const gate = await listedGate(["gone/one"]);
	const ui = judgedUI(allowingRegistry(), ["Deny"]);
	await gate.handler(bashCall("rm -rf dist"), ui.ctx);
	assert.deepEqual(ui.dialogs[0]?.options, [...BASE_CHOICES, YOLO_CHOICE]);
});

const LINE = "rm -rf dist && git clean -fdx && git reset --hard";

test("picking Auto mode allows the rest of the line and turns auto mode on", async () => {
	const fake = allowingRegistry();
	const gate = await listedGate();
	await gate.handler(
		bashCall(LINE),
		judgedUI(fake, ["Allow for this session", "Deny"]).ctx,
	);
	const ui = judgedUI(fake, [AUTO_CHOICE]);
	assert.equal(await gate.handler(bashCall(LINE), ui.ctx), undefined);
	assert.equal(ui.dialogs.length, 1);
	assert.match(ui.dialogs[0]?.title ?? "", /— 1 of 2/);
	assert.deepEqual(fake.requests, []);
	const records = gate.records();
	const call = records.at(-2);
	assert.deepEqual(call?.asks, [
		{ rule: "recursive-rm", source: "rm -rf dist", answer: "session-allowed" },
		{ rule: "git-clean", source: "git clean -fdx", answer: "allow-auto" },
		{
			rule: "git-reset-hard",
			source: "git reset --hard",
			answer: "allow-auto",
		},
	]);
	assert.deepEqual(modeRecords(records), [["auto", true, "dialog"]]);
	assert.equal(gate.mode.mode, "auto");
	assert.equal(ui.statuses["bouncer"], AUTO_STATUS);
	assert.deepEqual(ui.notices, [AUTO_ON]);
	await gate.handler(bashCall("rm -rf build"), noUI(fake));
	assert.equal(fake.requests.length, 1);
});

test("picking Auto mode adds no session allow", async () => {
	const fake = allowingRegistry();
	const gate = await listedGate();
	await gate.handler(
		bashCall("rm -rf dist"),
		judgedUI(fake, [AUTO_CHOICE]).ctx,
	);
	await gate.runCommand("auto", "off");
	const ui = judgedUI(fake, ["Deny"]);
	await gate.handler(bashCall("rm -rf dist"), ui.ctx);
	assert.equal(ui.dialogs.length, 1);
});

test("while paused the dialog offers resuming, which allows and resumes", async () => {
	const { gate, fake } = await listGate([JUDGE], {
		[JUDGE]: {
			reply: [
				verdict("deny", "no"),
				verdict("deny", "no"),
				verdict("deny", "no"),
				verdict("allow", "ok"),
			],
		},
	});
	for (let i = 0; i < 3; i += 1) {
		await gate.handler(bashCall("rm -rf dist"), noUI(fake));
	}
	const ui = judgedUI(fake, [RESUME_CHOICE]);
	assert.equal(await gate.handler(bashCall("rm -rf dist"), ui.ctx), undefined);
	assert.deepEqual(ui.dialogs[0]?.options, [
		...BASE_CHOICES,
		RESUME_CHOICE,
		YOLO_CHOICE,
	]);
	assert.equal(ui.statuses["bouncer"], AUTO_STATUS);
	assert.deepEqual(modeRecords(gate.records()), [["auto", true, "command"]]);
	const next = judgedUI(fake);
	assert.equal(
		await gate.handler(bashCall("rm -rf dist"), next.ctx),
		undefined,
	);
	assert.equal(fake.requests.length, 4);
});

test("in auto mode and not paused, a hand-off does not offer the choice", async () => {
	const fake = fakeRegistry({ [JUDGE]: { reply: verdict("ask", "unsure") } });
	const { gate } = await listGate([JUDGE], {
		[JUDGE]: { reply: verdict("ask", "unsure") },
	});
	const ui = judgedUI(fake, ["Deny"]);
	await gate.handler(bashCall("rm -rf dist"), ui.ctx);
	assert.deepEqual(ui.dialogs[0]?.options, [...BASE_CHOICES, YOLO_CHOICE]);
});
