# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- When no one can answer a `recursive-rm` ask, the block reason suggests
  moving the target to the trash instead, naming the first of `trash`,
  `trash-put` and `gio trash` found on `PATH`, or the user config's new
  `trashCommand`. With none found, it suggests nothing.
- The `trash-root` rule (deny) refuses moving `/`, a system directory, your
  home directory or a `protect`ed folder to the trash with `trash`,
  `trash-put`, `gio trash` or `trashCommand`. This is a new deny: `"levels":
  {"trash-root": "off"}` restores the old behaviour.

### Changed

- A recursive `rm` of a folder the agent made earlier in the session (by a
  `mkdir` of a missing path, or a lone `mktemp -d`), or of something inside
  it, no longer asks, in any mode and with or without a UI. Only plain `rm`
  with full paths counts, alone on its line (bar `cd`, `echo` and the like)
  and alone in the agent's message; a variable, `~`, wildcard, wrapper,
  symlink out of the folder, or anything inside dated before the folder was
  made still asks.
  `"trustAgentMade": false` restores the old behaviour.
- While that is on, each run's system prompt gets a short `<bouncer>` section
  telling the agent how to delete a folder it made without an ask. The
  research behind it is `docs/research/agent-guidance.md`.
- When no one can answer a `recursive-rm` ask, the block reason now repeats
  the `<bouncer>` section and says to retry if the delete fits it; then, with
  a trash program found, to trash anything else or a folder whose retry is
  blocked too; only then does it tell the agent to stop and ask the user. It
  no longer says "do not retry" before offering a retry. The tests pinning
  the old reason text were updated.
- The `<bouncer>` section now names every condition the agent controls: the
  folder made by `mkdir` on a full path or by a `mktemp -d` on its own,
  nothing older moved or copied in, and the `rm` the only tool call in its
  message. It no longer claims every other recursive rm needs the user's
  approval, which was untrue in auto and YOLO mode. Live runs showed agents
  making folders with a relative `mkdir` or a `mktemp -d` inside a longer
  line, or deleting two folders in parallel, and then being refused.
- The `rm-root` and `trash-root` block reasons now say "a protected path"
  and list a path the user's config protects, instead of naming only `/`,
  system directories and the home directory, which misled the agent when a
  `protect`ed path matched. The tests pinning the old text were updated.
- Jev now allows from 1 minus its deny score, at a new default `allowAt` of
  0.9, instead of from its `safety` question at 0.75. Measured on 120 fresh
  held-out cases, it allows slightly more (34 against 32) with no wrong
  allow, and its cutoff, picked on the bench alone, held on the held-out set
  where `safety`'s did not. A user config that sets its own `allowAt` now
  applies it to the new score. `"allowFrom": "safety", "allowAt": 0.75`
  under `auto.jev` restores the old behaviour. The tests pinning the old
  default were updated.
- The `auto-judge-list` skill's Jev bench reports and recommends `allowAt`
  from that allow score (`--allow-from safety` for the old one), and checks
  it on a second held-out set of 120 cases as well.

## [0.2.0] - 2026-10-02

### Added

- Profiles: `profiles` names groups of rule changes (`levels`, `rules`,
  `protect`, `mode`), and `agents` maps an agent name to one. A session's agent
  name comes from `PI_BOUNCER_AGENT`, then `PI_SUBAGENT_AGENT`, then
  `PI_DADDY_DEFINITION`. A profile starts from the normal rules and may loosen
  or tighten; the always-deny set still holds, and an untrusted project's
  profiles only tighten. A missing or broken profile falls back to the normal
  rules with a warning. A profile's `mode` applies only when no `--auto` or
  `--yolo` is given. `/bouncer status` shows the profile, and the log records
  it. `examples/profiles.json` is a starting point.
- The `bouncer-escape` rule denies bash that starts `pi --yolo` or sets or
  clears `PI_BOUNCER_AGENT`, `PI_SUBAGENT_AGENT` or `PI_DADDY_DEFINITION`
  (`VAR=x cmd`, `export`, `env VAR=x`, `unset VAR`, `env -u VAR`, and `env -i`
  running `pi`). Starting `pi` otherwise is still allowed. This is a new deny
  for anyone who ran `pi --yolo` from bash: `"levels": {"bouncer-escape":
  "off"}` restores the old behaviour, and `"ask"` asks instead.
- A child started through `session:launch` gets its agent's profile, or its
  parent's profile when its agent has none.
- `bouncer-debug` replays a call under the profile it ran in.

### Changed

- `/bouncer status` has a new `Profile:` line after `Bouncer mode:`, so the
  `Parser:` line and the lines after it move down one. The `/bouncer status`
  tests in `src/bouncer-command.test.ts` were updated for the new line. The
  JSON schema keeps the `levels`, `rules` and `protect` schemas under
  `definitions`, so profiles can share them; `src/schema.test.ts` reads them
  there. `src/config.test.ts`'s expected config gains `profiledAgents`.
- Releases go through a pull request: `pnpm release patch` bumps the version,
  moves the changelog entries and opens a release pull request. Merging it
  tags, publishes to npm by trusted publishing and makes the GitHub release.
  Pushing a tag no longer publishes.

## [0.1.0] - 2026-10-02

The first public release. Before it, the bouncer lived in its author's
dotfiles; the changes below are against that copy.

### Added

- MIT license and npm package metadata.
- CI on Node 22.19 and 24, and a check of the published file list.
- A release workflow that stages a release on npm, with provenance, when a
  `v*` tag is pushed; it goes live once a maintainer approves it with 2FA.
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
- `"off"` as a level: `levels` can turn any rule off except the always-deny
  set and the unreadable-command denies. A trusted project may turn rules
  off; an untrusted one may not lower any level. `/bouncer status` gains an
  `Off:` line, and the log's `config.levels` shows `off` rules.
- `protect` adds folders below home (`home`) and absolute paths (`paths`)
  to `rm-root`. Both config files may set it, an untrusted project's
  included, because it only adds. `/bouncer status` lists the additions, and
  the log's `config.protect` records them.
- Custom rules under `rules`: a `name`, a `command` (one program or a list),
  optional `args` that must follow it in order, a `summary` and a `level`
  (`ask` by default, `deny` or `off`). They match through wrappers, chains,
  `sh -c`, and the commands `find -exec` and `fd -x` run. An `instead` text
  makes a steer rule, denied in every mode with that text sent to the model.
  An untrusted project may add ask and deny rules but not steer rules.
  `examples/prefer-rg.json` is a recipe.
- Example configs in `examples/`: a minimal one, auto mode with Anthropic,
  auto mode with OpenRouter (Jev included), and a project file. The tests
  check that each validates and loads with no problems.
- A rewritten README, with the key reference in `docs/configuration.md` and
  the detailed behaviour in `docs/behaviour.md`.

### Changed

- The `grep` steer rule is no longer built in: grep runs untouched by default.
  To get the old behaviour back, copy the rule in `examples/prefer-rg.json`
  into your `bouncer.json`; it blocks `grep`, `egrep` and `fgrep` with the
  same message, rule name and log entries. The grep tests now load that
  file, deliberately; `levels` no longer accepts `grep`.
- `rm-root` now also covers the Linux system directories `/home`, `/root`,
  `/boot`, `/lib`, `/lib64`, `/srv`, `/dev`, `/proc`, `/sys`, `/snap` and
  `/nix`, and their direct children. A recursive `rm` of one used to ask
  (`recursive-rm`); it is now denied, and YOLO mode no longer allows it.
  `"levels": {"rm-root": "ask"}` brings back the dialog in normal mode, for
  every `rm-root` path; YOLO mode still denies them (decision D-2).
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

[Unreleased]: https://github.com/gvanderclay/pi-bouncer/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/gvanderclay/pi-bouncer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gvanderclay/pi-bouncer/releases/tag/v0.1.0
