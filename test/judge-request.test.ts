// The judge request through the exports of `judge-request.ts`: the builder's
// budgets and omissions, and that building a built request changes nothing.
// Nothing of the project is mocked.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryEntry } from "../history.ts";
import {
	type JudgeRequest,
	jevState,
	judgeInput,
	judgeRequest,
} from "../judge-request.ts";
import {
	type BenchCase,
	CASES,
	requestFor,
} from "../skills/auto-judge-list/bench.ts";
import { HELDOUT_CASES } from "../skills/auto-judge-list/heldout-cases.ts";

const APP = "/home/dev/workspace/app";
const ASKS = [
	{ rule: "recursive-rm", summary: "recursive rm", source: "rm -rf /tmp/x" },
];

function base(rest: Partial<JudgeRequest> = {}): JudgeRequest {
	return { command: "rm -rf /tmp/x", asks: ASKS, cwd: APP, ...rest };
}

/** Ten bash entries in the call's cwd, each rendering an 885-character body. */
function tenEntries(): HistoryEntry[] {
	return Array.from({ length: 10 }, (_, i) => ({
		tool: "bash",
		text: String(i).repeat(879),
		cwd: APP,
	}));
}

/** Ten messages of 439 characters. */
function tenMessages(): string[] {
	return Array.from({ length: 10 }, (_, i) => String(i).repeat(439));
}

const BUSY: BenchCase = {
	id: "busy",
	command: "rm -rf /tmp/pi-x",
	cwd: APP,
	branch: "feat/x",
	userMessage: "Now tidy up.",
	earlierUserMessages: ["a".repeat(1500), "b".repeat(1500), "c".repeat(1500)],
	history: [
		{ tool: "bash", text: "x".repeat(3500), cwd: APP },
		{ tool: "write", text: "y".repeat(3500), cwd: "/tmp", failed: true },
		{ tool: "bash", text: "z".repeat(3500), cwd: APP, background: true },
	],
	expected: ["allow"],
};

test("the builder keeps eight of ten history entries: nine fit under the nine-item overhead, not the ten-item one", () => {
	const entries = tenEntries();
	const built = judgeRequest(base({ history: entries }));
	assert.deepEqual(built.history, entries.slice(2));
});

test("the builder keeps eight of ten earlier messages for the same reason", () => {
	const messages = tenMessages();
	const built = judgeRequest(
		base({ earlierUserMessages: messages, userMessage: "go" }),
	);
	assert.deepEqual(built.earlierUserMessages, messages.slice(2));
});

test("the builder keeps the newest two of the busy case's three earlier messages and history entries", () => {
	const built = judgeRequest(requestFor(BUSY));
	assert.deepEqual(built.earlierUserMessages, [
		"b".repeat(1500),
		"c".repeat(1500),
	]);
	assert.deepEqual(built.history, (BUSY.history ?? []).slice(1));
});

test("the builder leaves out an empty earlier list, an empty history and an empty user message", () => {
	const built = judgeRequest(
		base({ earlierUserMessages: [], history: [], userMessage: "" }),
	);
	assert.deepEqual(built, base());
	assert.ok(!("earlierUserMessages" in built));
	assert.ok(!("history" in built));
	assert.ok(!("userMessage" in built));
});

test("the builder applies no cap but the budgets: a long message and eleven short ones pass whole", () => {
	const messages = Array.from({ length: 11 }, () => "m".repeat(10));
	const history: HistoryEntry[] = Array.from({ length: 60 }, () => ({
		tool: "bash",
		text: "ls",
		cwd: APP,
	}));
	const built = judgeRequest(base({ earlierUserMessages: messages, history }));
	assert.equal(built.earlierUserMessages?.length, 11);
	assert.equal(built.history?.length, 60);
});

test("the builder keeps the other fields as given", () => {
	const git = { kind: "repo", branch: "main", dirty: true } as const;
	const remotes = [{ name: "origin", url: "git@x:y.git", changed: true }];
	const built = judgeRequest(
		base({ git, remotes, environment: ["a fact"], userMessage: "go" }),
	);
	assert.deepEqual(
		built,
		base({ git, remotes, environment: ["a fact"], userMessage: "go" }),
	);
});

test("building a built request gives the same request, at the boundary sizes and for the busy case", () => {
	const inputs = [
		base({ history: tenEntries() }),
		base({ earlierUserMessages: tenMessages(), userMessage: "go" }),
		requestFor(BUSY),
	];
	for (const input of inputs) {
		const once = judgeRequest(input);
		assert.deepEqual(judgeRequest(once), once);
	}
});

test("the judge input shows the boundary's eight history lines, numbered from 1", () => {
	const entries = tenEntries();
	const lines = judgeInput(judgeRequest(base({ history: entries }))).split(
		"\n",
	);
	const open = lines.indexOf("<session_history>");
	const close = lines.indexOf("</session_history>");
	assert.equal(close - open - 1, 8);
	assert.equal(lines[open + 1], `1. bash: ${"2".repeat(879)}`);
	assert.equal(lines[close - 1], `8. bash: ${"9".repeat(879)}`);
});

// Temporary: removed once a request built by hand no longer typechecks.
test("for every bench case, held-out case and the busy case, the built request renders as the unbuilt one", () => {
	for (const c of [...CASES, ...HELDOUT_CASES, BUSY]) {
		const unbuilt = requestFor(c);
		const built = judgeRequest(unbuilt);
		assert.equal(judgeInput(built), judgeInput(unbuilt), c.id);
		assert.deepEqual(jevState(built), jevState(unbuilt), c.id);
	}
});
