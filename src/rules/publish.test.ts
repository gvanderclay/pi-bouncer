import { test } from "node:test";
import { expectAllow, expectDeny } from "../../test/harness.ts";

const denied: Record<string, readonly string[]> = {
	publish: [
		"npm publish",
		"npm publish --access public",
		"npm publish ./pkg",
		"npm --tag beta publish",
		"npm --registry https://r.example publish",
		"npm -w pkg publish",
		"npm --workspace=pkg publish",
		"npm publish --otp 123456",
		"pnpm publish",
		"pnpm publish --no-git-checks",
		"pnpm -r publish",
		"pnpm publish -r",
		"pnpm --filter pkg publish",
		"pnpm -F pkg publish",
		"pnpm -C packages/a publish",
		"pnpm --dir packages/a publish",
		"yarn publish",
		"yarn publish --new-version 1.2.3",
		"yarn npm publish",
		"yarn npm publish --tag beta",
		"yarn workspace pkg npm publish",
		// Yarn 1: `yarn workspace <name> <command>` runs a Yarn command there.
		"yarn workspace pkg publish",
		"yarn workspace pkg publish --new-version 1.2.3",
		"yarn workspaces foreach -A npm publish",
		"cargo publish",
		"cargo publish -p crate",
		"cargo +nightly publish",
		"cargo -Z unstable-options publish",
		"cargo --config k=v publish",
		"/opt/homebrew/bin/npm publish",
		"env NPM_TOKEN=x npm publish",
		"ls && npm publish",
		"bash -c 'pnpm publish'",
	],
	"gh-delete": [
		"gh repo delete",
		"gh repo delete owner/repo",
		"gh repo delete owner/repo --yes",
		"gh release delete v1.0.0",
		"gh release delete v1.0.0 -y --cleanup-tag",
		"gh release delete v1 -R owner/repo",
		// `--repo` is a flag of the `release` group, accepted before the verb.
		"gh release -R owner/repo delete v1",
		"gh release --repo owner/repo delete v1",
		"gh release --repo=owner/repo delete v1",
		"env GH_TOKEN=x gh repo delete owner/repo --yes",
		"ls && gh release delete v1",
	],
};

const allowed = [
	"npm publish --dry-run",
	"pnpm publish --dry-run",
	"cargo publish --dry-run",
	// cargo publish --help: `-n, --dry-run`.
	"cargo publish -n",
	"yarn npm publish --dry-run",
	"npm run publish",
	"pnpm run publish",
	"yarn run publish",
	"yarn workspace pkg run publish",
	"yarn workspaces run publish",
	"gh release -R owner/repo list",
	"npm test",
	"npm install",
	"npm pack",
	"pnpm install",
	"cargo build",
	"cargo package",
	"gh pr merge 12",
	"gh pr merge 12 --squash --delete-branch",
	"gh release create v1.0.0 --notes x",
	"gh release list",
	"gh release view v1",
	"gh repo view",
	"gh repo clone owner/repo",
	"gh repo create owner/new --private",
	"tmux kill-server",
	"tmux kill-session -t x",
	"tmux new-session -d -s x",
	"tmux split-window -h",
	"echo npm publish",
	'git commit -m "npm publish"',
];

const acceptedMisses: readonly (readonly [string, string])[] = [
	["uv publish", "other ecosystems"],
	["poetry publish", "other ecosystems"],
	["twine upload dist/*", "other ecosystems"],
	["gem push x.gem", "other ecosystems"],
	["docker push image", "other ecosystems"],
	["gh release delete-asset v1 file.zip", "release assets"],
	["gh api -X DELETE repos/o/r", "raw gh api calls"],
	["tmux send-keys -t x 'rm -rf x' Enter", "the spec allows all tmux"],
	["tmux new-session 'rm -rf x'", "the spec allows all tmux"],
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
