import assert from "node:assert/strict";
import { test } from "node:test";
import {
	bashCall,
	expectAllow,
	expectDeny,
	fakeContext,
	loadGate,
} from "./harness.ts";

const denied = [
	"bash -c 'rm -rf x'",
	"sh -c 'rm -rf x'",
	"zsh -c 'rm -rf x'",
	"dash -c 'rm -rf x'",
	"ksh -c 'rm -rf x'",
	"/bin/bash -c 'rm -rf x'",
	'bash -c "rm -rf x"',
	"bash -c 'ls; rm -rf x'",
	"bash -c 'ls && rm -rf x'",
	"bash -c 'echo $(rm -rf x)'",
	'bash -c "rm \\"-rf\\" x"',
	"bash -lc 'rm -rf x'",
	"bash -ec 'rm -rf x'",
	"bash -xc 'rm -rf x'",
	"bash -cl 'rm -rf x'",
	"bash -c -e 'rm -rf x'",
	"bash -o pipefail -c 'rm -rf x'",
	"bash +o history -c 'rm -rf x'",
	"bash -O extglob -c 'rm -rf x'",
	"bash --norc --noprofile -c 'rm -rf x'",
	"bash --login -c 'rm -rf x'",
	"bash --rcfile /dev/null -c 'rm -rf x'",
	"sh -c 'rm -rf x' sh arg1",
	"sh -c -- 'rm -rf x'",
	"bash -c \"bash -c 'rm -rf x'\"",
	"bash -c 'eval rm -rf x'",
	"eval rm -rf x",
	'eval "rm -rf x"',
	"eval 'rm' '-rf' x",
	'eval "rm" "-rf x"',
	"eval -- rm -rf x",
	"eval 'ls; rm -rf x'",
	"eval \"$(echo ls)\"; eval 'rm -rf x'",
	"timeout 5 bash -c 'rm -rf x'",
	"env bash -c 'rm -rf x'",
	"xargs sh -c 'rm -rf \"$@\"' _",
	"find . -print0 | xargs -0 bash -c 'rm -rf \"$1\"' _",
	"echo $(bash -c 'rm -rf x')",
	"ls && sh -c 'cd /tmp && rm -rf x'",
	"env -S 'rm -rf x'",
	"env -S'rm -rf x'",
	"env --split-string='rm -rf x'",
	"env --split-string 'rm -rf x'",
	"env -S 'rm -rf' x",
	"env -S 'rm' -rf x",
	// env -S splices its words into env's argv, so env options may follow.
	"env -S '-i rm' -rf x",
	"env -S '' rm -rf x",
	"trap 'rm -rf x' EXIT",
	"trap -- 'rm -rf x' EXIT INT",
	'trap "rm -rf x" ERR',
	// Exactly depth 3: still judged, not too deep.
	"eval eval eval rm -rf x",
];

// Depth 4 from `bash -c` alone: each level unwraps one layer of quoting.
const bashOnlyDepth4: string = 'bash -c "bash -c \'bash -c \\"bash -c ls\\"\'"';

const tooDeep: readonly string[] = [
	"eval eval eval eval ls",
	"eval eval eval eval rm -rf x",
	// bash -c (1) → eval (2) → eval (3) → eval (4).
	"bash -c \"eval eval 'eval ls'\"",
	bashOnlyDepth4,
];

const unparseable = [
	"bash -c 'if'",
	"bash -c 'echo \"unterminated'",
	"sh -c '( ls'",
	"eval 'fi'",
	"eval '('",
	"bash -c 'echo $(if)'",
	"env -S 'ls | rm x'",
	"trap 'if' EXIT",
];

const allowed = [
	"bash script.sh",
	"bash -c 'ls'",
	"sh -c 'echo hi' sh",
	'bash -c "$SCRIPT"',
	"bash -c",
	"eval",
	"eval ls",
	'eval "$(ssh-agent -s)"',
	"bash -n script.sh",
	"bash -e script.sh",
	"bash -- -c",
	"bash -o pipefail script.sh",
	"eval eval eval ls",
	"trap - INT",
	"trap INT",
	"trap -l",
	"trap -p",
	"trap '' INT",
	"trap 'echo bye' EXIT",
	"env -S 'ls -la'",
	// Operands after the script are $0, $1: not part of it.
	"bash -c 'ls' 'rm -rf x'",
	"trap -- - INT",
	"env -S '' ls",
];

const acceptedMisses: readonly (readonly [string, string])[] = [
	["fish -c 'rm -rf x'", "fish syntax is not bash"],
	["ssh host 'rm -rf x'", "remote commands"],
	[
		"python3 -c 'import shutil; shutil.rmtree(\"x\")'",
		"interpreter one-liners",
	],
	["bash -c \"$(printf 'rm -rf x')\"", "a script produced at runtime"],
];

for (const command of denied) {
	test(`deny recursive-rm: ${command}`, () =>
		expectDeny(command, "recursive-rm"));
}

for (const command of tooDeep) {
	test(`deny inline-too-deep: ${command}`, async () => {
		const handler = await loadGate();
		const result = await handler(bashCall(command), fakeContext());
		assert.equal(result?.block, true);
		assert.equal(
			result?.reason,
			`Blocked by the user's bouncer (rule: inline-too-deep): the command nests inline scripts (sh -c, eval, env -S, trap) more than 3 levels deep. Command: \`${command}\`. None of the command ran. Rewrite it without the nesting.`,
		);
	});
}

for (const command of unparseable) {
	test(`deny unparseable: ${command}`, async () => {
		const handler = await loadGate();
		const result = await handler(bashCall(command), fakeContext());
		assert.equal(result?.block, true);
		assert.ok(
			result?.reason?.includes("(rule: unparseable)"),
			String(result?.reason),
		);
	});
}

for (const command of allowed) {
	test(`allow: ${command}`, () => expectAllow(command));
}

for (const [command, why] of acceptedMisses) {
	test(`allow (accepted miss: ${why}): ${command}`, () => expectAllow(command));
}
