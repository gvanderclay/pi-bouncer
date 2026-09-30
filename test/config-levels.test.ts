// The bouncer config's rule levels, through the bouncer's Pi events.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
	bashCall,
	fakeContext,
	loadGateSession,
	scriptedUI,
	tempProjectDir,
	uiContext,
	writeProjectConfig,
} from "./harness.ts";

test("a route config making git-push-force deny blocks it without a dialog", async () => {
	const { handler, startSession, writeRouteConfig } = await loadGateSession();
	writeRouteConfig({ levels: { "git-push-force": "deny" } });
	await startSession("startup");
	const { ctx, dialogs, notices } = scriptedUI();
	const result = await handler(bashCall("git push --force"), ctx);
	assert.equal(dialogs.length, 0);
	assert.equal(result?.block, true);
	assert.ok(result?.reason?.includes("(rule: git-push-force)"));
	assert.deepEqual(notices, [
		{
			message: "Bouncer denied git-push-force: git push --force",
			level: "warning",
		},
	]);
});

test("a route config making privilege ask opens one dialog for sudo ls", async () => {
	const { handler, startSession, writeRouteConfig } = await loadGateSession();
	writeRouteConfig({ levels: { privilege: "ask" } });
	await startSession("startup");
	const { ctx, dialogs } = scriptedUI(["Allow once"]);
	assert.equal(await handler(bashCall("sudo ls"), ctx), undefined);
	assert.equal(dialogs.length, 1);
	assert.ok(dialogs[0]?.title.includes("(rule: privilege)"));
});

test("a loosened match beside a hard deny still denies without a dialog", async () => {
	const { handler, startSession, writeRouteConfig } = await loadGateSession();
	writeRouteConfig({ levels: { privilege: "ask" } });
	await startSession("startup");
	const { ctx, dialogs } = scriptedUI();
	const result = await handler(bashCall("sudo ls && shutdown -h now"), ctx);
	assert.equal(dialogs.length, 0);
	assert.ok(result?.reason?.includes("(rule: power)"));
});

test("with no route config, levels stay built-in after session start", async () => {
	const { handler, startSession } = await loadGateSession();
	await startSession("startup");
	const push = scriptedUI(["Deny"]);
	await handler(bashCall("git push --force"), push.ctx);
	assert.equal(push.dialogs.length, 1);
	const sudo = scriptedUI();
	await handler(bashCall("sudo ls"), sudo.ctx);
	assert.equal(sudo.dialogs.length, 0);
});

test("before the first session start, the route config is not applied", async () => {
	const { handler, writeRouteConfig } = await loadGateSession();
	writeRouteConfig({ levels: { privilege: "ask" } });
	const { ctx, dialogs } = scriptedUI();
	const result = await handler(bashCall("sudo ls"), ctx);
	assert.equal(dialogs.length, 0);
	assert.equal(result?.block, true);
});

test("an edited config applies at the next session start, and session allows drop", async () => {
	const { handler, startSession, writeRouteConfig } = await loadGateSession();
	writeRouteConfig({ levels: { privilege: "ask" } });
	await startSession("startup");
	await handler(
		bashCall("sudo ls"),
		scriptedUI(["Allow for this session"]).ctx,
	);
	writeRouteConfig({ levels: { privilege: "ask", "git-push-force": "deny" } });
	// Not yet: the running session keeps the level it started with.
	const unchanged = scriptedUI(["Deny"]);
	await handler(bashCall("git push --force"), unchanged.ctx);
	assert.equal(unchanged.dialogs.length, 1);
	await startSession("reload");
	const sudo = scriptedUI(["Deny"]);
	await handler(bashCall("sudo ls"), sudo.ctx);
	assert.equal(sudo.dialogs.length, 1);
	const push = scriptedUI();
	const result = await handler(bashCall("git push --force"), push.ctx);
	assert.equal(push.dialogs.length, 0);
	assert.equal(result?.block, true);
});

test("a broken route file warns once, falls back to built-in, and still logs", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig('{"levels": {"privilege": "ask"');
	const { ctx, notices } = uiContext();
	await gate.startSession("startup", ctx);
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.level, "warning");
	const path = join(gate.agentDir, "bouncer.json");
	assert.ok(notices[0]?.message.includes(`${path}: not valid JSON`));
	const sudo = scriptedUI();
	const result = await gate.handler(bashCall("sudo ls"), sudo.ctx);
	assert.equal(sudo.dialogs.length, 0);
	assert.equal(result?.block, true);
	assert.deepEqual(
		gate.records().map(({ type }) => type),
		["session", "call"],
	);
});

test("every problem is listed in the one warning", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ rules: [], levels: { unparseable: "ask" } });
	const { ctx, notices } = uiContext();
	await gate.startSession("startup", ctx);
	assert.equal(notices.length, 1);
	assert.match(notices[0]?.message ?? "", /"rules" is not supported yet/);
	assert.match(notices[0]?.message ?? "", /"unparseable" is always deny/);
	const unreadable = await gate.handler(
		bashCall("echo 'unterminated"),
		scriptedUI().ctx,
	);
	assert.ok(unreadable?.reason?.includes("(rule: unparseable)"));
});

test("each session start warns again; a valid file or no UI never warns", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ bogus: true });
	const { ctx, notices } = uiContext();
	await gate.startSession("startup", ctx);
	await gate.startSession("reload", ctx);
	assert.equal(notices.length, 2);
	await gate.startSession("new", fakeContext());
	gate.writeRouteConfig({ levels: { privilege: "ask" } });
	await gate.startSession("reload", ctx);
	assert.equal(notices.length, 2);
});

test("the session's project file overrides the route's level", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ levels: { "git-push-force": "deny" } });
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { levels: { "git-push-force": "ask" } });
	await gate.startSession("startup", fakeContext(cwd));
	const { ctx, dialogs } = scriptedUI(["Deny"], cwd);
	await gate.handler(bashCall("git push --force"), ctx);
	assert.equal(dialogs.length, 1);
});

test("a route config setting levels.grep reports a problem, and grep stays blocked", async () => {
	const { handler, startSession, writeRouteConfig, agentDir } =
		await loadGateSession();
	writeRouteConfig({ levels: { grep: "ask" } });
	const ui = uiContext();
	await startSession("startup", ui.ctx);
	const path = join(agentDir, "bouncer.json");
	assert.ok(
		ui.notices.some((notice) =>
			notice.message.includes(`${path}: levels: "grep" is always deny`),
		),
		JSON.stringify(ui.notices),
	);
	const { ctx, dialogs } = scriptedUI();
	const result = await handler(bashCall("grep x f"), ctx);
	assert.equal(dialogs.length, 0);
	assert.match(result?.reason ?? "", /\(rule: grep\)/);
});
