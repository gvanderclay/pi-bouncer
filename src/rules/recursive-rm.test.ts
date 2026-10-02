import assert from "node:assert/strict";
import { test } from "node:test";
import {
	bashCall,
	expectAllow,
	expectDeny,
	fakeContext,
	loadGate,
} from "../../test/harness.ts";

test("rm -rf build is denied as recursive-rm when no one can be asked", async () => {
	const handler = await loadGate();
	const result = await handler(bashCall("rm -rf build"), fakeContext());
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /\(rule: recursive-rm\)/);
	assert.ok(result?.reason?.includes("`rm -rf build`"));
	assert.match(result?.reason ?? "", /Do not retry/);
	assert.equal(result?.terminate, undefined);
});

const denied = [
	"rm -rf build",
	"rm -r x",
	"rm -R x",
	"rm -fr x",
	"rm -Rf x",
	"rm -rfv x",
	"rm -vR x",
	"rm -dr x",
	"rm -r -f x",
	"rm -f -r x",
	"rm -i -r x",
	"rm --recursive x",
	"rm --recursive --force x",
	"rm --rec x",
	"rm --recur x",
	"rm --r x",
	"rm -r",
	"rm -rf .",
	"rm -rf *",
	"rm x -r",
	"rm a b c -rf",
];

const allowed = [
	"rm file.txt",
	"rm -f a b",
	"rm -v x",
	"rm -i x",
	"rm -d emptydir",
	"rm --dir emptydir",
	"rm --force x",
	"rm -- -r",
	"rm -f -- -rf",
	"rm -- --recursive",
	"rm -",
];

for (const command of denied) {
	test(`deny recursive-rm: ${command}`, () =>
		expectDeny(command, "recursive-rm", command));
}

for (const command of allowed) {
	test(`allow: ${command}`, () => expectAllow(command));
}
