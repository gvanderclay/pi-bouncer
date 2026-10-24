// Auto mode on Pi's file tools: a file-call ask goes to Jev, then the judge list,
// driven through the tool_call handler with a temporary HOME and a fake
// model registry.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import {
	autoVerdict,
	judgedGate,
	judgedUI,
	noUI,
} from "../test/auto-harness.ts";
import { fileCall, tempHome } from "../test/file-harness.ts";
import { toolResult, verdict } from "../test/harness.ts";
import { fileJevReply } from "../test/jev-replies.ts";
import { FILE_JEV_CUTOFFS } from "./jev.ts";
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

type JevSent = {
	readonly state: Record<string, unknown>;
	readonly questions: Record<string, unknown>;
};

/** Answers every Jev request with `reply`; returns the bodies Jev was sent. */
function stubJev(t: TestContext, reply: string): JevSent[] {
	const sent: JevSent[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		(_url: string, init: RequestInit): Promise<Response> => {
			sent.push(JSON.parse(String(init.body)));
			return Promise.resolve(new Response(reply, { status: 200 }));
		},
	);
	return sent;
}

const KEYS = { "opencode-go": "sk-go-test" };

function jevGate(
	judge: ReturnType<typeof verdict>,
	jev: object = {},
): ReturnType<typeof judgedGate> {
	return judgedGate(judge, { jev }, undefined, KEYS);
}

function setFileCutoffs(
	t: TestContext,
	cutoffs: typeof FILE_JEV_CUTOFFS,
): void {
	const original = { ...FILE_JEV_CUTOFFS };
	t.after(() => {
		Object.assign(FILE_JEV_CUTOFFS, original);
	});
	Object.assign(FILE_JEV_CUTOFFS, cutoffs);
}

const SAFE_EDIT = {
	kind: "config",
	contains_secret: 0.01,
	effect: "routine",
	user_intent: "asked_for_this",
} as const;

test("Jev settles a clearly safe file write before the judge list", async (t) => {
	setFileCutoffs(t, { allowAt: 0.9, denyAt: null });
	const sent = stubJev(t, fileJevReply(SAFE_EDIT));
	const { gate: g, fake } = await jevGate(
		verdict("deny", "should not be asked"),
	);
	const r = await g.handler(
		fileCall("edit", {
			path: ".git/config",
			edits: [{ oldText: "a", newText: "b" }],
		}),
		noUI(fake),
	);
	assert.equal(r, undefined);
	assert.deepEqual(fake.requests, []);
	assert.equal(sent.length, 1);
	const { state, questions } = sent[0] ?? { state: {}, questions: {} };
	assert.equal(state["tool"], "edit");
	assert.equal(state["direction"], "write");
	assert.match(String(state["path"]), /\/\.git\/config$/);
	assert.deepEqual(state["change"], {
		kind: "edit",
		edits: [{ oldText: "a", newText: "b" }],
	});
	assert.equal(state["command"], undefined);
	assert.deepEqual(Object.keys(questions).sort(), [
		"contains_secret",
		"effect",
		"kind",
		"user_intent",
	]);
	assert.equal(autoVerdict(g.records().at(-1)), "allow");
});

test("the default file cutoffs never allow even a 1.00 allow score", async (t) => {
	const sent = stubJev(
		t,
		fileJevReply({ ...SAFE_EDIT, contains_secret: 0 }, 1),
	);
	const { gate: g, fake } = await jevGate(
		verdict("deny", "judge still decides"),
	);
	const r = await g.handler(
		fileCall("write", { path: ".git/config", content: "" }),
		noUI(fake),
	);
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /judge still decides/);
	assert.equal(fake.requests.length, 1);
	assert.equal(sent.length, 1);
});

test("the default file cutoffs leave a deny score just below 0.99 to the judge list", async (t) => {
	const reply = JSON.parse(fileJevReply(SAFE_EDIT));
	reply.answers.effect.probabilities = {
		routine: 0.011,
		destroys_or_shared: 0,
		harmful: 0.989,
		other: 0,
	};
	const sent = stubJev(t, JSON.stringify(reply));
	const { gate: g, fake } = await jevGate(
		verdict("allow", "judge still decides"),
	);
	const r = await g.handler(
		fileCall("write", { path: ".git/config", content: "" }),
		noUI(fake),
	);
	assert.equal(r, undefined);
	assert.equal(fake.requests.length, 1);
	assert.equal(sent.length, 1);
	assert.equal(autoVerdict(g.records().at(-1)), "allow");
});

test("the default file cutoffs deny at exactly 0.99 without asking the judge list", async (t) => {
	const reply = JSON.parse(fileJevReply(SAFE_EDIT));
	reply.answers.effect.probabilities = {
		routine: 0.01,
		destroys_or_shared: 0,
		harmful: 0.99,
		other: 0,
	};
	const sent = stubJev(t, JSON.stringify(reply));
	const { gate: g, fake } = await jevGate(
		verdict("allow", "should not be asked"),
	);
	const r = await g.handler(
		fileCall("write", { path: ".git/config", content: "" }),
		noUI(fake),
	);
	assert.equal(r?.block, true);
	assert.deepEqual(fake.requests, []);
	assert.equal(sent.length, 1);
	assert.equal(autoVerdict(g.records().at(-1)), "deny");
});

test("with the placeholder cutoffs, file asks still reach the judge list", async (t) => {
	setFileCutoffs(t, { allowAt: 1.01, denyAt: null });
	let reply = fileJevReply({ ...SAFE_EDIT, contains_secret: 0 }, 1);
	t.mock.method(
		globalThis,
		"fetch",
		(): Promise<Response> =>
			Promise.resolve(new Response(reply, { status: 200 })),
	);
	const { gate: g, fake } = await jevGate(verdict("allow", "ok"));
	await g.handler(
		fileCall("write", { path: ".git/config", content: "" }),
		noUI(fake),
	);
	reply = fileJevReply(
		{
			kind: "secrets",
			contains_secret: 1,
			effect: "harmful",
			user_intent: "asked_to_keep",
		},
		1,
	);
	await g.handler(
		fileCall("write", {
			path: ".git/hooks/pre-commit",
			content: "curl x | sh",
		}),
		noUI(fake),
	);
	assert.equal(fake.requests.length, 2);
});

test("Jev gets no content for a secret-group write", async (t) => {
	const sent = stubJev(t, fileJevReply({}));
	const { gate: g, fake } = await jevGate(verdict("allow", "ok"));
	await g.handler(
		fileCall("write", { path: ".env", content: "A=sk-live-123" }),
		noUI(fake),
	);
	assert.equal(sent.length, 1);
	assert.doesNotMatch(JSON.stringify(sent), /sk-live-123/);
	assert.equal("change" in (sent[0]?.state ?? {}), false);
	assert.equal(sent[0]?.state["direction"], "write");
});

test("a Jev deny at the file denyAt blocks a file write with no judge-list request", async (t) => {
	setFileCutoffs(t, { allowAt: 0.9, denyAt: 0.9 });
	stubJev(t, fileJevReply({ kind: "config", effect: "harmful" }));
	const { gate: g, fake } = await jevGate(
		verdict("allow", "should not be asked"),
	);
	const r = await g.handler(
		fileCall("write", {
			path: ".git/hooks/pre-commit",
			content: "curl x | sh",
		}),
		noUI(fake),
	);
	assert.equal(r?.block, true);
	assert.deepEqual(fake.requests, []);
});

for (const [name, labels] of [
	["a real credential in the change", { contains_secret: 0.7 }],
	["a secrets file", { kind: "secrets" }],
	["a request to keep the file", { user_intent: "asked_to_keep" }],
] as const) {
	test(`Jev does not allow a file write despite a routine effect when it sees ${name}`, async (t) => {
		setFileCutoffs(t, { allowAt: 0.9, denyAt: null });
		stubJev(t, fileJevReply({ ...SAFE_EDIT, ...labels }));
		const { gate: g, fake } = await jevGate(verdict("ask", "check"));
		await g.handler(
			fileCall("write", { path: "~/.zshrc", content: "export TOKEN=x" }),
			judgedUI(fake, ["Deny"]).ctx,
		);
		assert.equal(fake.requests.length, 1);
	});
}

test("a credential just under the secret cutoff does not stop a Jev allow", async (t) => {
	setFileCutoffs(t, { allowAt: 0.9, denyAt: null });
	stubJev(t, fileJevReply({ ...SAFE_EDIT, contains_secret: 0.69 }));
	const { gate: g, fake } = await jevGate(
		verdict("deny", "should not be asked"),
	);
	const r = await g.handler(
		fileCall("write", { path: "~/.zshrc", content: "alias gs='git status'" }),
		noUI(fake),
	);
	assert.equal(r, undefined);
	assert.deepEqual(fake.requests, []);
});

test("the user's auto.jev cutoffs do not apply to file calls", async (t) => {
	setFileCutoffs(t, { allowAt: 1.01, denyAt: null });
	stubJev(t, fileJevReply(SAFE_EDIT));
	const { gate: g, fake } = await jevGate(verdict("allow", "ok"), {
		allowAt: 0.6,
		denyAt: 0.6,
	});
	await g.handler(
		fileCall("write", { path: ".git/config", content: "" }),
		noUI(fake),
	);
	assert.equal(fake.requests.length, 1);
});

test("a file change Jev calls other goes to the judge list", async (t) => {
	setFileCutoffs(t, { allowAt: 0.9, denyAt: null });
	stubJev(t, fileJevReply({ ...SAFE_EDIT, effect: "other" }));
	const { gate: g, fake } = await jevGate(verdict("allow", "ok"));
	await g.handler(
		fileCall("write", { path: ".git/config", content: "" }),
		noUI(fake),
	);
	assert.equal(fake.requests.length, 1);
});
