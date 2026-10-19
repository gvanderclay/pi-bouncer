// MCP tool calls: an allow-listed tool runs, every other one asks, and no
// one able to answer means a block.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	fakeContext,
	type LoadedGate,
	loadGateSession,
	projectConfigPath,
	scriptedUI,
	tempAgentDir,
	tempProjectDir,
	toolCall,
	writeConfig,
} from "../test/harness.ts";
import { loadConfig } from "./config.ts";
import { isMcpTool, mcpAllowed, validMcp } from "./mcp-gate.ts";

const ECHO = "mcp__fake__echo";

async function session(userConfig: object = {}): Promise<LoadedGate> {
	const gate = await loadGateSession(undefined, undefined, { userConfig });
	await gate.startSession("startup");
	return gate;
}

function nested(event: ToolCallEvent, n = 1): ToolCallEvent {
	return {
		...event,
		toolCallId: `codemode-1/${n}`,
		parentToolCallId: "codemode-1",
	} as ToolCallEvent;
}

test("only mcp__ tools are MCP tools", () => {
	assert.equal(isMcpTool(ECHO), true);
	for (const name of ["bash", "codemode", "read", "list_mcp_resources"]) {
		assert.equal(isMcpTool(name), false, name);
	}
});

test("allow entries match whole names, * matches anything, and are normalised as Pi names tools", () => {
	const problems: string[] = [];
	const { allow } = validMcp(
		{ allow: ["mcp__dev-radius__*", "mcp__fake__echo", "mcp__*__read*"] },
		problems,
	) ?? { allow: [] };
	assert.deepEqual(problems, []);
	assert.equal(mcpAllowed("mcp__dev_radius__deploy", allow), true);
	assert.equal(mcpAllowed(ECHO, allow), true);
	assert.equal(mcpAllowed("mcp__fake__echo2", allow), false);
	assert.equal(mcpAllowed("mcp__docs__read_page", allow), true);
	assert.equal(mcpAllowed("mcp__docs__write_page", allow), false);
	// A regex character in an entry is literal, after normalising.
	assert.equal(mcpAllowed("mcp__fakeXecho", ["mcp__fake.echo"]), false);
});

test("an invalid mcp config is a problem and allows nothing", () => {
	for (const mcp of [[], { allow: "mcp__x__*" }, { allow: ["github"] }]) {
		const problems: string[] = [];
		const parsed = validMcp(mcp, problems);
		assert.equal(problems.length, 1, JSON.stringify(mcp));
		assert.deepEqual(parsed?.allow ?? [], []);
	}
	const problems: string[] = [];
	validMcp({ allow: [], deny: [] }, problems);
	assert.deepEqual(problems, ['mcp: unknown key "deny"']);
});

test("a project file cannot allow MCP tools", () => {
	const agentDir = tempAgentDir();
	const cwd = tempProjectDir();
	writeConfig(projectConfigPath(cwd), { mcp: { allow: ["mcp__*"] } });
	const config = loadConfig(agentDir, { cwd, trusted: true });
	assert.equal(config.mcp, undefined);
	assert.match(config.problems.join("\n"), /"mcp" is ignored in a project/);
});

test("an allow-listed MCP call runs with no dialog, direct or nested", async () => {
	const gate = await session({ mcp: { allow: ["mcp__fake__*"] } });
	const ui = scriptedUI([]);
	const call = toolCall(ECHO, { text: "hi" });
	assert.equal(await gate.handler(call, ui.ctx), undefined);
	assert.equal(await gate.handler(nested(call), ui.ctx), undefined);
	assert.equal(ui.dialogs.length, 0);
});

test("the codemode call and other non-MCP tools are not gated", async () => {
	const gate = await session();
	const ui = scriptedUI([]);
	const script = toolCall("codemode", { code: "await mcp__fake.echo({})" });
	assert.equal(await gate.handler(script, ui.ctx), undefined);
	assert.equal(
		await gate.handler(toolCall("read", { path: "x" }), ui.ctx),
		undefined,
	);
	assert.equal(ui.dialogs.length, 0);
});

test("any other MCP call asks, showing the tool and its arguments", async () => {
	const gate = await session();
	const ui = scriptedUI(["Allow once"]);
	const call = toolCall(ECHO, { text: "x".repeat(300) });
	assert.equal(await gate.handler(call, ui.ctx), undefined);
	const [dialog] = ui.dialogs;
	assert.match(
		dialog?.title ?? "",
		/\(rule: mcp\)\nmcp__fake__echo\n\{"text":"x+…$/,
	);
	assert.ok((dialog?.title.length ?? 0) < 300);
	assert.ok(dialog?.options?.includes("Allow for this session"));
});

test("a denied MCP call is blocked with the reason, direct or nested", async () => {
	for (const make of [(e: ToolCallEvent): ToolCallEvent => e, nested]) {
		const gate = await session();
		const ui = scriptedUI(["Deny with reason", "not that server"]);
		const result = await gate.handler(make(toolCall(ECHO, {})), ui.ctx);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /The user denied `mcp__fake__echo`/);
		assert.match(result?.reason ?? "", /not that server/);
	}
});

test("Allow for this session covers the tool whatever its arguments, not other tools", async () => {
	const gate = await session();
	const ui = scriptedUI(["Allow for this session", "Allow once"]);
	await gate.handler(toolCall(ECHO, { text: "a" }), ui.ctx);
	await gate.handler(nested(toolCall(ECHO, { text: "b" })), ui.ctx);
	assert.equal(ui.dialogs.length, 1);
	await gate.handler(toolCall("mcp__fake__write", {}), ui.ctx);
	assert.equal(ui.dialogs.length, 2);
	// A new session forgets it.
	await gate.startSession("new");
	const after = scriptedUI(["Deny"]);
	const result = await gate.handler(toolCall(ECHO, {}), after.ctx);
	assert.equal(result?.block, true);
});

test("with no UI, an MCP call not on the allow list is blocked", async () => {
	const gate = await session();
	const result = await gate.handler(toolCall(ECHO, {}), fakeContext());
	assert.equal(result?.block, true);
	assert.match(
		result?.reason ?? "",
		/\(rule: mcp\).*mcp__fake__echo.*mcp\.allow/,
	);
});

test("YOLO mode allows an MCP call with no dialog", async () => {
	const gate = await session();
	gate.mode.mode = "yolo";
	assert.equal(
		await gate.handler(toolCall(ECHO, {}), fakeContext()),
		undefined,
	);
	const [record] = gate.records().filter((r) => r.type === "call");
	assert.equal(record?.yolo, true);
	assert.equal(record?.withoutYolo, "blocked");
});

test("auto mode asks no judge about an MCP call: it opens the dialog, or blocks with no UI", async () => {
	const gate = await session();
	gate.mode.mode = "auto";
	const ui = scriptedUI(["Allow once"]);
	assert.equal(await gate.handler(toolCall(ECHO, {}), ui.ctx), undefined);
	assert.equal(ui.dialogs.length, 1);
	assert.equal(ui.dialogs[0]?.options?.includes("🤖 Auto mode"), false);
	const result = await gate.handler(toolCall(ECHO, {}), fakeContext());
	assert.equal(result?.block, true);
	const records = gate.records().filter((r) => r.type === "call");
	assert.deepEqual(
		records.map((r) => [r.withoutAuto, r.auto]),
		[
			["dialog", undefined],
			["blocked", undefined],
		],
	);
});

test("an MCP decision is logged with its tool, arguments and parent", async () => {
	const gate = await session();
	const ui = scriptedUI(["Allow once"]);
	await gate.handler(nested(toolCall(ECHO, { text: "hi" }), 2), ui.ctx);
	const [record] = gate.records().filter((r) => r.type === "call");
	assert.equal(record?.tool, ECHO);
	assert.equal(record?.command, '{"text":"hi"}');
	assert.equal(record?.parentToolCallId, "codemode-1");
	assert.equal(record?.outcome, "allowed");
	assert.deepEqual(record?.asks, [
		{ rule: "mcp", source: ECHO, answer: "allow-once" },
	]);
});
