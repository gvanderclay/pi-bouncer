import assert from "node:assert/strict";
import { test } from "node:test";
import {
	bashCall,
	fakeContext,
	type Handler,
	loadGate,
	loadGateSession,
	scriptedUI,
} from "./harness.ts";

test("Allow for this session lets the same command run again without a dialog", async () => {
	const handler = await loadGate();
	const first = scriptedUI(["Allow for this session"]);
	assert.equal(await handler(bashCall("rm -rf dist"), first.ctx), undefined);
	const again = scriptedUI();
	assert.equal(await handler(bashCall("rm -rf dist"), again.ctx), undefined);
	assert.equal(again.dialogs.length, 0);
	assert.deepEqual([...first.notices, ...again.notices], []);
});

async function allowedForSession(): Promise<Handler> {
	const handler = await loadGate();
	const { ctx } = scriptedUI(["Allow for this session"], "/work");
	assert.equal(await handler(bashCall("rm -rf dist"), ctx), undefined);
	return handler;
}

const asksAgain: readonly (readonly [string, string, string])[] = [
	["a different cwd", "rm -rf dist", "/elsewhere"],
	["a different command", "rm -rf src", "/work"],
	["extra whitespace", "rm -rf dist ", "/work"],
];

for (const [label, command, cwd] of asksAgain) {
	test(`a session allow does not cover ${label}`, async () => {
		const handler = await allowedForSession();
		const { ctx, dialogs } = scriptedUI(["Deny"], cwd);
		const result = await handler(bashCall(command), ctx);
		assert.equal(result?.block, true);
		assert.equal(dialogs.length, 1);
	});
}

test("Allow once records nothing", async () => {
	const handler = await loadGate();
	await handler(bashCall("rm -rf dist"), scriptedUI(["Allow once"]).ctx);
	const again = scriptedUI(["Deny"]);
	const result = await handler(bashCall("rm -rf dist"), again.ctx);
	assert.equal(result?.block, true);
	assert.equal(again.dialogs.length, 1);
});

for (const reason of ["startup", "reload", "new", "resume", "fork"] as const) {
	test(`session_start (${reason}) forgets the session allows`, async () => {
		const { handler, startSession } = await loadGateSession();
		const first = scriptedUI(["Allow for this session"]);
		assert.equal(await handler(bashCall("rm -rf dist"), first.ctx), undefined);
		await startSession(reason);
		const again = scriptedUI(["Deny"]);
		const result = await handler(bashCall("rm -rf dist"), again.ctx);
		assert.equal(result?.block, true);
		assert.equal(again.dialogs.length, 1);
	});
}

test("a new bouncer instance does not share the store", async () => {
	await allowedForSession();
	const fresh = await loadGate();
	const { ctx, dialogs } = scriptedUI(["Deny"]);
	assert.equal((await fresh(bashCall("rm -rf dist"), ctx))?.block, true);
	assert.equal(dialogs.length, 1);
});

test("inside a multi-match line, session-allowed matches are skipped silently", async () => {
	const handler = await loadGate();
	const line = "rm -rf dist && git reset --hard";
	const first = scriptedUI(["Allow for this session", "Deny"]);
	assert.equal((await handler(bashCall(line), first.ctx))?.block, true);
	assert.equal(first.dialogs.length, 2);
	const again = scriptedUI(["Allow once"]);
	assert.equal(await handler(bashCall(line), again.ctx), undefined);
	assert.deepEqual(
		again.dialogs.map((dialog) => dialog.title),
		[
			"Bouncer: git reset --hard discards uncommitted changes (rule: git-reset-hard)\ngit reset --hard",
		],
	);
});

test("without a UI the store is ignored and the bouncer denies as v1 does", async () => {
	const handler = await allowedForSession();
	const result = await handler(bashCall("rm -rf dist"), fakeContext());
	assert.equal(result?.block, true);
	assert.match(
		result?.reason ?? "",
		/^Blocked by the user's bouncer \(rule: recursive-rm\)/,
	);
});
