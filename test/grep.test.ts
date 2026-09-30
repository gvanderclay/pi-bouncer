// The grep steer rule: every grep the scan finds is blocked, in every bouncer
// mode, with a message that sends the model to rg and no warning for the user.
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgedGate, judgedUI } from "./auto-harness.ts";
import {
	bashCall,
	expectAllow,
	expectDeny,
	fakeContext,
	loadGate,
	loadGateSession,
	scriptedUI,
	uiContext,
	verdict,
} from "./harness.ts";

const STEER =
	"Blocked by the user's bouncer (rule: grep): grep is not allowed here.";

/** Asserts `command` gets the grep block without a UI. */
async function expectGrepBlock(command: string): Promise<void> {
	const handler = await loadGate();
	const result = await handler(bashCall(command), fakeContext());
	const reason = result?.reason ?? "";
	assert.equal(result?.block, true, `expected ${command} to be blocked`);
	assert.ok(reason.startsWith(STEER), reason);
	assert.match(reason, /None of the command ran\./);
	assert.match(reason, /\brg\b/);
	assert.doesNotMatch(reason, /Do not retry|Tell the user/);
	assert.equal(result?.terminate, undefined);
}

const denied = [
	"grep x f",
	"egrep x f",
	"fgrep x f",
	"/usr/bin/grep x f",
	"\\grep x f",
	"command grep x f",
	"env grep x f",
	"timeout 5 grep x f",
	"find . | xargs grep x",
	"bash -c 'grep x f'",
	"eval grep x f",
	"ps aux | grep node",
	"find . -exec grep x {} \\;",
	"find . -execdir /usr/bin/grep x {} +",
	"find . -ok egrep x {} \\;",
	"gfind . -okdir fgrep x {} \\;",
	"fd -x grep x",
	"fd -X grep x",
	"fd --exec grep x",
	"fd --exec=grep x",
	"fd --exec-batch grep x",
	"fdfind -x grep x",
	"fd -HIx grep x",
	"fd -Hx /usr/bin/grep x",
];

const allowed = [
	"rg x",
	"rg grep",
	"fd grep",
	"git grep x",
	"git log --grep x",
	"find . -name grep",
	"echo grep",
	"zgrep x f.gz",
	"fd -tx grep",
	"fd -tfx grep x",
	"find . -name grep -print",
];

for (const command of denied) {
	test(`grep block: ${command}`, () => expectGrepBlock(command));
}

for (const command of allowed) {
	test(`allow: ${command}`, () => expectAllow(command));
}

test("the grep block's reason is short and reads exactly", async () => {
	const handler = await loadGate();
	const result = await handler(bashCall("grep -rn foo src"), fakeContext());
	assert.deepEqual(result, {
		block: true,
		reason:
			"Blocked by the user's bouncer (rule: grep): grep is not allowed here. Command: `grep -rn foo src`. None of the command ran. Run the search with rg instead: it is recursive and uses regex by default; add -F for a fixed string and -n for line numbers.",
	});
});

test("with a UI, a grep block adds no notice and opens no dialog", async () => {
	const handler = await loadGate();
	const { ctx, dialogs, notices } = scriptedUI();
	const result = await handler(bashCall("grep x f"), ctx);
	assert.equal(result?.block, true);
	assert.ok(result?.reason?.startsWith(STEER), String(result?.reason));
	assert.deepEqual(dialogs, []);
	assert.deepEqual(notices, []);
});

test("each grep block writes one call record naming grep", async () => {
	const { handler, records } = await loadGateSession();
	const result = await handler(bashCall("ls | grep x"), fakeContext());
	const all = records();
	assert.equal(all.length, 1);
	assert.equal(all[0]?.type, "call");
	assert.equal(all[0]?.outcome, "blocked");
	assert.equal(all[0]?.reason, String(result?.reason));
	assert.deepEqual(all[0]?.matches, [
		{ rule: "grep", level: "deny", source: "grep x" },
	]);
});

test("a real deny on a grep line wins, with its warning", async () => {
	const handler = await loadGate();
	const { ctx, dialogs, notices } = scriptedUI();
	const result = await handler(bashCall("grep x f && sudo ls"), ctx);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /\(rule: privilege\)/);
	assert.match(result?.reason ?? "", /Do not retry/);
	assert.deepEqual(dialogs, []);
	assert.deepEqual(notices, [
		{ message: "Bouncer denied privilege: sudo ls", level: "warning" },
	]);
});

test("the grep block wins over an ask on the line, with no dialog", async () => {
	const handler = await loadGate();
	const { ctx, dialogs, notices } = scriptedUI();
	const result = await handler(bashCall("grep x f && rm -rf build"), ctx);
	assert.equal(result?.block, true);
	assert.ok(result?.reason?.startsWith(STEER), String(result?.reason));
	assert.deepEqual(dialogs, []);
	assert.deepEqual(notices, []);
});

const PRIVILEGE_NOTICE = {
	message: "Bouncer denied privilege: sudo ls",
	level: "warning",
};

test("in YOLO mode, a real deny on a grep line wins, with its warning", async () => {
	const gate = await loadGateSession();
	await gate.startSession("startup");
	await gate.runCommand("yolo", "", uiContext().ctx);
	const { ctx, notices } = scriptedUI();
	const result = await gate.handler(bashCall("grep x f && sudo ls"), ctx);
	assert.match(result?.reason ?? "", /\(rule: privilege\)/);
	assert.deepEqual(notices, [PRIVILEGE_NOTICE]);
});

test("in auto mode, a real deny on a grep line wins, with its warning", async () => {
	const { gate, fake } = await judgedGate(verdict("allow", "fine"));
	const ui = judgedUI(fake);
	const result = await gate.handler(bashCall("grep x f && sudo ls"), ui.ctx);
	assert.match(result?.reason ?? "", /\(rule: privilege\)/);
	assert.deepEqual(ui.notices, [PRIVILEGE_NOTICE]);
	assert.equal(fake.requests.length, 0);
});

test("in auto mode, an alwaysAsk prefix on a grep line gets the grep block", async () => {
	const { gate, fake } = await judgedGate(verdict("allow", "fine"), {
		alwaysAsk: ["grep"],
	});
	const ui = judgedUI(fake);
	const result = await gate.handler(bashCall("grep x f"), ui.ctx);
	assert.ok(result?.reason?.startsWith(STEER), String(result?.reason));
	assert.deepEqual(ui.dialogs, []);
	assert.deepEqual(ui.notices, []);
	assert.equal(fake.requests.length, 0);
});

const slotAsks: readonly (readonly [command: string, rule: string])[] = [
	["find . -exec rg x {} \\;", "find-exec"],
	["fd -x rg x", "fd-exec"],
];

for (const [command, rule] of slotAsks) {
	test(`${command} is still a ${rule} ask`, () => expectDeny(command, rule));
}

for (const command of ["find . -exec grep x {} \\;", "fd -x grep x"]) {
	test(`grep in a command slot opens no dialog: ${command}`, async () => {
		const handler = await loadGate();
		const { ctx, dialogs, notices } = scriptedUI();
		const result = await handler(bashCall(command), ctx);
		assert.ok(result?.reason?.startsWith(STEER), String(result?.reason));
		assert.deepEqual(dialogs, []);
		assert.deepEqual(notices, []);
	});
}

test("a real deny beside grep in find's command slot wins", async () => {
	const handler = await loadGate();
	const { ctx, notices } = scriptedUI();
	const command = "find . -exec grep x {} \\; && sudo ls";
	const result = await handler(bashCall(command), ctx);
	assert.match(result?.reason ?? "", /\(rule: privilege\)/);
	assert.deepEqual(notices, [PRIVILEGE_NOTICE]);
});
