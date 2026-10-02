import assert from "node:assert/strict";
import { test } from "node:test";
import { loadGate, toolCall, uiContext } from "../test/harness.ts";

const calls: readonly (readonly [string, Record<string, unknown>])[] = [
	["read", { path: "a.txt" }],
	["write", { path: "a.txt", content: "rm -rf /" }],
	["edit", { path: "a.txt", edits: [] }],
	["grep", { pattern: "rm -rf" }],
	["find", { pattern: "*" }],
	["ls", { path: "." }],
	["my_tool", { command: "rm -rf /" }],
	["powershell", { command: "Remove-Item -Recurse x" }],
];

for (const [toolName, input] of calls) {
	test(`${toolName} ${JSON.stringify(input)} passes through`, async () => {
		const handler = await loadGate();
		const { ctx, notices } = uiContext();
		assert.equal(await handler(toolCall(toolName, input), ctx), undefined);
		assert.equal(notices.length, 0);
	});
}
