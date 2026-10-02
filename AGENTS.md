# pi-bouncer

A Pi extension that guards the `bash` tool. Words the code and docs use are
defined in `docs/glossary.md`; use them, and not the words it lists to avoid.
The productionizing plan, with its decisions, is `docs/plan.md`.

## Layout

- `src/`: the extension. `src/index.ts` is the entry Pi loads; `src/rules/`
  holds the rules, `src/scan/` the bash parsing.
- `skills/`: the `bouncer-debug` and `auto-judge-list` skills, with their
  helper scripts beside each `SKILL.md`.
- Tests are `*.test.ts` beside the code they cover. Shared helpers
  (`harness.ts`, `auto-harness.ts`, `jev-replies.ts`) and `fixtures/` live in
  `test/`. Nothing under `test/` and no `*.test.ts` is published;
  `scripts/check-pack.mjs` enforces that.

## Checks

- `pnpm check` runs lint (`biome ci .`), typecheck (`tsc -p .`) and the
  tests. Run it before every commit; CI runs the same on Node 22.19 and 24.
- A single file: `node --test src/rules/git.test.ts`.
- `node scripts/check-pack.mjs` after changing `package.json` `files` or adding
  a top-level path.

## Changes

- Never commit to `main`: a ruleset refuses pushes there. Work on a branch,
  open a pull request with `gh pr create`, and merge with
  `gh pr merge --squash --auto`; it merges once the `check` and `pack` jobs
  pass. The pull request title becomes the commit message.
- Repository settings and rulesets live in `.github/repo-settings.json`.
  Change them there, in a pull request, then apply them with
  `node scripts/repo-settings.mjs` (`--dry-run` first); never in GitHub's UI.
- Fill in `.github/pull_request_template.md`. `CONTRIBUTING.md` is the
  human-facing copy of these rules; keep the two in step.

## Releases

- Add each user-visible change under `## [Unreleased]` in `CHANGELOG.md` as
  it lands. Never edit `version` or tag by hand.
- Release with `pnpm release patch` (or `minor`, `major`) on an up-to-date
  `main`: it bumps the version, moves the CHANGELOG entries and opens a
  release pull request set to auto-merge. It refuses when `[Unreleased]` is
  empty. Once that merges, `release.yml` sees an untagged version on `main`,
  checks, tags, publishes to npm by trusted publishing, and makes the GitHub
  release.

## Rules

- The tests pin current behaviour. A change that makes one fail changes
  behaviour: update the test only when the change is deliberate, and say so
  in the commit and in `CHANGELOG.md`.
- Never weaken the always-deny set (`src/rules/built-in-policy.ts`) or the
  unreadable-command denies, and never let a project file loosen them.
- Every feature stays available; a changed default keeps the old behaviour
  one config line away, named in `CHANGELOG.md`.
- The bouncer gates the shell it is developed in. Try unpushed changes with
  `pi -e <this checkout>`, and keep each merged step green: a broken rule can
  deny every bash call for anyone following `main`.
