import { test } from "node:test";
import { expectAllow, expectDeny } from "../../test/harness.ts";

const denied: Record<string, readonly string[]> = {
	"git-push-force": [
		"git push --force",
		"git push -f",
		"git push -f origin main",
		"git push origin main -f",
		"git push origin main --force",
		"git push -fu origin main",
		"git push -uf origin main",
		"git push -vf",
		"git push --forc origin main",
		"git push --for origin main",
		"git push origin +main",
		"git push origin +HEAD:main",
		"git push origin +refs/heads/a:refs/heads/b",
		"git push origin main +feature",
		"git push +main",
		"git push origin +:",
		"git push --mirror",
		"git push --mirror origin",
		"git push --mirr origin",
		// git 2.55.0 resolves --m to --mirror (no other option starts with m).
		"git push --m origin",
		"git push --force-with-lease -f",
		"git push --force-with-lease --force",
		"git push -o ci.skip -f",
		"git -C repo push -f",
		"git -c push.default=current push --force",
		"env git push -f",
		"ls && git push --force",
		"bash -c 'git push -f'",
		"git push -- origin +main",
	],
	"git-push-delete": [
		"git push --delete origin feature",
		"git push origin --delete feature",
		"git push -d origin feature",
		"git push origin -d feature",
		"git push -ud origin feature",
		"git push --dele origin feature",
		// git 2.55.0 resolves --de to --delete (it deleted a remote branch).
		"git push --de origin feature",
		"git push origin :feature",
		"git push origin :refs/heads/feature",
		"git push origin main :old",
		"git push --prune origin",
		"git push --prune origin 'refs/heads/*:refs/heads/*'",
		"git push --pru origin",
		"git -C repo push origin :feature",
	],
};

const allowed = [
	"git push",
	"git push origin",
	"git push origin main",
	"git push -u origin main",
	"git push --set-upstream origin feature",
	"git push origin HEAD",
	"git push origin HEAD:main",
	"git push origin HEAD:refs/for/main",
	"git push origin main:main",
	"git push origin :",
	"git push --tags",
	"git push --follow-tags",
	"git push --all",
	// A dry run sends nothing (man git-push: -n, --dry-run).
	"git push --dry-run --force",
	"git push -n -f",
	"git push -n --delete origin feature",
	"git push --force-with-lease",
	"git push --force-with-lease=main",
	"git push --force-with-lease=main:abc123",
	"git push --force-with-lease --force-if-includes",
	"git push --force-if-includes",
	"git push -o ci.skip origin main",
	// -f is -o's value here (real git reads it as a push option).
	"git push -o -f origin main",
	"git push --push-option=-f origin main",
	"git push --push-option -f origin main",
	"git push --no-verify origin main",
	"git push -- origin main",
	'git log --grep "push --force"',
	'git commit -m "git push -f"',
	"echo git push --force",
];

const acceptedMisses: readonly (readonly [string, string])[] = [
	[
		"git config remote.origin.push '+refs/heads/*:refs/heads/*'",
		"push refspecs in config",
	],
	["git config alias.pf 'push --force'", "git aliases"],
];

for (const [rule, commands] of Object.entries(denied)) {
	for (const command of commands) {
		test(`deny ${rule}: ${command}`, () => expectDeny(command, rule));
	}
}

for (const command of allowed) {
	test(`allow: ${command}`, () => expectAllow(command));
}

for (const [command, why] of acceptedMisses) {
	test(`allow (accepted miss: ${why}): ${command}`, () => expectAllow(command));
}
