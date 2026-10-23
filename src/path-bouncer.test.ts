// path-bouncer: the agent can't write the bouncer's own config, code or Pi's
// settings, in any mode. Driven through the tool_call handler with a
// temporary HOME and agent dir.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { judgedGate, noUI } from "../test/auto-harness.ts";
import { fileCall, tempHome } from "../test/file-harness.ts";
import {
	fakeContext,
	type LoadedGate,
	loadGateSession,
	scriptedUI,
	tempProjectDir,
	uiContext,
	verdict,
} from "../test/harness.ts";
import { PACKAGE_DIR } from "./package-dir.ts";

tempHome(); // before any gate loads

async function gate(userConfig: object = {}): Promise<LoadedGate> {
	const g = await loadGateSession(undefined, undefined, { userConfig });
	await g.startSession("startup");
	return g;
}

function project(): string {
	const dir = tempProjectDir();
	mkdirSync(dir, { recursive: true });
	return dir;
}

const edit = (path: string): ToolCallEvent =>
	fileCall("edit", { path, edits: [{ oldText: "a", newText: "b" }] });

test("an edit of the user config is denied, so the agent can't loosen its guard", async () => {
	const g = await gate();
	const r = await g.handler(
		edit(join(g.agentDir, "bouncer.json")),
		fakeContext(project()),
	);
	assert.match(r?.reason ?? "", /\(rule: path-bouncer\)/);
});

test("YOLO still denies a path-bouncer write", async () => {
	const g = await gate();
	await g.runCommand("yolo", "", uiContext().ctx);
	const r = await g.handler(
		edit(join(g.agentDir, "bouncer.json")),
		fakeContext(project()),
	);
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /\(rule: path-bouncer\)/);
});

test("auto mode denies a path-bouncer write without asking the judge", async () => {
	const { gate: g, fake } = await judgedGate(verdict("allow", "fine"));
	const r = await g.handler(edit(join(g.agentDir, "bouncer.json")), noUI(fake));
	assert.equal(r?.block, true);
	assert.deepEqual(fake.requests, []);
});

for (const rel of [".pi/extensions/bouncer/config.json", ".pi/settings.json"]) {
	test(`a write to the project's ${rel} is denied`, async () => {
		const dir = project();
		const g = await gate();
		const r = await g.handler(
			fileCall("write", { path: rel, content: "{}" }),
			fakeContext(dir),
		);
		assert.match(r?.reason ?? "", /\(rule: path-bouncer\)/);
	});
}

test("a write to Pi's user settings.json is denied: it could drop the bouncer package", async () => {
	const g = await gate();
	const r = await g.handler(
		fileCall("write", {
			path: join(g.agentDir, "settings.json"),
			content: "{}",
		}),
		fakeContext(project()),
	);
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /\(rule: path-bouncer\)/);
});

test("a write into the bouncer's own code is denied", async () => {
	const g = await gate();
	const r = await g.handler(
		fileCall("write", { path: join(PACKAGE_DIR, "src/index.ts"), content: "" }),
		fakeContext(project()),
	);
	assert.match(r?.reason ?? "", /\(rule: path-bouncer\)/);
});

test("path-bouncer beats a later group: a .env in the bouncer's folder is denied, not asked", async () => {
	const g = await gate();
	const ui = scriptedUI(["Allow once"], project());
	const r = await g.handler(
		fileCall("write", { path: join(PACKAGE_DIR, ".env"), content: "" }),
		ui.ctx,
	);
	assert.equal(ui.dialogs.length, 0);
	assert.match(r?.reason ?? "", /\(rule: path-bouncer\)/);
});

test("a project symlink to the agent dir is caught through its real spelling", async () => {
	const g = await gate();
	const dir = project();
	symlinkSync(g.agentDir, join(dir, "agent"));
	const r = await g.handler(edit("agent/bouncer.json"), fakeContext(dir));
	assert.match(r?.reason ?? "", /\(rule: path-bouncer\)/);
});

test("a .pi/agent/settings.json outside any agent dir is not Pi's settings", async () => {
	const g = await gate();
	const dir = project();
	const r = await g.handler(
		fileCall("write", { path: "x/.pi/agent/settings.json", content: "{}" }),
		fakeContext(dir),
	);
	assert.equal(r, undefined);
});

test("reading the bouncer config stays allowed for debugging", async () => {
	const g = await gate();
	assert.equal(
		await g.handler(
			fileCall("read", { path: join(g.agentDir, "bouncer.json") }),
			fakeContext(project()),
		),
		undefined,
	);
});

test("path-bouncer at ask still lets the bouncer config be read", async () => {
	const g = await gate({ levels: { "path-bouncer": "ask" } });
	const ui = scriptedUI([], project());
	const r = await g.handler(
		fileCall("read", { path: join(g.agentDir, "bouncer.json") }),
		ui.ctx,
	);
	assert.equal(r, undefined);
	assert.equal(ui.dialogs.length, 0);
});

test("path-bouncer off is a problem and the write stays denied", async () => {
	const g = await gate({ levels: { "path-bouncer": "off" } });
	const ui = uiContext();
	await g.runCommand("bouncer", "check", ui.ctx);
	assert.match(
		JSON.stringify(ui.notices),
		/\\"path-bouncer\\" must be \\"ask\\" or \\"deny\\"/,
	);
	const r = await g.handler(
		edit(join(g.agentDir, "bouncer.json")),
		fakeContext(project()),
	);
	assert.equal(r?.block, true);
});

test("path-bouncer at ask opens a dialog in normal mode", async () => {
	const g = await gate({ levels: { "path-bouncer": "ask" } });
	const ui = scriptedUI(["Deny"], project());
	await g.handler(edit(join(g.agentDir, "bouncer.json")), ui.ctx);
	assert.equal(ui.dialogs.length, 1);
});

test("path-bouncer at ask still denies in YOLO mode, even after a session allow", async () => {
	const g = await gate({ levels: { "path-bouncer": "ask" } });
	const path = join(g.agentDir, "bouncer.json");
	const ui = scriptedUI(["Allow for this session"], project());
	assert.equal(await g.handler(edit(path), ui.ctx), undefined);
	await g.runCommand("yolo", "", uiContext().ctx);
	const r = await g.handler(edit(path), fakeContext(project()));
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /\(rule: path-bouncer\)/);
});
