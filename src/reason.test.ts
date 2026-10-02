import assert from "node:assert/strict";
import { test } from "node:test";
import { bashCall, fakeContext, loadGate, uiContext } from "../test/harness.ts";

test("the reason and notification for sudo rm -rf build are the fixed texts", async () => {
	const handler = await loadGate();
	const { ctx, notices } = uiContext();
	const result = await handler(bashCall("sudo rm -rf build"), ctx);
	assert.deepEqual(result, {
		block: true,
		reason:
			"Blocked by the user's bouncer (rule: privilege): the agent must not run anything with elevated privileges. Command: `sudo rm -rf build`. None of the command ran. Do not retry this action through another command, script, or tool. Tell the user what was blocked and why, and let them decide.",
	});
	assert.deepEqual(notices, [
		{
			message: "Bouncer denied privilege: sudo rm -rf build",
			level: "warning",
		},
	]);
});

test("without a UI the deny still applies and notify is never called", async () => {
	const handler = await loadGate();
	const ctx = fakeContext();
	let notified = false;
	Object.assign(ctx, {
		ui: {
			notify: (): void => {
				notified = true;
			},
		},
	});
	const result = await handler(bashCall("rm -rf build"), ctx);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /\(rule: recursive-rm\)/);
	assert.equal(notified, false);
});

test("a long command is truncated to 200 characters in the reason and 80 in the notification", async () => {
	// One 300-character simple command: the offending command is what is quoted.
	const command = `sudo ${"a".repeat(295)}`;
	assert.equal(command.length, 300);
	const handler = await loadGate();
	const { ctx, notices } = uiContext();
	const result = await handler(bashCall(command), ctx);
	assert.ok(
		result?.reason?.includes(`Command: \`${command.slice(0, 200)}…\`.`),
		String(result?.reason),
	);
	assert.equal(
		notices[0]?.message,
		`Bouncer denied privilege: ${command.slice(0, 80)}…`,
	);
});

test("an unparseable reason says that none of the command ran", async () => {
	const handler = await loadGate();
	const result = await handler(bashCall("eval 'fi'"), fakeContext());
	assert.equal(result?.block, true);
	assert.ok(
		result?.reason?.endsWith(
			"Command: `eval 'fi'`. None of the command ran. Rewrite it as plain, valid bash.",
		),
		String(result?.reason),
	);
});

test("the quote is the offending simple command, not the whole input", async () => {
	const handler = await loadGate();
	const result = await handler(bashCall("ls && rm -rf x"), fakeContext());
	assert.ok(
		result?.reason?.includes("Command: `rm -rf x`."),
		String(result?.reason),
	);
});

test("the first match decides", async () => {
	const handler = await loadGate();
	const result = await handler(bashCall("rm -rf a; rm -rf b"), fakeContext());
	assert.ok(
		result?.reason?.includes("Command: `rm -rf a`."),
		String(result?.reason),
	);
});

test("a command at exactly 200 characters is not truncated", async () => {
	const command = `rm ${"a".repeat(191)} -rf x`;
	assert.equal(command.length, 200);
	const handler = await loadGate();
	const result = await handler(bashCall(command), fakeContext());
	assert.ok(
		result?.reason?.includes(`Command: \`${command}\`.`),
		String(result?.reason),
	);
});
