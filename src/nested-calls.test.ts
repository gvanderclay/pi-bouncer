// A bash call another tool made through `ctx.executeTool()` (a codemode
// script, say) reaches `tool_call` with `parentToolCallId` set and an id of
// `<parent id>/<n>`. The bouncer rules it exactly as a direct call.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	bashCall,
	bashResult,
	fakeContext,
	type LoadedGate,
	loadGateSession,
	scriptedUI,
	tempLogDir,
} from "../test/harness.ts";

const PARENT = "codemode-1";

function nestedCall(command: string, n = 1, parent = PARENT): ToolCallEvent {
	return {
		...bashCall(command),
		toolCallId: `${parent}/${n}`,
		parentToolCallId: parent,
	} as ToolCallEvent;
}

async function session(): Promise<LoadedGate> {
	const gate = await loadGateSession(undefined, tempLogDir());
	await gate.startSession("startup");
	return gate;
}

// The parent's assistant message, as Pi ends it before running its one call.
function assistant(id: string): object {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "codemode" }],
	};
}

async function bothWays(
	command: string,
	ctx: () => ExtensionContext,
): Promise<{ direct: unknown; nested: unknown }> {
	const direct = await (await session()).handler(bashCall(command), ctx());
	const gate = await session();
	await gate.endMessage(assistant(PARENT));
	const nested = await gate.handler(nestedCall(command), ctx());
	return { direct, nested };
}

test("a nested call is ruled as the direct one: allow, ask and deny", async () => {
	for (const command of ["ls -la", "rm -rf build", "sudo true", "rm -rf /"]) {
		const { direct, nested } = await bothWays(command, () => fakeContext());
		assert.deepEqual(nested, direct, command);
	}
	const { direct } = await bothWays("ls -la", () => fakeContext());
	assert.equal(direct, undefined);
});

test("a nested destructive command is blocked", async () => {
	const gate = await session();
	const result = await gate.handler(nestedCall("rm -rf /"), fakeContext());
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /\(rule: rm-root\)/);
});

test("a nested ask opens the same dialog, and its answer holds", async () => {
	for (const answer of ["Allow once", "Deny"]) {
		const direct = scriptedUI([answer]);
		const nested = scriptedUI([answer]);
		const a = await (await session()).handler(
			bashCall("rm -rf build"),
			direct.ctx,
		);
		const b = await (await session()).handler(
			nestedCall("rm -rf build"),
			nested.ctx,
		);
		assert.deepEqual(b, a, answer);
		assert.deepEqual(nested.dialogs, direct.dialogs);
		assert.equal(nested.dialogs.length, 1);
	}
});

test("a nested call's log record names its parent; a direct one's does not", async () => {
	const gate = await session();
	await gate.handler(bashCall("sudo true"), fakeContext());
	await gate.handler(nestedCall("sudo true", 3), fakeContext());
	const calls = gate.records().filter((r) => r.type === "call");
	assert.equal(calls.length, 2);
	assert.equal("parentToolCallId" in (calls[0] ?? {}), false);
	assert.equal(calls[1]?.parentToolCallId, PARENT);
	assert.deepEqual(
		{ ...calls[1], parentToolCallId: undefined, time: undefined },
		{ ...calls[0], parentToolCallId: undefined, time: undefined },
	);
});

test("50 nested calls under one parent are each ruled as direct ones", async () => {
	const commands = ["ls", "rm -rf build", "git status", "sudo true", "pwd"];
	const gate = await session();
	await gate.endMessage(assistant(PARENT));
	const direct = await session();
	for (let n = 1; n <= 50; n++) {
		const command = commands[n % commands.length] ?? "ls";
		const nested = await gate.handler(nestedCall(command, n), fakeContext());
		const expected = await direct.handler(bashCall(command), fakeContext());
		assert.deepEqual(nested, expected, `${n}: ${command}`);
	}
	const calls = gate.records().filter((r) => r.type === "call");
	assert.equal(calls.length, 20);
	assert.ok(calls.every((r) => r.parentToolCallId === PARENT));
});

test("a nested rm of an agent-made folder still asks: it is never the lone call", async () => {
	const gate = await session();
	const dir = join(mkdtempSync(join(tmpdir(), "nested-")), "made");
	await gate.endMessage(assistant(PARENT));
	const ctx = fakeContext();
	assert.equal(
		await gate.handler(nestedCall(`mkdir ${dir}`, 1), ctx),
		undefined,
	);
	mkdirSync(dir);
	await gate.finishTool(bashResult(`mkdir ${dir}`, { id: `${PARENT}/1` }), ctx);
	const rm = await gate.handler(nestedCall(`rm -rf ${dir}`, 2), ctx);
	assert.equal(rm?.block, true);
	assert.match(rm?.reason ?? "", /\(rule: recursive-rm\)/);
	const [record] = gate.records().filter((r) => r.type === "call");
	assert.match(JSON.stringify(record?.agentMade), /sibling-tool-calls/);
	// The nested mkdir still counts: a later direct, lone rm runs.
	await gate.endMessage(assistant("t1"));
	assert.equal(await gate.handler(bashCall(`rm -rf ${dir}`), ctx), undefined);
});
