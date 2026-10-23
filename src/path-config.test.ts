// Path group levels in `levels`: a plain level for both directions, or an
// object naming `read` and/or `write`. Driven through the tool_call handler
// with a temporary HOME.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileCall, tempHome } from "../test/file-harness.ts";
import {
	fakeContext,
	type LoadedGate,
	loadGateSession,
	scriptedUI,
	tempProjectDir,
	uiContext,
	writeProjectConfig,
} from "../test/harness.ts";

tempHome(); // before any gate loads

async function gate(
	userConfig: object = {},
	env: Readonly<Record<string, string>> = {},
): Promise<LoadedGate> {
	const g = await loadGateSession(undefined, undefined, { userConfig, env });
	await g.startSession("startup");
	return g;
}

function messages(notices: readonly { readonly message: string }[]): string {
	return notices.map(({ message }) => message).join("\n");
}

function project(): string {
	const dir = tempProjectDir();
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("a plain level applies to both directions: path-git ask also asks for reads", async () => {
	const g = await gate({ levels: { "path-git": "ask" } });
	const ui = scriptedUI(["Deny"], project());
	await g.handler(fileCall("read", { path: ".git/config" }), ui.ctx);
	assert.equal(ui.dialogs.length, 1);
});

test("a direction object sets each direction and keeps the other default", async () => {
	const g = await gate({ levels: { "path-env": { read: "allow" } } });
	const dir = project();
	assert.equal(
		await g.handler(fileCall("read", { path: ".env" }), fakeContext(dir)),
		undefined,
	);
	const r = await g.handler(
		fileCall("write", { path: ".env", content: "A=1" }),
		fakeContext(dir),
	);
	// The write still asks, and there is no UI to answer it.
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /no one can answer/);
});

test("path-ssh can ask for writes and deny reads", async () => {
	const g = await gate({
		levels: { "path-ssh": { write: "ask", read: "deny" } },
	});
	const dir = project();
	const ui = scriptedUI(["Allow once"], dir);
	assert.equal(
		await g.handler(
			fileCall("write", { path: "~/.ssh/config", content: "" }),
			ui.ctx,
		),
		undefined,
	);
	assert.equal(ui.dialogs.length, 1);
	const read = await g.handler(
		fileCall("read", { path: "~/.ssh/config" }),
		ui.ctx,
	);
	assert.equal(read?.block, true);
	assert.match(read?.reason ?? "", /\(rule: path-ssh\)/);
});

test("an untrusted project can't turn off path-ssh, but can raise path-git", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		levels: { "path-ssh": "off", "path-git": "deny" },
	});
	const g = await loadGateSession();
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	const call = scriptedUI([], dir);
	const read = await g.handler(
		fileCall("read", { path: "~/.ssh/id_ed25519" }),
		call.ctx,
	);
	assert.equal(read?.block, true);
	assert.match(read?.reason ?? "", /\(rule: path-ssh\)/);
	const write = await g.handler(
		fileCall("write", { path: ".git/config", content: "" }),
		call.ctx,
	);
	assert.match(write?.reason ?? "", /\(rule: path-git\)/);
	assert.doesNotMatch(write?.reason ?? "", /no one can answer/);
	assert.match(
		notices[0]?.message ?? "",
		/an untrusted project may not lower "path-ssh" read/,
	);
	assert.match(
		notices[0]?.message ?? "",
		/an untrusted project may not lower "path-ssh" write/,
	);
});

test("a profile gives one agent its own path levels", async () => {
	const config = {
		profiles: { reader: { levels: { "path-env": { read: "allow" } } } },
		agents: { scout: "reader" },
	};
	const scout = await gate(config, { PI_BOUNCER_AGENT: "scout" });
	assert.equal(
		await scout.handler(
			fileCall("read", { path: ".env" }),
			fakeContext(project()),
		),
		undefined,
	);
	// Without the agent name the normal rules still deny the read.
	const plain = await gate(config);
	const denied = await plain.handler(
		fileCall("read", { path: ".env" }),
		fakeContext(project()),
	);
	assert.equal(denied?.block, true);
});

test("a profile's direction object replaces the whole entry for that group", async () => {
	const g = await gate(
		{
			levels: { "path-env": { write: "deny" } },
			profiles: { reader: { levels: { "path-env": { read: "allow" } } } },
			agents: { scout: "reader" },
		},
		{ PI_BOUNCER_AGENT: "scout" },
	);
	const dir = project();
	assert.equal(
		await g.handler(fileCall("read", { path: ".env" }), fakeContext(dir)),
		undefined,
	);
	const ui = scriptedUI(["Allow once"], dir);
	assert.equal(
		await g.handler(
			fileCall("write", { path: ".env", content: "A=1" }),
			ui.ctx,
		),
		undefined,
	);
	// The write is the built-in ask again, not the removed `deny`.
	assert.equal(ui.dialogs.length, 1);
});

test("an unknown path group is a problem, not silently ignored", async () => {
	const g = await gate({ levels: { "path-nope": "deny" } });
	const ui = uiContext();
	await g.runCommand("bouncer", "check", ui.ctx);
	assert.match(messages(ui.notices), /unknown rule "path-nope"/);
});

test("an empty direction object is a problem, and the group keeps its defaults", async () => {
	const g = await gate({ levels: { "path-ssh": {} } });
	const ui = uiContext();
	await g.runCommand("bouncer", "check", ui.ctx);
	assert.match(messages(ui.notices), /must set "read", "write" or both/);
	const read = await g.handler(
		fileCall("read", { path: "~/.ssh/id_ed25519" }),
		fakeContext(project()),
	);
	assert.equal(read?.block, true);
});

test("path-bouncer takes a write level only, and that level still asks", async () => {
	const g = await gate({ levels: { "path-bouncer": { write: "ask" } } });
	const check = uiContext();
	await g.runCommand("bouncer", "check", check.ctx);
	assert.match(messages(check.notices), /No config problems/);
	const dir = project();
	const config = join(g.agentDir, "bouncer.json");
	assert.equal(
		await g.handler(fileCall("read", { path: config }), fakeContext(dir)),
		undefined,
	);
	const ui = scriptedUI(["Deny"], dir);
	await g.handler(fileCall("write", { path: config, content: "{}" }), ui.ctx);
	assert.equal(ui.dialogs.length, 1);
});

test("path-bouncer's read key is a problem and its write cannot be off", async () => {
	const g = await gate({
		levels: { "path-bouncer": { read: "ask", write: "off" } },
	});
	const ui = uiContext();
	await g.runCommand("bouncer", "check", ui.ctx);
	assert.match(
		messages(ui.notices),
		/"path-bouncer" sets only the write level/,
	);
	assert.match(
		messages(ui.notices),
		/"path-bouncer" write must be "ask" or "deny"/,
	);
	const r = await g.handler(
		fileCall("write", {
			path: join(g.agentDir, "bouncer.json"),
			content: "{}",
		}),
		scriptedUI([], project()).ctx,
	);
	assert.equal(r?.block, true);
});

test("a trusted project may lower one direction", async () => {
	const dir = project();
	writeProjectConfig(dir, { levels: { "path-ssh": { read: "ask" } } });
	const g = await loadGateSession();
	const { ctx, notices } = uiContext(dir, true);
	await g.startSession("startup", ctx);
	assert.deepEqual(notices, []);
	const ui = scriptedUI(["Deny"], dir);
	await g.handler(fileCall("read", { path: "~/.ssh/config" }), ui.ctx);
	assert.equal(ui.dialogs.length, 1);
});

test("an untrusted project may raise one direction and is refused the other", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		levels: { "path-env": { read: "ask", write: "deny" } },
	});
	const g = await loadGateSession();
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	assert.match(
		messages(notices),
		/an untrusted project may not lower "path-env" read/,
	);
	const denied = await g.handler(
		fileCall("write", { path: ".env", content: "A=1" }),
		scriptedUI([], dir).ctx,
	);
	assert.match(denied?.reason ?? "", /\(rule: path-env\)/);
	assert.doesNotMatch(denied?.reason ?? "", /no one can answer/);
	const read = await g.handler(
		fileCall("read", { path: ".env" }),
		scriptedUI([], dir).ctx,
	);
	assert.equal(read?.block, true);
});

test("an untrusted project may not set allow, even where the default is allow", async () => {
	const dir = project();
	writeProjectConfig(dir, { levels: { "path-git": { read: "allow" } } });
	const g = await loadGateSession();
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	assert.match(
		messages(notices),
		/an untrusted project may not lower "path-git" read/,
	);
});

test("a group with its read off and its write at ask stays in the policy", async () => {
	const g = await gate({
		levels: { "path-env": { read: "off", write: "ask" } },
	});
	const dir = project();
	assert.equal(
		await g.handler(fileCall("read", { path: ".env" }), fakeContext(dir)),
		undefined,
	);
	const ui = scriptedUI(["Allow once"], dir);
	assert.equal(
		await g.handler(
			fileCall("write", { path: ".env", content: "A=1" }),
			ui.ctx,
		),
		undefined,
	);
	assert.equal(ui.dialogs.length, 1);
});

test("a profile in an untrusted project may not lower a direction", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		profiles: { reader: { levels: { "path-env": { read: "allow" } } } },
		agents: { scout: "reader" },
	});
	const g = await loadGateSession(undefined, undefined, {
		env: { PI_BOUNCER_AGENT: "scout" },
	});
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	assert.match(
		messages(notices),
		/an untrusted project may not lower "path-env" read/,
	);
	const read = await g.handler(
		fileCall("read", { path: ".env" }),
		scriptedUI([], dir).ctx,
	);
	assert.equal(read?.block, true);
});
