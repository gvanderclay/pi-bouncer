// What counts as one foreground simple command, which relative paths and
// copies depend on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "unbash";
import { soleDirectInvocation } from "./agent-made-command.ts";
import { scan } from "./scan/walk.ts";

function sole(command: string): string | undefined {
	const result = scan(parse, command);
	if (result.kind !== "ok") return undefined;
	return soleDirectInvocation(parse, command, result.invocations)?.name;
}

const direct = [
	"rm -rf scratch",
	"rm -rf scratch;",
	"rm -rf scratch\n",
	"  mkdir  -p a/b",
	"cp -r 'a b' c",
	'cp -r "a" c',
	"/bin/rm -rf scratch",
	"rm -rf -- ./-x",
];

for (const command of direct) {
	test(`direct: ${JSON.stringify(command)}`, () => {
		assert.ok(sole(command), command);
	});
}

const indirect = [
	"! cp -r a b",
	"! mkdir a",
	"cp -r a b; true",
	"cp -r a b || true",
	"cp -r a b && true",
	"true && cp -r a b",
	"cp -r a b &",
	"cp -r a b | cat",
	"cp -r a b > out",
	"cp -r a b 2>&1",
	"cp -r a b <<< x",
	"FOO=1 cp -r a b",
	"timeout 5 cp -r a b",
	"command rm -rf a",
	"env rm -rf a",
	"time cp -r a b",
	"(cp -r a b)",
	"{ cp -r a b; }",
	"if true; then cp -r a b; fi",
	"f() { cp -r a b; }; f",
	"cp -r a $B",
	"cp -r a $(echo b)",
	"cp -r a `echo b`",
	"cp -r a ${B}",
	"cp -r a $((1+1))",
	"cp -r a {b,c}",
	"cp -r a <(echo b)",
	"cp -r a b\\ c",
	"cp -r a $'b'",
	'cp -r a "$B"',
	'cp -r a "x$(echo y)"',
	"",
	"cp -r a 'unterminated",
];

for (const command of indirect) {
	test(`not direct: ${JSON.stringify(command)}`, () => {
		assert.equal(sole(command), undefined);
	});
}
