# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

The first public release, 0.1.0, will collect everything below. Before it, the
bouncer lived in its author's dotfiles.

### Added

- MIT license and npm package metadata.
- CI on Node 22.19 and 24, and a check of the published file list.
- `auto.jev.model` picks Jev's provider: any classifier model in Pi's
  catalogue as `provider/id`, such as `openrouter/typesafe/jev-1.13` or
  `typesafe/jev-latest`. Without it Jev still uses OpenCode Zen's
  `jev-1.13` with the opencode-go key. `/auto status`, the log and
  the notices name the model. The Jev bench takes `--model`. The cutoffs were
  measured through Zen only.
- The skills' scripts (`explain`, the judge bench) now run from an npm
  install: the package ships them built to `dist/` (`pnpm build`, run on
  pack), and they find Pi's package through the `pi` on `PATH` or
  `$PI_PACKAGE_DIR` when it is not installed beside them. The skills call the
  built files; a git checkout can run `pnpm build` once or the `.ts` files.
- A JSON Schema for both config files, `schema/bouncer.schema.json`, and a
  top-level `"$schema"` key that points an editor at it. `$schema` was
  reported as an unknown key before.
- The `/bouncer` command: `status` (the default), `rules`, `explain
  <command>`, `init` and `check`.
- A one-time notice, "Bouncer is on: …", at the first session start of a Pi
  process with a UI while no user config exists. `/bouncer init`, or any
  `bouncer.json` in the Pi agent dir, silences it.

### Changed

- Jev is now always called through Pi's classifier support (Pi's
  `opencode/jev-1.13`, handed the opencode-go key, when `auto.jev.model` is
  absent), still with no retries and a 5 s budget. The address, model and key
  are unchanged, but a failed call's error now uses Pi's wording, for example
  `System One API error (500): …` instead of `HTTP 500: …`, and `System One
  API did not return an answer for safety` instead of `reply has no safety
  answer`. The Jev tests in `src/auto-jev.test.ts` and the bench tests were
  updated to match, deliberately.
- On a Pi without project trust (`ctx.isProjectTrusted`), the bouncer warns
  that Pi is too old and treats the project as untrusted, instead of failing
  at session start.
- When the bash parser cannot load, the deny now says to reinstall the
  package or run `npm install` in the package's directory, instead of
  `pnpm install` in the old dotfiles path. `src/fail-closed.test.ts` was
  updated to match, deliberately.
- Messages no longer say "route": "the user's auto.alwaysAsk list", "only
  the user config (bouncer.json in the Pi agent dir) sets …", and auto
  mode's refusal names the user config. The log's values are unchanged. The
  tests asserting these strings were updated, deliberately.
- `auto.jev.model` is no longer an unknown key; a value that is not
  `provider/id` is a config problem and leaves Jev off.

- The process-wide key that keeps the bouncer mode across `/reload` is now
  `Symbol.for("pi-bouncer.mode")`. A Pi process that updates the bouncer and
  then runs `/reload` drops back to normal mode once.
- The source moved under `src/`; Pi now loads `src/index.ts`. A checkout loaded
  with `pi -e <path to the checkout>` is unaffected; anything that pointed at
  `index.ts` directly must point at `src/index.ts`.
