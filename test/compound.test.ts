import { test } from "node:test";
import { expectAllow, expectDeny } from "./harness.ts";

const denied = [
	"ls && rm -rf x",
	"false || rm -rf x",
	"ls; rm -rf x",
	"cat f | rm -r x",
	"cat f |& rm -r x",
	"rm -rf x | cat",
	"rm -rf x &",
	"! rm -rf x",
	"time rm -rf x",
	"time -p rm -rf x",
	"(rm -rf x)",
	"( cd /tmp && rm -rf x )",
	"{ rm -rf x; }",
	"if true; then rm -rf x; fi",
	"if rm -rf x; then :; fi",
	"if false; then :; elif true; then rm -rf x; fi",
	"if false; then :; else rm -rf x; fi",
	"if false; then :; elif false; then :; else rm -rf x; fi",
	"while true; do rm -rf x; done",
	"while rm -rf x; do :; done",
	"until false; do rm -rf x; done",
	'for f in a b; do rm -rf "$f"; done',
	"for ((i=0; i<1; i++)); do rm -rf x; done",
	"select f in a b; do rm -rf x; done",
	"case a in a) rm -rf x;; esac",
	"case a in b) :;; *) rm -rf x;; esac",
	"case a in a) :;& b) rm -rf x;; esac",
	"coproc rm -rf x",
	"coproc NAME { rm -rf x; }",
	"f() { rm -rf x; }",
	"function f { rm -rf x; }",
	"f() { rm -rf x; }; f",
	"ls && { cd x && (true | rm -rf y); } || echo fail",
	"if true; then while false; do :; done; for f in a; do ( rm -rf x ); done; fi",
	"ls\nrm -rf x",
	"echo a\n\nrm -rf x\n",
];

const allowed = [
	"# rm -rf x",
	"ls # rm -rf x",
	"man rm",
	"which rm",
	"type rm",
	"echo rm",
	"case rm in rm) echo hi;; esac",
	"cat <<EOF\nrm -rf x\nEOF",
	"cat <<'EOF'\nrm -rf x\nEOF",
	// A line continuation: bash runs `ls rm -rf x`.
	"ls \\\nrm -rf x",
];

for (const command of denied) {
	test(`deny recursive-rm: ${JSON.stringify(command)}`, () =>
		expectDeny(command, "recursive-rm"));
}

for (const command of allowed) {
	test(`allow: ${JSON.stringify(command)}`, () => expectAllow(command));
}
