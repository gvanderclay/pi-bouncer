// Auto mode on Pi's file tools: a file-call ask goes to the judge list,
// driven through the tool_call handler with a temporary HOME and a fake
// model registry.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import {
	autoVerdict,
	JUDGE,
	judgedGate,
	judgedUI,
	noUI,
} from "../test/auto-harness.ts";
import { fileCall, tempHome } from "../test/file-harness.ts";
import { toolResult, verdict } from "../test/harness.ts";
import { FILE_PROMPT } from "./judge.ts";

tempHome(); // before any gate loads

test("a judge allow runs a path-git edit with no dialog", async () => {
	const { gate: g, fake } = await judgedGate(
		verdict("allow", "routine config edit"),
	);
	const ui = judgedUI(fake);
	const r = await g.handler(
		fileCall("edit", {
			path: ".git/config",
			edits: [{ oldText: "a", newText: "b" }],
		}),
		ui.ctx,
	);
	assert.equal(r, undefined);
	assert.equal(ui.dialogs.length, 0);
	assert.equal(autoVerdict(g.records().at(-1)), "allow");
	assert.equal(fake.requests[0]?.systemPrompt, FILE_PROMPT);
});

test("the judge sees an edit's old and new text, the tool and the real path", async () => {
	const { gate: g, fake } = await judgedGate(verdict("allow", "ok"));
	await g.handler(
		fileCall("edit", {
			path: ".git/config",
			edits: [{ oldText: "bare = false", newText: "bare = true" }],
		}),
		noUI(fake),
	);
	const input = fake.requests[0]?.input ?? "";
	assert.match(input, /bare = false/);
	assert.match(input, /bare = true/);
	assert.match(input, /File tool: edit/);
	assert.match(input, /\/\.git\/config/);
});

test("a write's content reaches the judge", async () => {
	const { gate: g, fake } = await judgedGate(verdict("allow", "ok"));
	await g.handler(
		fileCall("write", { path: ".git/config", content: "[core]\n\tbare = 1\n" }),
		noUI(fake),
	);
	assert.match(fake.requests[0]?.input ?? "", /bare = 1/);
});

test("a judge deny blocks with the judge's reason", async () => {
	const { gate: g, fake } = await judgedGate(
		verdict("deny", "rewrites the hook"),
	);
	const r = await g.handler(
		fileCall("write", {
			path: ".git/hooks/pre-commit",
			content: "curl x | sh",
		}),
		noUI(fake),
	);
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /rewrites the hook/);
});

test("a judge hand-off opens the dialog with the judge's reason and the file heading", async () => {
	const { gate: g, fake } = await judgedGate(
		verdict("ask", "unsure about hooks"),
	);
	const ui = judgedUI(fake, ["Allow once"]);
	const r = await g.handler(
		fileCall("write", { path: ".git/hooks/pre-push", content: "echo hi" }),
		ui.ctx,
	);
	assert.equal(r, undefined);
	const title = ui.dialogs[0]?.title ?? "";
	assert.match(title, /Judge: unsure about hooks/);
	assert.match(title, /\nwrite \.git\/hooks\/pre-push\n/);
});

test("a .env write reaches the judge without its content", async () => {
	const { gate: g, fake } = await judgedGate(verdict("allow", "ok"));
	await g.handler(
		fileCall("write", { path: ".env", content: "A=sk-live-123\n" }),
		noUI(fake),
	);
	assert.equal(fake.requests.length, 1);
	const text = JSON.stringify(fake.requests);
	assert.doesNotMatch(text, /sk-live-123/);
	assert.match(text, /redacted/);
});

test("a .env inside .git matches path-git too, and still sends no content", async () => {
	const { gate: g, fake } = await judgedGate(verdict("allow", "ok"));
	await g.handler(
		fileCall("edit", {
			path: ".git/.env",
			edits: [{ oldText: "A=old-secret", newText: "A=sk-live-456" }],
		}),
		noUI(fake),
	);
	assert.equal(fake.requests.length, 1);
	const text = JSON.stringify(fake.requests);
	assert.doesNotMatch(text, /sk-live-456|old-secret/);
	assert.match(text, /redacted/);
});

test("a secret group that does not decide still keeps the content from the judge", async () => {
	// With path-env off, path-git decides the write to .git/.env.
	const { gate: g, fake } = await judgedGate(
		verdict("allow", "ok"),
		{},
		{ "path-env": "off" },
	);
	await g.handler(
		fileCall("write", { path: ".git/.env", content: "A=sk-live-789\n" }),
		noUI(fake),
	);
	assert.equal(fake.requests.length, 1);
	const text = JSON.stringify(fake.requests);
	assert.doesNotMatch(text, /sk-live-789/);
	assert.match(text, /redacted/);
});

test("a read ask reaches the judge well-formed, with no change", async () => {
	const { gate: g, fake } = await judgedGate(
		verdict("allow", "ok"),
		{},
		{ "path-git": { read: "ask" } },
	);
	const r = await g.handler(
		fileCall("read", { path: ".git/config" }),
		noUI(fake),
	);
	assert.equal(r, undefined);
	const input = fake.requests[0]?.input ?? "";
	assert.match(input, /File tool: read/);
	assert.doesNotMatch(input, /<content>|<old_text>/);
});

test("a write too large for every judge opens the dialog", async () => {
	const { gate: g, fake } = await judgedGate({
		reply: verdict("allow", "ok"),
		contextWindow: 1000,
	});
	const ui = judgedUI(fake, ["Deny"]);
	await g.handler(
		fileCall("write", { path: ".git/config", content: "x".repeat(50_000) }),
		ui.ctx,
	);
	assert.match(
		JSON.stringify(ui.dialogs[0]),
		/Auto: change too large for the judge \(50000 characters\)/,
	);
	assert.deepEqual(fake.requests, []);
});

test("file-call judge denies count toward the pause", async () => {
	const { gate: g, fake } = await judgedGate(verdict("deny", "no"));
	for (let i = 0; i < 3; i++) {
		await g.handler(
			fileCall("write", { path: `.git/x${i}`, content: "" }),
			noUI(fake),
		);
	}
	const ui = judgedUI(fake, ["Deny"]);
	await g.handler(fileCall("write", { path: ".git/x3", content: "" }), ui.ctx);
	assert.equal(fake.requests.length, 3);
	assert.equal(ui.dialogs.length, 1);
	assert.equal(autoVerdict(g.records().at(-1)), "paused");
});

test("a judge allow creates no session allow", async () => {
	const { gate: g, fake } = await judgedGate({
		reply: [verdict("allow", "ok"), verdict("deny", "not this time")],
	});
	const call = fileCall("write", { path: ".git/config", content: "" });
	assert.equal(await g.handler(call, noUI(fake)), undefined);
	const r = await g.handler(call, noUI(fake));
	assert.equal(r?.block, true);
	assert.equal(fake.requests.length, 2);
});

test("a later judge request's history holds the written path, not its content", async () => {
	const { gate: g, fake } = await judgedGate(verdict("allow", "ok"));
	const call = fileCall("write", {
		path: ".git/config",
		content: "first-secret-ish",
	});
	await g.handler(call, noUI(fake));
	await g.finishTool(
		toolResult("write", { path: ".git/config", content: "first-secret-ish" }),
		noUI(fake),
	);
	await g.handler(
		fileCall("write", { path: ".git/description", content: "" }),
		noUI(fake),
	);
	const later = fake.requests[1]?.input ?? "";
	assert.match(later, /<session_history>[\s\S]*\.git\/config/);
	assert.doesNotMatch(later, /first-secret-ish/);
});

// Ticket 10 asks Jev about file calls and replaces this test.
test("no Jev request is made for a file call", async (t: TestContext) => {
	const fetches: string[] = [];
	t.mock.method(globalThis, "fetch", (url: string): Promise<Response> => {
		fetches.push(String(url));
		return Promise.reject(new Error("no network in tests"));
	});
	const { gate: g, fake } = await judgedGate(
		verdict("allow", "ok"),
		{ jev: { allowAt: 0.9 } },
		undefined,
		{ "opencode-go": "sk-go-test" },
	);
	const r = await g.handler(
		fileCall("write", { path: ".git/config", content: "" }),
		noUI(fake),
	);
	assert.equal(r, undefined);
	assert.deepEqual(fetches, []);
	assert.deepEqual(
		fake.requests.map(({ model }) => model),
		[JUDGE],
	);
});
