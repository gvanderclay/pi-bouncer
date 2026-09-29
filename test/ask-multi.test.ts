import assert from "node:assert/strict";
import { test } from "node:test";
import { bashCall, fakeContext, loadGate, scriptedUI } from "./harness.ts";

for (const command of ["rm -rf x && sudo true", "sudo true; rm -rf x"]) {
	test(`a hard deny anywhere wins with no dialog: ${command}`, async () => {
		const handler = await loadGate();
		const { ctx, notices, dialogs } = scriptedUI();
		const result = await handler(bashCall(command), ctx);
		assert.equal(dialogs.length, 0);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /\(rule: privilege\)/);
		assert.deepEqual(notices, [
			{
				message: "Bouncer denied privilege: sudo true",
				level: "warning",
			},
		]);
	});
}

const RM = "Bouncer: recursive rm deletes whole directory trees";
const RESET = "Bouncer: git reset --hard discards uncommitted changes";

test("two asks on one line prompt in order, labelled 1 of 2 and 2 of 2", async () => {
	const handler = await loadGate();
	const { ctx, dialogs, notices } = scriptedUI(["Allow once", "Allow once"]);
	const result = await handler(bashCall("rm -rf a && git reset --hard"), ctx);
	assert.equal(result, undefined);
	assert.deepEqual(
		dialogs.map((dialog) => dialog.title),
		[
			`${RM} (rule: recursive-rm) — 1 of 2\nrm -rf a`,
			`${RESET} (rule: git-reset-hard) — 2 of 2\ngit reset --hard`,
		],
	);
	assert.deepEqual(notices, []);
});

test("the first deny ends the sequence", async () => {
	const handler = await loadGate();
	const { ctx, dialogs } = scriptedUI(["Deny"]);
	const result = await handler(bashCall("rm -rf a && git reset --hard"), ctx);
	assert.equal(dialogs.length, 1);
	assert.deepEqual(result, {
		block: true,
		reason:
			"The user denied `rm -rf a` (rule: recursive-rm). None of the command ran. Do not retry it or work around it. Ask the user how to proceed.",
	});
});

test("identical repeats on one line ask once, with no counter", async () => {
	const handler = await loadGate();
	const { ctx, dialogs } = scriptedUI(["Allow once"]);
	const result = await handler(bashCall("rm -rf a; rm -rf a"), ctx);
	assert.equal(result, undefined);
	assert.deepEqual(
		dialogs.map((dialog) => dialog.title),
		[`${RM} (rule: recursive-rm)\nrm -rf a`],
	);
});

test("an invocation matching two ask rules asks once per rule", async () => {
	const handler = await loadGate();
	const { ctx, dialogs } = scriptedUI(["Allow once", "Deny"]);
	const result = await handler(bashCall("find . -delete -exec rm {} +"), ctx);
	assert.deepEqual(
		dialogs.map((dialog) =>
			/\(rule: ([a-z-]+)\) — (\d of \d)/.exec(dialog.title)?.slice(1),
		),
		[
			["find-delete", "1 of 2"],
			["find-exec", "2 of 2"],
		],
	);
	assert.match(
		result?.reason ?? "",
		/^The user denied `find \. -delete -exec rm \{\} \+` \(rule: find-exec\)/,
	);
});

test("without a UI several asks deny with v1's text for the first", async () => {
	const handler = await loadGate();
	const result = await handler(
		bashCall("rm -rf a && git reset --hard"),
		fakeContext(),
	);
	assert.equal(result?.block, true);
	assert.match(
		result?.reason ?? "",
		/^Blocked by the user's bouncer \(rule: recursive-rm\)/,
	);
	assert.ok(result?.reason?.includes("Command: `rm -rf a`."));
});
