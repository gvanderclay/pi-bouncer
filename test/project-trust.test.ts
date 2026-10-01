// What a project's bouncer config may change, through the bouncer's Pi events.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
	bashCall,
	fakeContext,
	type LogRecord,
	loadGateSession,
	scriptedUI,
	tempProjectDir,
	uiContext,
	writeOldProjectConfig,
	writeProjectConfig,
} from "./harness.ts";

/** The first session record's `config.projectTrusted`. */
function projectTrusted(records: readonly LogRecord[]): unknown {
	const config = records[0]?.config as { projectTrusted?: unknown };
	return config?.projectTrusted;
}

const alwaysDenyCommands: readonly (readonly [string, string])[] = [
	["rm-root", "rm -rf /"],
	["privilege", "sudo ls"],
	["power", "shutdown -h now"],
	["disk-format", "mkfs.ext4 /dev/sdb1"],
	["dd-device", "dd if=/dev/zero of=/dev/disk2"],
];

for (const [rule, command] of alwaysDenyCommands) {
	test(`a trusted project config setting ${rule} to ask is ignored with a warning`, async () => {
		const gate = await loadGateSession();
		const cwd = tempProjectDir();
		writeProjectConfig(cwd, { levels: { [rule]: "ask" } });
		const { ctx, notices } = uiContext(cwd, true);
		await gate.startSession("startup", ctx);
		const call = scriptedUI([], cwd);
		const result = await gate.handler(bashCall(command), call.ctx);
		assert.equal(call.dialogs.length, 0);
		assert.equal(result?.block, true);
		assert.ok(result?.reason?.includes(`(rule: ${rule})`));
		assert.equal(notices.length, 1, JSON.stringify(notices));
		assert.equal(notices[0]?.level, "warning");
		assert.match(
			notices[0]?.message ?? "",
			new RegExp(`"${rule}" is in the always-deny set`),
		);
	});
}

test("a trusted project config setting git-push-force to ask applies", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ levels: { "git-push-force": "deny" } });
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { levels: { "git-push-force": "ask" } });
	const { ctx, notices } = uiContext(cwd, true);
	await gate.startSession("startup", ctx);
	assert.equal(notices.length, 0, JSON.stringify(notices));
	const call = scriptedUI(["Deny"], cwd);
	await gate.handler(bashCall("git push --force"), call.ctx);
	assert.equal(call.dialogs.length, 1);
});

test("a route config setting privilege to ask still applies beside a project config", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ levels: { privilege: "ask" } });
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { levels: { "git-push-force": "deny" } });
	const { ctx, notices } = uiContext(cwd);
	await gate.startSession("startup", ctx);
	assert.equal(notices.length, 0, JSON.stringify(notices));
	const call = scriptedUI(["Deny"], cwd);
	await gate.handler(bashCall("sudo ls"), call.ctx);
	assert.equal(call.dialogs.length, 1);
	assert.ok(call.dialogs[0]?.title.includes("(rule: privilege)"));
});

test("a route lowering privilege to ask keeps it when the project also sets it to ask", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ levels: { privilege: "ask" } });
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { levels: { privilege: "ask" } });
	const { ctx, notices } = uiContext(cwd, true);
	await gate.startSession("startup", ctx);
	assert.match(
		notices[0]?.message ?? "",
		/"privilege" is in the always-deny set/,
	);
	const call = scriptedUI(["Deny"], cwd);
	await gate.handler(bashCall("sudo ls"), call.ctx);
	assert.equal(call.dialogs.length, 1);
});

test("a project config raising an ask rule to deny applies", async () => {
	const gate = await loadGateSession();
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { levels: { "git-push-force": "deny" } });
	await gate.startSession("startup", uiContext(cwd).ctx);
	const call = scriptedUI([], cwd);
	const result = await gate.handler(bashCall("git push --force"), call.ctx);
	assert.equal(call.dialogs.length, 0);
	assert.equal(result?.block, true);
	assert.ok(result?.reason?.includes("(rule: git-push-force)"));
});

test("an untrusted project config setting rm-root to ask is ignored with a warning", async () => {
	const gate = await loadGateSession();
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { levels: { "rm-root": "ask" } });
	const { ctx, notices } = uiContext(cwd, false);
	await gate.startSession("startup", ctx);
	const call = scriptedUI([], cwd);
	const result = await gate.handler(bashCall("rm -rf /"), call.ctx);
	assert.equal(call.dialogs.length, 0);
	assert.equal(result?.block, true);
	assert.equal(notices.length, 1, JSON.stringify(notices));
	assert.match(notices[0]?.message ?? "", /"rm-root"/);
});

test("an untrusted project config setting git-push-force to ask is ignored with a warning", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ levels: { "git-push-force": "deny" } });
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { levels: { "git-push-force": "ask" } });
	const { ctx, notices } = uiContext(cwd, false);
	await gate.startSession("startup", ctx);
	const call = scriptedUI([], cwd);
	const result = await gate.handler(bashCall("git push --force"), call.ctx);
	assert.equal(call.dialogs.length, 0);
	assert.equal(result?.block, true);
	assert.ok(result?.reason?.includes("(rule: git-push-force)"));
	assert.equal(notices.length, 1, JSON.stringify(notices));
	const path = join(cwd, ".pi", "extensions", "bouncer", "config.json");
	assert.ok(
		notices[0]?.message.includes(
			`${path}: levels: "git-push-force" would loosen the rule, and the project is not trusted`,
		),
		JSON.stringify(notices),
	);
});

test("an untrusted project config raising an ask rule to deny applies", async () => {
	const gate = await loadGateSession();
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { levels: { "git-push-force": "deny" } });
	const { ctx, notices } = uiContext(cwd, false);
	await gate.startSession("startup", ctx);
	assert.equal(notices.length, 0, JSON.stringify(notices));
	const call = scriptedUI([], cwd);
	const result = await gate.handler(bashCall("git push --force"), call.ctx);
	assert.equal(call.dialogs.length, 0);
	assert.equal(result?.block, true);
});

test("an untrusted project config repeating the built-in level applies without a warning", async () => {
	const gate = await loadGateSession();
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { levels: { "git-push-force": "ask" } });
	const { ctx, notices } = uiContext(cwd, false);
	await gate.startSession("startup", ctx);
	assert.equal(notices.length, 0, JSON.stringify(notices));
	const call = scriptedUI(["Deny"], cwd);
	await gate.handler(bashCall("git push --force"), call.ctx);
	assert.equal(call.dialogs.length, 1);
});

test("a config at the old .pi/bouncer.json is not applied, with a move warning", async () => {
	const gate = await loadGateSession();
	const cwd = tempProjectDir();
	writeOldProjectConfig(cwd, { levels: { "git-push-force": "deny" } });
	const { ctx, notices } = uiContext(cwd, true);
	await gate.startSession("startup", ctx);
	const call = scriptedUI(["Deny"], cwd);
	await gate.handler(bashCall("git push --force"), call.ctx);
	assert.equal(call.dialogs.length, 1);
	assert.equal(notices.length, 1, JSON.stringify(notices));
	const oldPath = join(cwd, ".pi", "bouncer.json");
	const newPath = join(cwd, ".pi", "extensions", "bouncer", "config.json");
	assert.ok(
		notices[0]?.message.includes(
			`${oldPath}: no longer read; move it to ${newPath}`,
		),
		JSON.stringify(notices),
	);
});

test("the session record shows whether the project was trusted", async () => {
	const trusted = await loadGateSession();
	await trusted.startSession("startup", fakeContext(tempProjectDir(), true));
	assert.equal(projectTrusted(trusted.records()), true);
	const untrusted = await loadGateSession();
	await untrusted.startSession("startup", fakeContext(tempProjectDir(), false));
	assert.equal(projectTrusted(untrusted.records()), false);
});

test("a project config's route-only keys are each ignored with their own message, in key order", async () => {
	const gate = await loadGateSession();
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { log: {}, auto: {}, startMode: "off" });
	const { ctx, notices } = uiContext(cwd, true);
	await gate.startSession("startup", ctx);
	const path = join(cwd, ".pi", "extensions", "bouncer", "config.json");
	assert.equal(notices.length, 1, JSON.stringify(notices));
	assert.equal(notices[0]?.level, "warning");
	assert.equal(
		notices[0]?.message,
		[
			"Bouncer config problems; these parts are ignored:",
			`- ${path}: "log" is ignored in a project file: only the route sets log limits`,
			`- ${path}: "auto" is ignored in a project file: only the route sets auto mode`,
			`- ${path}: "startMode" is ignored in a project file: only the route sets the start mode`,
		].join("\n"),
	);
});

test("a project config loosening an always-deny rule gets the exact refusal message", async () => {
	const gate = await loadGateSession();
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { levels: { "rm-root": "ask" } });
	const { ctx, notices } = uiContext(cwd, true);
	await gate.startSession("startup", ctx);
	const path = join(cwd, ".pi", "extensions", "bouncer", "config.json");
	assert.equal(notices.length, 1, JSON.stringify(notices));
	assert.equal(notices[0]?.level, "warning");
	assert.equal(
		notices[0]?.message,
		[
			"Bouncer config problems; these parts are ignored:",
			`- ${path}: levels: "rm-root" is in the always-deny set; a project config cannot loosen it`,
		].join("\n"),
	);
});

test("a project config's parse problems come before its level refusals", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ levels: { "git-push-force": "deny" } });
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, {
		levels: { "rm-root": "ask", "git-push-force": "ask", nope: "ask" },
		bogus: 1,
	});
	const { ctx, notices } = uiContext(cwd, false);
	await gate.startSession("startup", ctx);
	const path = join(cwd, ".pi", "extensions", "bouncer", "config.json");
	assert.equal(notices.length, 1, JSON.stringify(notices));
	assert.equal(notices[0]?.level, "warning");
	assert.equal(
		notices[0]?.message,
		[
			"Bouncer config problems; these parts are ignored:",
			`- ${path}: levels: unknown rule "nope"`,
			`- ${path}: unknown key "bogus"`,
			`- ${path}: levels: "rm-root" is in the always-deny set; a project config cannot loosen it`,
			`- ${path}: levels: "git-push-force" would loosen the rule, and the project is not trusted`,
		].join("\n"),
	);
});
