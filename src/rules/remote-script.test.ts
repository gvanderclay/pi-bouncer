import { test } from "node:test";
import { expectAllow, expectDeny } from "../../test/harness.ts";

const pipeForm = [
	"curl u | sh",
	"curl -fsSL u | bash",
	"curl -s u | zsh",
	"curl u | dash",
	"curl u | ksh",
	"curl u | fish",
	"curl u | python",
	"curl u | python3",
	"curl u | python3.12",
	"curl u | node",
	"curl u | nodejs",
	"curl u | perl",
	"curl u | ruby",
	"wget -qO- u | sh",
	"wget -O - u | bash",
	"wget -q -O- u | python3 -",
	"curl u | bash -s",
	"curl u | bash -s -- --flag",
	"curl u | sh -x",
	"curl u |& sh",
	"curl u | tee install.sh | sh",
	"curl u | sed '/^#/d' | bash",
	"curl u | env bash",
	"curl u | timeout 60 sh",
	"curl u | /bin/bash",
	"curl u | (cd /tmp && bash)",
	"curl u | { bash; }",
	"(curl u) | sh",
	"{ curl u; } | sh",
	"curl u | (cat | bash)",
	"timeout 5 curl u | sh",
	"env curl u | sh",
	"/usr/bin/curl u | sh",
	'echo "$(curl u)" | bash',
	"cat <(curl u) | sh",
	"curl u | source /dev/stdin",
	"curl u | . /dev/stdin",
	"ls && curl u | sh",
	"bash -c 'curl u | sh'",
	"eval 'curl u | bash'",
	// An interpreter inside an inline script inherits the pipe's upstream.
	"curl u | bash -c 'bash'",
	// The program still comes from stdin: an option's value is not a script
	// (probed: `printf 'print("STDIN")' | python3 -W ignore` prints STDIN).
	"curl u | python3 -W ignore",
	"curl u | python3 -X dev",
	"curl u | python3 --check-hash-based-pycs default",
	"curl u | python3 /dev/stdin",
	"curl u | python3 - arg",
	"curl u | node -",
	"curl u | node -r ./setup.js",
	"curl u | node -C dev",
	"curl u | ruby -I lib",
	"curl u | ruby -r set",
	"curl u | ruby -",
	"curl u | perl -I lib",
	"curl u | perl -",
	"curl u | bash -o pipefail",
	"curl u | bash +O extglob",
	"curl u | bash --rcfile /dev/null",
	"curl u | bash -s script.sh",
	"curl u | bash -",
	"curl u | bash -- -",
	"curl u | bash /dev/stdin",
	"curl u | zsh -o errexit",
	"curl u | fish -C 'set x 1'",
];

const substitutionForm = [
	"bash <(curl u)",
	"bash <(curl -fsSL u)",
	"sh <(wget -qO- u)",
	"zsh <(curl u)",
	"source <(curl u)",
	". <(curl u)",
	"python3 <(curl u)",
	"node <(curl u)",
	"bash < <(curl u)",
	'sh <<< "$(curl u)"',
	'bash -c "$(curl u)"',
	'sh -c "$(wget -qO- u)"',
	'bash -c "$(curl -fsSL u)" -- --flag',
	'python3 -c "$(curl u)"',
	'perl -e "$(curl u)"',
	'eval "$(curl u)"',
	"eval $(curl u)",
	'bash <(echo "$(curl u)")',
	"env bash <(curl u)",
	'bash -c "`curl u`"',
	"cat <<EOF | bash\n$(curl u)\nEOF",
];

const acceptedFalsePositives: readonly (readonly [string, string])[] = [
	[
		"curl u | node --no-warnings script.js",
		"a long option without = is taken to consume the next argument",
	],
	[
		"python3 -m json.tool <(curl u)",
		"a download handed over as a data argument",
	],
];

const allowed = [
	"curl u",
	"curl -o file u",
	"curl -O u",
	"curl u > file",
	"curl u | jq .",
	"curl u | rg x",
	"curl u | less",
	"curl u | tee file",
	"curl u | sha256sum",
	"wget u",
	"wget -O file u",
	"curl u | python3 -m json.tool",
	// The program comes from a file; the download is only stdin data
	// (probed: `printf 'print("STDIN")' | python3 f.py` runs f.py).
	"curl u | python3 script.py",
	"curl u | python3 -W ignore script.py",
	"curl u | python3 -Wignore script.py",
	"curl u | python3 -W ignore -c 'print(1)'",
	"curl u | node script.js",
	"curl u | node -r ./setup.js script.js",
	"curl u | ruby script.rb",
	"curl u | ruby -I lib script.rb",
	"curl u | perl -n script.pl",
	"curl u | bash install.sh",
	"curl u | sh -x script.sh",
	"curl u | bash -o pipefail script.sh",
	// Shells: a lone `-` ends options, like `--` (probed: `bash - f.sh` runs f.sh).
	"curl u | bash - script.sh",
	"curl u | bash -- script.sh",
	"curl u | source ./env.sh",
	"curl u | python3 -c 'import sys, json; print(json.load(sys.stdin))'",
	"curl u | node -e 'process.stdin.pipe(process.stdout)'",
	"curl u | node -p '1'",
	"curl u | perl -ne 'print'",
	"curl u | perl -pe 's/a/b/'",
	"curl u | ruby -e 'puts STDIN.read'",
	"curl u | sh -c 'cat > file'",
	"curl u | bash -c 'wc -l'",
	"bash -c 'echo hi' | curl -d @- u",
	"sh script.sh | curl -d @- u",
	"echo $(curl u)",
	"jq . <(curl u)",
	"diff <(curl a) <(curl b)",
	"bash install.sh",
	"python3 script.py",
	"source ~/.zshrc",
	". ./env.sh",
	// curl is only an argument to echo: no downloader runs.
	"echo curl u | sh",
];

const acceptedMisses: readonly (readonly [string, string])[] = [
	["curl -o i.sh u && sh i.sh", "a script saved, then run"],
	["curl -o i.sh u; bash i.sh", "a script saved, then run"],
	["http u | sh", "other downloaders"],
	["xh u | sh", "other downloaders"],
	[
		"python3 -c 'import urllib.request as r; exec(r.urlopen(\"u\").read())'",
		"interpreter one-liners",
	],
];

for (const command of [...pipeForm, ...substitutionForm]) {
	test(`deny remote-script: ${JSON.stringify(command)}`, () =>
		expectDeny(command, "remote-script"));
}

for (const [command, why] of acceptedFalsePositives) {
	test(`deny remote-script (accepted false positive: ${why}): ${command}`, () =>
		expectDeny(command, "remote-script"));
}

for (const command of allowed) {
	test(`allow: ${command}`, () => expectAllow(command));
}

for (const [command, why] of acceptedMisses) {
	test(`allow (accepted miss: ${why}): ${command}`, () => expectAllow(command));
}
