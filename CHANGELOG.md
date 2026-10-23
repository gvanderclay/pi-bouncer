# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `/bouncer explain` replays a file call: `explain read <path>`,
  `explain write <path>` and `explain grep|find|ls <path>` (a search) print
  every spelling of the path it checked, every path rule that matched in
  order with its level, so a later `allow` shows after the rule it carves out
  of, then what normal mode would do with and without a UI, and what YOLO and
  auto mode would do. It opens no dialog, calls no judge, logs nothing and
  runs nothing, and the session's allows and mode are untouched. Because `read`, `write`, `grep`,
  `find` and `ls` now name a file call, `explain -- <command>` replays a bash
  command that starts with one of those words. The interactive form ranks
  against the config the session started with, as the bash form does, so it
  answers for the running bouncer; the `explain.ts` command-line tool loads
  the files from disk and takes the same forms.

- `/bouncer rules` lists the path groups broad to narrow, each with its
  patterns, the patterns it leaves out, and both its effective read and write
  levels, then the custom path rules. A group set to `off` keeps its place
  and shows both directions off. Before this a group showed one level, the
  stricter of its two directions; its summary and the bash rules around it
  are listed as before.

- In auto mode, a file call a path rule asks about goes to the judge list,
  as bash and MCP asks do: a judge allow runs it with no dialog, a deny blocks
  it with the judge's reason and counts toward the pause, and a hand-off or
  no answer opens the dialog. The judge sees the tool, the direction, the
  real path and, for `write` and `edit`, the change. When the path is in any
  secret group, such as `path-env`, the change is left out and the request
  says it was redacted. A change too large for every judge model opens the
  dialog with `Auto: change too large for the judge (<n> characters)`. Jev is
  not asked about file calls. Before this, a file ask in auto mode opened the
  dialog, or was blocked with no UI.

- Custom path rules: a `rules` entry with `paths` (gitignore-style globs) in
  place of `command` decides Pi's file tools. Its `level` is `"allow"`,
  `"ask"`, `"deny"` or `"off"`, or a `{read, write}` object, and `instead`
  makes it a path steer that denies in every mode with that text. Path rules
  run after the built-in groups (user config, then project, then profile) and
  the last match wins, so `"level": {"write": "deny"}` on `**` followed by an
  `allow` for one folder confines a delegate's writes, and an `allow` for
  `**/.git/hooks/**` lets hooks through `path-git`. `path-bouncer` still
  wins over every rule. An untrusted project may add only `ask` or `deny`
  path rules, and they are raise-only: they can make a path stricter but never
  lower a deny before them. A path rule's name may not start with `path-`,
  which is kept for path groups. A root-anchored path pattern (built-in or custom) whose leading
  folders are a symlink now also matches the real path below it.

- Path groups in `levels` take a level per direction. A plain level sets both,
  as before, and an object sets `read` and/or `write` and leaves the other
  direction at the group's built-in level: `"path-env": {"read": "allow"}`
  allows reading a `.env` and still asks before writing one, and
  `"path-ssh": {"read": "deny", "write": "ask"}` asks for writes while
  denying reads. A group leaves the policy only when both directions are
  `off`. A project file may only raise each direction, and an untrusted one
  may not set `"allow"`; an entry that would leave a direction looser than the
  session's level, including by omitting it, is refused whole, so the group
  keeps its levels. A trusted project may set any level. `path-bouncer` takes
  only a write level, `"ask"` or `"deny"`. Every existing config keeps its
  behaviour: a plain level means both directions.

- `path-bouncer` joins the always-deny set: the `write` and `edit` tools can
  no longer change the bouncer's user config (`<agent dir>/bouncer.json`), a
  project's `.pi/extensions/bouncer/config.json`, the folder the bouncer was
  loaded from, or Pi's `settings.json` (`<agent dir>/settings.json` and any
  `.pi/settings.json`). It is checked before every other path rule, denies in
  YOLO and auto mode without asking a judge, and cannot be `off`; reads stay
  allowed. `"levels": {"path-bouncer": "ask"}` brings back a dialog in normal
  mode. Under `pi -e <checkout>` the checkout is the bouncer's folder, so a
  session running a checkout cannot write its source while at `deny`.

- The `write` and `edit` tools are now gated by the same path rules as `read`.
  A path rule's read level and write level are separate, so a `.env` file is
  denied to read and asked about to write. The dialog shows the rule, the
  path, the real target when a symlink was followed, and a diff: the `-` and
  `+` lines of an `edit`, a line diff for a `write` to an existing file, or
  `new file` and its first lines. "Allow for this session" covers that exact
  real path in that direction only, so allowing `.git/config` does not open
  `.git/hooks`. A diff never reads a path that is not a regular file, or a
  file over 1 MiB; the dialog shows a note there instead, so a write to
  `/dev/zero` or a FIFO cannot hang the bouncer. With no UI the call is
  blocked, as an MCP ask is. YOLO mode lets a path ask or deny through, as it
  does for bash.
- New path groups, each with the one line in `levels` that turns it off:
  `path-keys` (`*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, except `*.pub`):
  reads and writes denied, `"levels": {"path-keys": "off"}`; `path-gnupg`,
  `path-aws`, `path-gcloud`, `path-azure`, `path-kube`, `path-docker` and
  `path-pi-auth` (Pi's `auth.json`): reads and writes denied, each turned off
  by its own name, such as `"levels": {"path-gnupg": "off"}`; `path-env`,
  `path-npmrc`, `path-pypirc`, `path-netrc` and `path-git-credentials`: reads
  denied, writes asked, such as `"levels": {"path-env": "off"}`; and
  `path-git`, `path-shell-rc` and `path-system`: reads allowed, writes asked,
  such as `"levels": {"path-git": "off"}`. The groups run from broad to
  narrow, and the last matching group decides, so a secret group overrides a
  folder group: a key at `/etc/ssl/private/server.pem`, `/usr/local/x.key` or
  `.git/id_rsa` is denied by `path-keys` rather than allowed by `path-system`
  or `path-git`. The home-anchored stores come after `path-keys`, so
  `~/.ssh/id_ed25519` is still decided by `path-ssh` and `.gnupg/**/*.key` by
  `path-gnupg`.
- The `grep`, `find` and `ls` tools are now gated by search scope: a path
  group also fires when an anchored pattern of it lies inside the folder being
  searched, so `path-ssh` denies `grep token ~`, `ls ~/.ssh` and `find /`. A
  search of a folder follows the same groups, directions and `levels` lines as
  a read of it, such as `"levels": {"path-ssh": "off"}`. Patterns that match
  at any depth are tested only against the search path itself, so a `grep`
  with no path in a project that holds a `.env` stays quiet.
- The `read` tool is now gated: `path-ssh` denies reading `~/.ssh`.
  `"levels": {"path-ssh": "off"}` restores the old behaviour. The path is
  checked however it is spelled (`~`, `@`, relative, absolute, `file://`) and
  with symlinks resolved, so a link into `~/.ssh` is caught too. YOLO mode
  lets the read through. A file tool call whose `path` is not a string, or is
  missing from `read`, `write` or `edit`, is blocked. `/bouncer rules`, `/bouncer` status and the session log record list
  `path-ssh`, so the tests pinning those lists changed deliberately.

### Changed

- `path-keys` now covers the key files inside `~/.ssh` too, so turning
  `path-ssh` off no longer unblocks `~/.ssh/id_ed25519`; turn `path-keys` off
  as well. The test that pinned `path-ssh` off restoring the old behaviour for
  that path now uses `~/.ssh/known_hosts`, and a new test pins the
  `path-keys` deny. The tests that count the `/bouncer rules` lines and list
  the built-in levels changed deliberately, because the policy gained
  seventeen entries.

## [0.6.1] - 2026-10-22

### Changed

- The system prompt note on deleting a folder the agent made, without an
  ask, is now three ordered steps. It always uses a full path, asks for
  nothing else in the deleting call, and says to recreate a folder in two
  calls. The no-UI block reason carries the new text, so the test pinning
  it in `src/ask-dialog.test.ts` changed deliberately. The checks
  themselves are unchanged.

## [0.6.0] - 2026-10-19

### Added

- MCP tool calls (`mcp__<server>__<tool>`), direct or from a codemode script,
  are gated. A tool on the new user-config list `mcp.allow` (`*` matches any
  characters) runs; any other MCP call opens the dialog with the tool name
  and its arguments, and Allow for this session covers the tool. With no UI
  it is blocked and YOLO mode allows it. In auto mode the call goes to the
  judge list instead, skipping Jev, and works as a bash ask does: pausing,
  session allows and mode switches included. The tool name, its description
  and its whole arguments are sent to the judge-list providers.
  `"mcp": { "judge": false }` opens the dialog instead. Log records of MCP
  calls carry `tool`, with the arguments as `command`. To keep the old
  behaviour, allow every MCP tool with `"mcp": { "allow": ["mcp__*"] }`. The
  one deliberately changed test is "auto mode asks no judge about an MCP
  call", in `src/mcp-gate.test.ts`, now the `mcp.judge: false` test.
- The session history the judge sees now names each MCP tool called, never
  its arguments or result, and the judge prompt's history sentence says so.
- The auto-judge-list bench has 15 MCP cases, judged with a new MCP prompt by
  `run` and not by `jev`.

### Changed

- In auto mode, a judge-list model whose context window cannot fit the
  request is now skipped without being sent anything, and when no model
  fits, the dialog says the command is too large for the judge instead of
  "no judge available". This applies to bash calls.

## [0.5.0] - 2026-10-19

### Added

- A bash call another tool ran through `ctx.executeTool()` (a codemode
  script, for one) has its log record carry `parentToolCallId`, the id of
  the tool call that ran it. Such calls were already ruled as direct ones;
  tests now pin that.

## [0.4.0] - 2026-10-14

### Added

- A recursive `rm` of a folder the agent made no longer asks when the paths
  are literal relative ones (`scratch`, `./scratch`, `nested/dir`, quoted
  names) on a line that is only the `mkdir` or the `rm`, in the working
  directory the call ran in. A `..` segment, `cd`, assignment, wrapper,
  redirect, pipe, `&`, `!` or second command on the line still asks.
- A line that is only `cp -r`, `-R` or `--recursive` of a real directory into
  a path that was absent counts as making that folder, so a later `rm -rf`
  of it runs. Copying into an existing folder, other `cp` options, chains
  and a failed, detached or masked copy do not count, and files copied with
  old dates still ask.
- The call record of a recursive `rm` the exemption did not cover has an
  `agentMade` list: per `rm` and per path, whether it was eligible and why not
  (`disabled`, `sibling-tool-calls`, `expansion`, `wrapper`,
  `compound-command`, `relative-cwd-ambiguous`, `nonliteral-path`,
  `untracked-or-preexisting`, `older-contents`, `tree-limit`,
  `filesystem-failure`). It is additive: `v` stays 1 and no field changes. The
  `bouncer-debug` skill reads it. The YOLO-mode test pinning a sibling-call
  record was updated to include it.

### Changed

- The `<bouncer>` system prompt section now tells the agent to make a scratch
  folder, use it and delete it in separate calls, with a literal path, and
  mentions relative paths and `cp -r`. The no-UI block reason repeats it, and
  the test pinning that text was updated.
- Relative paths are deliberate here: they used to ask. `"trustAgentMade":
  false` restores ordinary recursive-`rm` handling for every case above.

### Fixed

- The config schema no longer says a project config reads only levels. Its
  description now matches the trust rules: an untrusted project may raise
  levels, add `protect` paths and add ask or deny rules.

## [0.3.1] - 2026-10-03

### Fixed

- An Anthropic judge other than Haiku (such as `anthropic/claude-sonnet-5-5`)
  is now asked for structured output, so its reply is always one verdict
  object. Sonnet
  sometimes wrote its reasoning before the JSON, which failed as
  `no parseable verdict` and moved on to the next model.

## [0.3.0] - 2026-10-03

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

[Unreleased]: https://github.com/gvanderclay/pi-bouncer/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/gvanderclay/pi-bouncer/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/gvanderclay/pi-bouncer/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/gvanderclay/pi-bouncer/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gvanderclay/pi-bouncer/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/gvanderclay/pi-bouncer/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/gvanderclay/pi-bouncer/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/gvanderclay/pi-bouncer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gvanderclay/pi-bouncer/releases/tag/v0.1.0
