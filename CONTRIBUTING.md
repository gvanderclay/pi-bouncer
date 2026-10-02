# Contributing

Bug reports and pull requests are welcome. A way around a rule is a security
bug: report it privately, as [SECURITY.md](SECURITY.md) explains, not in an
issue.

## Setup

Node 22.19 or later and pnpm:

```sh
pnpm install
pnpm check   # lint, typecheck and tests, as CI runs them
```

One test file: `node --test src/rules/git.test.ts`. To try a change in Pi,
load your checkout: `pi -e <path to this checkout>`.

## Pull requests

Every change reaches `main` through a pull request, and CI must pass before it
merges. Pull requests are squashed, so the title becomes the commit message:
say what changes for someone using the bouncer.

- Add a user-visible change under `## [Unreleased]` in `CHANGELOG.md`. Leave
  `version` alone; releases set it.
- The tests pin current behaviour. If your change makes one fail on purpose,
  update the test and say so in the pull request and in `CHANGELOG.md`.
- A changed default keeps the old behaviour one config line away, named in
  `CHANGELOG.md`.
- Use the words in [docs/glossary.md](docs/glossary.md).

Changes that weaken the always-deny set (`src/rules/built-in-policy.ts`) or
the deny for commands that cannot be read, or that let a project file loosen
them, are not accepted.
