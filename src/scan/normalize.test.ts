import { test } from "node:test";
import { expectAllow, expectDeny } from "../../test/harness.ts";

const denied = [
	"/bin/rm -rf x",
	"/usr/bin/rm -rf x",
	"/opt/homebrew/bin/grm -rf x",
	"grm -rf x",
	"./rm -rf x",
	"../bin/rm -rf x",
	"bin/rm -rf x",
	"//bin//rm -rf x",
	"\\rm -rf x",
	"r\\m -rf x",
	"'rm' -rf x",
	'"rm" -rf x',
	'r"m" -rf x',
	"r'm' -rf x",
	'"/bin/rm" -rf x',
	"$'rm' -rf x",
	'rm "-rf" x',
	"rm '-rf' x",
	'rm -"rf" x',
	"rm -'r' x",
	'rm "--recursive" x',
	"rm $'-rf' x",
	'rm "-r""f" x',
	"FOO=1 rm -rf x",
	"A=1 B=2 rm -rf x",
	"LC_ALL=C /bin/rm -rf x",
	'FOO="a b" rm -rf x',
	"FOO=$(date) rm -rf x",
];

const data = [
	'git commit -m "rm -rf old cache"',
	"git commit -m 'rm -rf x'",
	"echo rm -rf x",
	'echo "sudo rm -rf /"',
	"printf '%s\\n' 'rm -rf x'",
	'rg -F "rm -rf" .',
	"rg 'rm -rf'",
	'FOO="rm -rf x" ls',
	"FOO='rm -rf x'",
	"echo $'rm\\x20-rf x'",
	"echo /bin/rm -rf x",
	"ls /bin/rm",
	"rmdir x",
	"rm-cleanup -rf x",
	"./rm.sh -rf x",
];

const acceptedMisses: readonly (readonly [string, string])[] = [
	["$cmd -rf x", "a variable as the command name"],
	["${RM} -rf x", "a variable as the command name"],
	['"$RM" -rf x', "a variable as the command name"],
	["alias r=rm; r -rf x", "an alias defined in the same command"],
	["rm $(echo -rf) x", "flags produced by a substitution"],
	["rm $FLAGS x", "flags held in a variable"],
];

for (const command of denied) {
	test(`deny recursive-rm: ${command}`, () =>
		expectDeny(command, "recursive-rm"));
}

for (const command of data) {
	test(`allow data: ${command}`, () => expectAllow(command));
}

for (const [command, why] of acceptedMisses) {
	test(`allow (accepted miss: ${why}): ${command}`, () => expectAllow(command));
}
