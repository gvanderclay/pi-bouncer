import { test } from "node:test";
import { expectAllow, expectDeny } from "../../test/harness.ts";

const denied: Record<string, readonly string[]> = {
	"find-delete": [
		"find . -delete",
		"find . -name '*.tmp' -delete",
		"find -L . -type f -delete",
		"find . \\( -name a -o -name b \\) -delete",
		"find . -name x -print -delete",
		"find /tmp -mindepth 1 -delete",
		"gfind . -delete",
		'find . -name "-delete"',
		"find . -name -delete",
		"ls && find . -delete",
		"find . -delete | cat",
		"/usr/bin/find . -delete",
		"env find . -delete",
		"xargs find -delete",
		"echo $(find . -delete)",
		"bash -c 'find . -delete'",
		// Matches find-exec too; find-delete comes first in the catalog.
		"find . -exec rm {} \\; -delete",
	],
	"find-exec": [
		"find . -exec rm {} \\;",
		"find . -exec rm {} +",
		"find . -exec rm {} ';'",
		"find . -type f -execdir wc -l {} +",
		"find . -ok rm {} \\;",
		"find . -okdir ls {} \\;",
		"find . -name x -exec echo {} \\;",
		"gfind . -exec ls {} +",
		"ls && find . -exec true \\;",
		"timeout 5 find . -exec rm {} +",
		"sh -c 'find . -exec rm {} +'",
	],
	"fd-exec": [
		"fd -x rm",
		"fd -X rm",
		"fd --exec rm",
		"fd --exec-batch rm",
		"fd --exec=rm",
		"fd --exec-batch=rm",
		"fd -e tmp -x rm",
		"fd -Hx rm",
		"fd -HIx rm {}",
		"fd -tf -x rm",
		"fd pattern -x rm {}",
		"fd pattern . -X ls",
		"fdfind -x rm",
		"ls && fd -x rm",
		"/opt/homebrew/bin/fd -x rm",
		"env fd -X rm",
		"eval fd -x rm",
	],
	"rg-pre": [
		"rg --pre cat x",
		"rg --pre=cat x",
		"rg --pre= x",
		"rg --pre-glob '*.gz' --pre zcat x",
		"rg -z --pre cat x",
		"rg x --pre cat",
		"ls && rg --pre cat x",
		"command rg --pre cat x",
		'echo "$(rg --pre cat x)"',
		"bash -c 'rg --pre=cat x'",
	],
};

const allowed = [
	"find . -name '*.tmp'",
	"find . -name delete",
	"find . -newer delete.txt",
	"find . -type f -print",
	"find . -name exec",
	"find . -name '*.ts' -print0",
	"fd pattern",
	"fd -tx",
	"fd -t x",
	"fd --type x",
	"fd --type=x",
	"fd -e x",
	"fd -Ex",
	"fd x",
	"fd -- -x",
	"fd -H pattern",
	"rg pattern",
	"rg --no-pre x",
	"rg --pre-glob '*.gz' x",
	"rg -- --pre",
	"rg -e --pre x",
	"rg --regexp --pre x",
	"rg --regexp=--pre x",
	"rg -f patterns.txt",
	"rg 'pre' x",
	"rg -- -pre",
	"echo find . -delete",
	'git commit -m "find . -delete"',
	"rg -e--pre x",
	"rg -ie --pre x",
];

for (const [rule, commands] of Object.entries(denied)) {
	for (const command of commands) {
		test(`deny ${rule}: ${command}`, () => expectDeny(command, rule));
	}
}

for (const command of allowed) {
	test(`allow: ${command}`, () => expectAllow(command));
}
