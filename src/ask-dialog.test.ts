import assert from "node:assert/strict";
import { test } from "node:test";
import {
	abortedResult,
	bashCall,
	fakeContext,
	loadGate,
	loadGateSession,
	scriptedUI,
} from "../test/harness.ts";

test("rm -rf build answered Allow once runs, with no notification", async () => {
	const handler = await loadGate();
	const { ctx, notices, dialogs } = scriptedUI(["Allow once"]);
	const result = await handler(bashCall("rm -rf build"), ctx);
	assert.equal(result, undefined);
	assert.equal(dialogs.length, 1);
	assert.deepEqual(notices, []);
});

const USER_DENY =
	"The user denied `rm -rf build` (rule: recursive-rm). None of the command ran. Do not retry it or work around it. Ask the user how to proceed.";

for (const answer of ["Deny", undefined]) {
	test(`rm -rf build answered ${answer ?? "Escape"} blocks with the user-deny text`, async () => {
		const handler = await loadGate();
		const { ctx, notices, dialogs, aborts } = scriptedUI([answer]);
		const result = await handler(bashCall("rm -rf build"), ctx);
		assert.deepEqual(result, { block: true, reason: USER_DENY });
		assert.equal(dialogs.length, 1);
		assert.deepEqual(notices, []);
		assert.equal(aborts.count, 0);
	});
}

test("the dialog names the rule, quotes the source, and offers five choices in order", async () => {
	const handler = await loadGate();
	const { ctx, dialogs } = scriptedUI(["Deny"]);
	await handler(bashCall("ls && rm -rf build"), ctx);
	assert.equal(dialogs.length, 1);
	assert.equal(dialogs[0]?.kind, "select");
	assert.equal(
		dialogs[0]?.title,
		"Bouncer: recursive rm deletes whole directory trees (rule: recursive-rm)\nrm -rf build",
	);
	assert.deepEqual(dialogs[0]?.options, [
		"Allow once",
		"Allow for this session",
		"Deny",
		"Deny with reason",
		"Deny and stop",
		"⚠️ Allow all (YOLO)",
	]);
});

test("a long source is truncated to 200 characters in the title", async () => {
	const command = `rm ${"a".repeat(291)} -rf x`;
	const handler = await loadGate();
	const { ctx, dialogs } = scriptedUI(["Deny"]);
	const result = await handler(bashCall(command), ctx);
	assert.ok(dialogs[0]?.title.endsWith(`\n${command.slice(0, 200)}…`));
	assert.ok(result?.reason?.includes(`\`${command.slice(0, 200)}…\``));
});

test("without a UI an ask rule denies with v1's text and opens no dialog", async () => {
	const handler = await loadGate();
	const result = await handler(bashCall("rm -rf build"), fakeContext());
	assert.deepEqual(result, {
		block: true,
		reason:
			"Blocked by the user's bouncer (rule: recursive-rm): recursive rm deletes whole directory trees. Command: `rm -rf build`. None of the command ran. Do not retry this action through another command, script, or tool. Tell the user what was blocked and why, and let them decide. Exception: if this deletes a folder you made in this session (with mkdir or mktemp -d) that holds only what was made in it since, run rm again, as its own tool call with nothing else on the line, on the folder's full path written out, with no variables, ~, wildcards or relative parts, for example `rm -rf /tmp/tmp.abc123`; that runs without asking.",
	});
});

test("sudo true with a UI is a privilege deny with one warning and no dialog", async () => {
	const handler = await loadGate();
	const { ctx, notices, dialogs } = scriptedUI();
	const result = await handler(bashCall("sudo true"), ctx);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /\(rule: privilege\)/);
	assert.equal(dialogs.length, 0);
	assert.deepEqual(notices, [
		{
			message: "Bouncer denied privilege: sudo true",
			level: "warning",
		},
	]);
});

test("Deny with reason passes the trimmed reason to the model", async () => {
	const handler = await loadGate();
	const { ctx, dialogs, notices, aborts, signal } = scriptedUI([
		"Deny with reason",
		"  use git stash  ",
	]);
	const result = await handler(bashCall("rm -rf build"), ctx);
	assert.deepEqual(result, {
		block: true,
		reason: `${USER_DENY} The user's reason: use git stash`,
	});
	assert.equal(dialogs.length, 2);
	assert.equal(dialogs[1]?.kind, "input");
	assert.equal(dialogs[1]?.title, "Reason for denying (sent to the model)");
	assert.equal(dialogs[1]?.options, "");
	assert.deepEqual(dialogs[1]?.opts, { signal });
	assert.deepEqual(notices, []);
	assert.equal(aborts.count, 0);
});

for (const typed of [undefined, "   "]) {
	test(`Deny with reason and a ${typed === undefined ? "cancelled" : "blank"} reason is a plain deny`, async () => {
		const handler = await loadGate();
		const { ctx, dialogs } = scriptedUI(["Deny with reason", typed]);
		const result = await handler(bashCall("rm -rf build"), ctx);
		assert.deepEqual(result, { block: true, reason: USER_DENY });
		assert.equal(dialogs.length, 2);
	});
}

test("the select dialog gets the context's signal and no timeout", async () => {
	const handler = await loadGate();
	const { ctx, dialogs, signal } = scriptedUI(["Allow once"]);
	await handler(bashCall("rm -rf build"), ctx);
	assert.deepEqual(dialogs[0]?.opts, { signal });
});

test("Deny and stop blocks, aborts the turn once, and does not wait for it", async () => {
	const handler = await loadGate();
	const { ctx, notices, aborts } = scriptedUI(["Deny and stop"]);
	// The abort spy returns a promise that never settles: awaiting it would hang.
	const result = await handler(bashCall("rm -rf build"), ctx);
	assert.deepEqual(result, {
		block: true,
		reason: `${USER_DENY} The user stopped the turn.`,
	});
	assert.equal(aborts.count, 1);
	assert.deepEqual(notices, []);
});

test("Deny and stop on dialog 1 of 2 opens no second dialog", async () => {
	const handler = await loadGate();
	const { ctx, dialogs, aborts } = scriptedUI(["Deny and stop"]);
	const result = await handler(bashCall("rm -rf a && git reset --hard"), ctx);
	assert.equal(dialogs.length, 1);
	assert.match(
		result?.reason ?? "",
		/\(rule: recursive-rm\)\..* The user stopped the turn\.$/,
	);
	assert.equal(result?.terminate, undefined);
	assert.equal(aborts.count, 1);
});

const STOPPED = `${USER_DENY} The user stopped the turn.`;

test("after Deny and stop, the aborted call's recorded result carries the bouncer's reason", async () => {
	const { handler, endMessage } = await loadGateSession();
	const { ctx } = scriptedUI(["Deny and stop"]);
	await handler(bashCall("rm -rf build"), ctx);
	const result = await endMessage(abortedResult("t1"));
	assert.deepEqual(result, {
		message: {
			...abortedResult("t1"),
			content: [{ type: "text", text: STOPPED }],
		},
	});
});

test("the rewrite touches only the stopped call's result, and only once", async () => {
	const { handler, endMessage } = await loadGateSession();
	await handler(bashCall("rm -rf build"), scriptedUI(["Deny and stop"]).ctx);
	assert.equal(await endMessage(abortedResult("t2")), undefined);
	assert.equal(
		await endMessage({ role: "assistant", content: [], toolCallId: "t1" }),
		undefined,
	);
	assert.notEqual(await endMessage(abortedResult("t1")), undefined);
	assert.equal(await endMessage(abortedResult("t1")), undefined);
});

for (const [label, command, answers] of [
	["a plain Deny", "rm -rf build", ["Deny"]],
	["Allow once", "rm -rf build", ["Allow once"]],
	["a hard deny", "sudo true", []],
] as const) {
	test(`${label} leaves the recorded result alone`, async () => {
		const { handler, endMessage } = await loadGateSession();
		await handler(bashCall(command), scriptedUI([...answers]).ctx);
		assert.equal(await endMessage(abortedResult("t1")), undefined);
	});
}

test("session_start forgets a pending stop", async () => {
	const { handler, endMessage, startSession } = await loadGateSession();
	await handler(bashCall("rm -rf build"), scriptedUI(["Deny and stop"]).ctx);
	await startSession("new");
	assert.equal(await endMessage(abortedResult("t1")), undefined);
});
