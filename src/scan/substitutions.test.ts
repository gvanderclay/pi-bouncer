import assert from "node:assert/strict";
import { test } from "node:test";
import {
	bashCall,
	expectAllow,
	expectDeny,
	loadGate,
} from "../../test/harness.ts";

const denied = [
	"echo $(rm -rf x)",
	'echo "$(rm -rf x)"',
	'echo "a $(rm -rf x) b"',
	"echo $(echo $(rm -rf x))",
	"echo $(ls; rm -rf x)",
	"echo $(ls && rm -rf x)",
	"echo $( (rm -rf x) )",
	"cat <(rm -rf x)",
	"tee >(rm -rf x)",
	"diff <(ls) <(rm -rf x)",
	"x=$(rm -rf x)",
	'x="$(rm -rf x)"',
	"x=$(rm -rf x) ls",
	"a=(one $(rm -rf x))",
	"arr[$(rm -rf x)]=1",
	"export v=$(rm -rf x)",
	"local v=$(rm -rf x)",
	"declare v=$(rm -rf x)",
	"readonly v=$(rm -rf x)",
	"ls > $(rm -rf x)",
	'ls 2> "$(rm -rf x)"',
	"cat < <(rm -rf x)",
	"cat <<< $(rm -rf x)",
	'cat <<< "$(rm -rf x)"',
	"echo ${v:-$(rm -rf x)}",
	"echo ${v:=$(rm -rf x)}",
	"echo ${v:+$(rm -rf x)}",
	"echo ${v:?$(rm -rf x)}",
	"echo ${v/a/$(rm -rf x)}",
	"echo ${v:$(rm -rf x):1}",
	"echo ${arr[$(rm -rf x)]}",
	"echo $(( $(rm -rf x) ))",
	"echo $(( 1 + $(rm -rf x) ))",
	"echo $[ $(rm -rf x) ]",
	"(( $(rm -rf x) ))",
	"for ((i=$(rm -rf x); i<1; i++)); do :; done",
	"echo {a,$(rm -rf x)}",
	"echo @(a|$(rm -rf x))",
	"echo ${ rm -rf x; }",
	"echo ${| rm -rf x; }",
	"for f in $(rm -rf x); do :; done",
	"select f in $(rm -rf x); do :; done",
	"case $(rm -rf x) in *) ;; esac",
	"case a in $(rm -rf x)) ;; esac",
	"[[ -n $(rm -rf x) ]]",
	"[[ $(rm -rf x) == a ]]",
	'[[ a == a && -z "$(rm -rf x)" ]]',
	"if [[ -n $(rm -rf x) ]]; then :; fi",
	"ls && echo $(rm -rf x)",
	"echo $(rm -rf x) | cat",
	"echo `rm -rf x`",
	'echo "`rm -rf x`"',
	"echo `echo \\`rm -rf x\\``",
	"cat <<EOF\n$(rm -rf x)\nEOF",
	"cat <<EOF\n`rm -rf x`\nEOF",
	"cat <<-EOF\n\t$(rm -rf x)\n\tEOF",
	"cat <<EOF\nhello ${v:-$(rm -rf x)}\nEOF",
];

const allowed = [
	"echo '$(rm -rf x)'",
	'echo "\\$(rm -rf x)"',
	// bash rejects `echo \$(rm -rf x)` (see unparseable); escaping `(` is valid.
	"echo \\$\\(rm -rf x\\)",
	"echo $(ls)",
	'echo "$(git status)"',
	"diff <(ls a) <(ls b)",
	"x=$(date)",
	"echo ${v:-default}",
	"echo $(( 1 + 2 ))",
	"echo $(<file)",
	"x=1",
	"> out.txt",
	"echo ${#v}",
	"echo '`rm -rf x`'",
	"cat <<'EOF'\n$(rm -rf x)\nEOF",
	'cat <<"EOF"\n$(rm -rf x)\nEOF',
	"cat <<\\EOF\n$(rm -rf x)\nEOF",
];

const unparseable = [
	"echo $(rm -rf x",
	"echo $(if)",
	"echo $(if true; then ls)",
	"echo $( ( ls )",
	"cat <(if)",
	"x=$(fi)",
	"echo ${ if; }",
	// Listed as an allow in the ticket, but bash itself rejects it:
	// "syntax error near unexpected token `('".
	"echo \\$(rm -rf x)",
	"echo `if`",
	"cat <<EOF\n$(if)\nEOF",
	// Scan failures win over rules.
	"echo $(if) && rm -rf x",
];

for (const command of denied) {
	test(`deny recursive-rm: ${JSON.stringify(command)}`, () =>
		expectDeny(command, "recursive-rm", "rm -rf x"));
}

for (const command of allowed) {
	test(`allow: ${JSON.stringify(command)}`, () => expectAllow(command));
}

for (const command of unparseable) {
	test(`deny unparseable: ${JSON.stringify(command)}`, async () => {
		const handler = await loadGate();
		const result = await handler(bashCall(command), {} as never);
		assert.equal(result?.block, true);
		assert.ok(
			result?.reason?.includes("(rule: unparseable)"),
			String(result?.reason),
		);
		assert.ok(result?.reason?.includes(`Command: \`${command}\``));
	});
}
