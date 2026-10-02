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

## Rules

- The tests pin current behaviour. A change that makes one fail changes
  behaviour: update the test only when the change is deliberate, and say so
  in the commit and in `CHANGELOG.md`.
- Never weaken the always-deny set (`src/rules/built-in-policy.ts`) or the
  unreadable-command denies, and never let a project file loosen them.
- Every feature stays available; a changed default keeps the old behaviour
  one config line away, named in `CHANGELOG.md`.
- The bouncer gates the shell it is developed in. Try unpushed changes with
  `pi -e <this checkout>`, and keep each pushed step green: a broken rule can
  deny every bash call for anyone following `main`.
