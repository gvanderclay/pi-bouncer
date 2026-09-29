import { test } from "node:test";
import { expectAllow, expectDeny } from "./harness.ts";

const denied = [
	"env rm -rf x",
	"/usr/bin/env rm -rf x",
	"env -i rm -rf x",
	"env - rm -rf x",
	"env -0 rm -rf x",
	"env -u HOME rm -rf x",
	"env -uHOME rm -rf x",
	"env --unset HOME rm -rf x",
	"env --unset=HOME rm -rf x",
	"env -C /tmp rm -rf x",
	"env --chdir=/tmp rm -rf x",
	"env -P /bin rm -rf x",
	"env FOO=1 rm -rf x",
	"env FOO=1 BAR=2 rm -rf x",
	"env -i FOO=1 rm -rf x",
	"env -- rm -rf x",
	"env --ignore-environment --debug rm -rf x",
	// GNU env -a/--argv0 takes a value (genv --help, coreutils 9.11).
	"env -a foo rm -rf x",
	"env --argv0 foo rm -rf x",
	"command rm -rf x",
	"command -p rm -rf x",
	"command -- rm -rf x",
	"builtin rm -rf x",
	"exec rm -rf x",
	"exec -a foo rm -rf x",
	"exec -c -l rm -rf x",
	"nohup rm -rf x",
	"nohup rm -rf x &",
	"/usr/bin/time rm -rf x",
	"/usr/bin/time -p rm -rf x",
	"/usr/bin/time -o log rm -rf x",
	"/usr/bin/time -f '%e' rm -rf x",
	"/usr/bin/time --output=log rm -rf x",
	"command time rm -rf x",
	"nice rm -rf x",
	"nice -n 5 rm -rf x",
	"nice -n5 rm -rf x",
	"nice -n -5 rm -rf x",
	"nice -5 rm -rf x",
	"nice --adjustment=5 rm -rf x",
	"nice --adjustment 5 rm -rf x",
	"timeout 5 rm -rf x",
	"timeout 5s rm -rf x",
	"timeout -s KILL 5 rm -rf x",
	"timeout -sKILL 5 rm -rf x",
	"timeout -k 1 5 rm -rf x",
	"timeout --signal=TERM --kill-after=1 5s rm -rf x",
	"timeout --signal TERM 5 rm -rf x",
	"timeout --foreground --preserve-status 5 rm -rf x",
	"timeout -v 5 rm -rf x",
	"gtimeout 5 rm -rf x",
	"stdbuf -oL rm -rf x",
	"stdbuf -o L rm -rf x",
	"stdbuf -i0 -o0 -e0 rm -rf x",
	"stdbuf --output=L rm -rf x",
	"gstdbuf -oL rm -rf x",
	"caffeinate rm -rf x",
	"caffeinate -i rm -rf x",
	"caffeinate -dims rm -rf x",
	"caffeinate -t 60 rm -rf x",
	"caffeinate -w 123 rm -rf x",
	"xargs rm -rf",
	"xargs -0 rm -r",
	"xargs -n 1 rm -rf",
	"xargs -n1 rm -rf",
	"xargs -I{} rm -rf {}",
	"xargs -I {} rm -rf {}",
	"xargs -P 4 -L 1 rm -r",
	"xargs --max-args=1 rm -rf",
	"xargs --max-args 1 rm -rf",
	"xargs -d '\\n' rm -rf",
	"xargs -a list.txt rm -rf",
	"xargs -r rm -rf",
	"xargs -t -p rm -rf",
	"xargs -J % rm -rf % dest",
	"find . | xargs rm -rf",
	"find . -print0 | xargs -0 rm -rf",
	"env timeout 5 nice -n 5 nohup rm -rf x",
	"FOO=1 env BAR=2 command rm -rf x",
	"timeout 5 env -i xargs -0 rm -rf",
	'nohup env /bin/rm "-rf" x',
	"echo $(env rm -rf x)",
	'ls && timeout 5 /bin/rm "-rf" x',
	"timeout --made-up 5 rm -rf x",
	"env --made-up rm -rf x",
	// Ticket 07 re-parses env -S strings (was an accepted miss).
	"env -S 'rm -rf x'",
];

const allowed = [
	"command -v rm",
	"command -V rm",
	"command -pv rm",
	"env",
	"env FOO=1",
	"env -i",
	"env -u HOME",
	"nice",
	"nohup ls",
	"exec > log",
	"exec 3>&1",
	"exec",
	"timeout 5 ls",
	"env rm file.txt",
	"xargs rm",
	// -r belongs to xargs (no-run-if-empty), so the rm it runs is not recursive.
	"xargs -r rm x",
	"xargs rm -f",
	"xargs -I{} rm {}",
	"xargs",
	"caffeinate",
	"caffeinate -t 60",
	"stdbuf -oL ls",
	"/usr/bin/time ls",
	// The value of a wrapper option is not a command.
	"env -u rm -rf",
	"timeout -s rm 5 ls",
];

const acceptedMisses: readonly (readonly [string, string])[] = [
	["watch 'rm -rf x'", "watch runs a shell string"],
	["ssh host 'rm -rf x'", "remote commands"],
];

for (const command of denied) {
	test(`deny recursive-rm: ${command}`, () =>
		expectDeny(command, "recursive-rm"));
}

for (const command of allowed) {
	test(`allow: ${command}`, () => expectAllow(command));
}

for (const [command, why] of acceptedMisses) {
	test(`allow (accepted miss: ${why}): ${command}`, () => expectAllow(command));
}
