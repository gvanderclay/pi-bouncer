import assert from "node:assert/strict";
import { test } from "node:test";
import { bashCall, expectAllow, loadGate, uiContext } from "./harness.ts";

// Each row with unbash 4.0.11's first error message (probed with parse()).
const unparseable: readonly (readonly [string, string])[] = [
	['echo "unterminated', "unterminated double quote"],
	["echo 'unterminated", "unterminated single quote"],
	["fi", "unexpected token 'fi'"],
	["done", "unexpected token 'done'"],
	["( ls", "expected ')' to close subshell"],
	["{ ls", "expected '}' to close brace group"],
	["if true; then ls", "expected 'fi' to close 'if'"],
	["while true; do ls", "expected 'done' to close 'while'"],
	["case a in", "expected 'esac' to close 'case'"],
	["ls |", "expected command after '|'"],
	["ls &&", "expected command after '&&'"],
	["ls ||", "expected command after '||'"],
	["rm -rf x &&", "expected command after '&&'"],
];

for (const [command, message] of unparseable) {
	test(`deny unparseable: ${command}`, async () => {
		const handler = await loadGate();
		const { ctx, notices } = uiContext();
		const result = await handler(bashCall(command), ctx);
		const reason = result?.reason ?? "";
		assert.equal(result?.block, true);
		assert.ok(reason.includes("(rule: unparseable)"), reason);
		assert.ok(reason.includes("could not be parsed as bash"), reason);
		assert.ok(reason.includes(`(${message})`), reason);
		assert.ok(reason.includes(`Command: \`${command}\``), reason);
		assert.equal(result?.terminate, undefined);
		assert.equal(notices.length, 1);
		assert.ok(notices[0]?.message.includes("unparseable"));
	});
}

for (const command of ["", "   ", "\n\n", "# just a comment"]) {
	test(`allow empty script: ${JSON.stringify(command)}`, () =>
		expectAllow(command));
}
