import assert from "node:assert/strict";
import { test } from "node:test";
import { bashCall, fakeContext, loadGate, toolCall } from "./harness.ts";

const failingLoader = (): Promise<never> =>
	Promise.reject(new Error("Cannot find package 'unbash'"));

for (const command of ["ls", "echo hi", "git status", ""]) {
	test(`with no parser, bash ${JSON.stringify(command)} is denied with the install instruction`, async () => {
		const handler = await loadGate(failingLoader);
		const result = await handler(bashCall(command), fakeContext());
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /\(rule: parser-unavailable\)/);
		assert.match(result?.reason ?? "", /pnpm install/);
		assert.match(result?.reason ?? "", /pi\/extensions\/bouncer/);
		assert.equal(result?.terminate, undefined);
	});
}

test("with no parser, a non-bash tool still passes through", async () => {
	const handler = await loadGate(failingLoader);
	const result = await handler(
		toolCall("read", { path: "a.txt" }),
		fakeContext(),
	);
	assert.equal(result, undefined);
});
