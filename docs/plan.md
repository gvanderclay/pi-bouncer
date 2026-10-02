# Plan: make the bouncer ready to publish as `pi-bouncer`

Status: in progress. Written 2026-10-01 by a planning session in the dotfiles
repository and copied here. Decided as recommended: D-2, D-4, D-5, D-6, D-8,
D-9. D-10: keep the short history. D-1 and D-3 were decided together (2026-10-02): the grep steer rule moves
out of the code into a custom rule, so custom rules ship in 0.1.0 with the
steer form. D-7 is done (`github.com/gvanderclay/pi-bouncer`). License: MIT.
Phase 1 and 2.1 are done. Decided 2026-10-02: 2.2 is skipped and 3.7 is
deferred until someone asks; 2.3 and 3.8 are done together as one change (D-9).

Paths starting with `~/workspace/dotfiles/` point into the owner's dotfiles
repository, where the bouncer used to live; they are evidence for the plan and
are not needed to carry it out.

## Where things stand

- The standalone repository is `~/workspace/pi-bouncer`, public at
  `github.com/gvanderclay/pi-bouncer`. When this plan was written it had
  39 commits, from `72c3840` ("rename the permission gate to bouncer") through
  `a4e8f94` ("Stand alone: ignore node_modules and depend on pi-coding-agent
  for tests and types"). The old copy at
  `~/workspace/dotfiles/pi/extensions/bouncer` has since been deleted.
- The owner's daily Pi root (`~/workspace/dotfiles/pi/.pi/agent/settings.json:23`)
  installs the package as `git:github.com/gvanderclay/pi-bouncer`, following
  `main`. Pi runs its own clone under `~/.pi/agent/git/`, so a change takes
  effect there only after a push and `pi update --extensions`. Use
  `pi -e ~/workspace/pi-bouncer` to try unpushed changes.
- Baseline: `node --test test/*.test.ts` in `~/workspace/pi-bouncer` gives
  **1875 tests, 1875 pass** (Node v26.10.0). One of them passes only by
  accident on this machine (see A1 below).
- Pi on this machine is `@earendil-works/pi-coding-agent` 1.0.0 at
  `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`. Its docs
  under `docs/` (packages.md, extensions.md, security.md, models.md) were
  read for this plan.
- Unless a path says otherwise, every `path:line` below is relative to
  `~/workspace/pi-bouncer` as of `a4e8f94`. The source has since moved
  under `src/` (for example `config.ts` is now `src/config.ts`); `test/`,
  `skills/` and the root files stayed where they were.

## Goal and scope

The goal is a package a stranger can install with `pi install npm:pi-bouncer`,
understand from its README and its messages, and configure without reading
the source code. Every existing feature and behaviour stays available. A
default changes only where this plan says so and asks for a decision, and the
old behaviour then stays one config line away.

Out of scope:

- Removing the bouncer from dotfiles and rewiring the Makefile, `AGENTS.md`,
  `docs/architecture/pi-hooks.md` and `CONTEXT.md` there. That follow-up is
  listed at the end so it is not forgotten, but it belongs to a separate
  change in the dotfiles repository.
- New rule families, such as detecting more kinds of dangerous commands.
  This plan only makes the rules that exist configurable and extensible.
- Gating `!` commands, `powershell`, or Pi's built-in `write`/`edit` tools.
  These stay ungated, and the README says so.

---

## 1. Audit: what is geared to one user

Each item is marked by severity: **blocker** means it breaks or misleads a
stranger, **should** means it confuses a stranger, and **cosmetic** means it
is harmless but personal.

### A. Hard-coded paths and environment assumptions

| # | Where | What | Severity |
|---|---|---|---|
| A1 | `test/auto-config.test.ts:146-160` | The test "the daily route's seeded judge list loads with no problems" reads `import.meta.dirname/../../../.pi/agent/bouncer.json`. In dotfiles that is the daily root's file. In `~/workspace/pi-bouncer` it resolves to `~/.pi/agent/bouncer.json`, which exists only because this machine symlinks `~/.pi` to the dotfiles. On CI or any other machine, the test fails with ENOENT. | blocker |
| A2 | `verdict.ts:68` | The parser-unavailable deny tells the model "Tell the user to run `pnpm install` in pi/extensions/bouncer." That is a dotfiles path. An npm install puts the package in `~/.pi/agent/npm/node_modules/pi-bouncer`, and Pi installs its dependencies itself. | blocker (wrong advice) |
| A3 | `skills/bouncer-debug/SKILL.md:304-308`, `skills/auto-judge-list/SKILL.md:91,110,135` | The skills run `node …/explain.ts` and `node …/bench.ts`. Node refuses to strip types under `node_modules` (verified: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and Pi installs npm packages under `~/.pi/agent/npm/node_modules/`. Both helper scripts therefore fail for every npm user. | blocker |
| A4 | `explain.ts:117-131`, `skills/auto-judge-list/bench.ts:432-445` | Both import `@earendil-works/pi-coding-agent` at runtime: explain.ts to read saved trust, and bench.ts to load the model registry. Pi does not install peer dependencies for npm packages (packages.md, "Declare dependencies"), and `~/.pi/agent/npm/node_modules` has no `@earendil-works` folder. explain.ts then fails with "pass --trusted or --untrusted", and `bench.ts run` cannot run at all. The error text even says "link the installed pi package into a node_modules above this script", which is the dotfiles Makefile's trick (`~/workspace/dotfiles/Makefile:268-273`). | blocker for the skills |
| A5 | `mode.ts:17` | `Symbol.for("dotfiles.bouncer.mode")` is the process-wide key for the mode holder. | cosmetic |
| A6 | `rules/filesystem.ts:25-58` | The `rm-root` protected lists are macOS-shaped and personal. System directories include `/Users`, `/System`, `/Library`, `/Applications` and `/private`, but none of Linux's `/home`, `/root`, `/boot`, `/lib`, `/lib64`, `/srv`, `/dev`, `/proc`, `/sys`, `/nix` or `/snap`. Home folders include the personal `workspace`, `pi` and `.pi`, but not common equivalents such as `src`, `code`, `projects`, `dev` or `repos`. On Linux, `rm -rf /home` is only a `recursive-rm` ask, so **YOLO mode allows it** (`rank.ts:145-153` denies only the always-deny set). The list's comment says "the bouncer config cannot extend it" (`rules/filesystem.ts:23-24`). | should (safety gap on Linux) |
| A7 | `rules/filesystem.ts:6`, `rules/filesystem.ts:104-106` | `grm` and `gfind` are Homebrew GNU tool names. They are harmless on Linux and worth keeping. | none |
| A8 | `skills/auto-judge-list/bench.ts:54-55,91-93,122,180`, `skills/auto-judge-list/history-cases.ts:67-70` | Bench cases use `/home/dev/workspace/app`, `${HOME}/workspace/dotfiles` and `gh repo delete dev/dotfiles`. These are synthetic fixtures. The Jev cutoffs were measured on these exact strings (`auto-jev-config.ts:13-21`), so renaming them would invalidate the recorded evidence. | cosmetic; leave them |

### B. Models, providers and the Jev judge

| # | Where | What | Severity |
|---|---|---|---|
| B1 | `jev.ts:27-33` | Jev is TypeSafe's `jev-1.13` classifier, a public paid service. It is reached at the hard-coded OpenCode Zen URL `https://opencode.ai/zen/v1/systemone` with the API key Pi holds for the **`opencode-go`** provider. That is the user's own subscription. Pi 1.0's model docs list Jev under the providers `typesafe` (`TYPESAFE_API_KEY`), `openrouter`, `cloudflare-workers-ai`, `vercel-ai-gateway` and `opencode` (`OPENCODE_API_KEY`), but not `opencode-go` (Pi `docs/models.md:105-113`). Pi also has a native, provider-neutral `ctx.modelRegistry.classify()` that never rejects (Pi `dist/core/model-registry.d.ts:47`; it was added in Pi 0.99.0, CHANGELOG line 131), and its result has the same `answers.<q>.probabilities`/`confidence` shape that `readReply` reads (`jev.ts:166-180`). Jev assumes no private service, but it does assume this user's provider and key. A stranger who writes `"jev": {}` gets "no opencode-go key" forever. | blocker for Jev users |
| B2 | `jev.ts:1-8` | The header points at `pi-jev-device`, a private sibling repository (`~/workspace/pi-jev-device/package.json`: `"private": true`). | cosmetic |
| B3 | `auto-jev-config.ts:13-21` | The default cutoffs cite `~/workspace/dotfiles/.scratch/bouncer-jev-judge/spec.md`, which is not in the new repository. | should (dangling evidence) |
| B4 | `README.md:199-200` | "The daily route's file holds its judge list and asks Sonnet first on `anthropic`." This describes the user's own config. | should |
| B5 | `skills/auto-judge-list/SKILL.md:55` | The research step names "the OpenCode Go and Zen docs" first among its sources. | cosmetic |
| B6 | `test/auto-config.test.ts:41,48,167-174` | Fixtures use `opencode-go/space-bunny-free` and similar names. They are just test data. | none |
| B7 | `judge.ts:198-208` | Refusal detection depends on pi-ai's Anthropic adapter reporting `rawStopReason: "refusal"`. Other providers' refusals become failures. That is the correct fail-safe, but it is undocumented. | should (document it) |

### C. Assumptions about other tools and extensions

| # | Where | What | Severity |
|---|---|---|---|
| C1 | `rules/grep.ts:51-64`, `rules/built-in-policy.ts:48` | The `grep` steer rule blocks every grep in every mode and tells the model to use `rg`. Nothing checks that `rg` is installed. For a stranger without ripgrep, the agent loses its search tool and gets told to run a command that does not exist. It is also a personal preference: the spec's user story says "as the scratch-route user" (`~/workspace/dotfiles/.scratch/bouncer-grep-steer/spec.md:10-14`). The level is fixed and cannot be turned off (`config.ts:119-122`). | blocker (default) |
| C2 | `skills/bouncer-debug/SKILL.md:253-367` | The debug skill needs `jq`, `zcat` and `rg`, and never says what to do when one of them is missing. Under the dotfiles catalog rule 2 (`~/workspace/dotfiles/pi/AGENTS.md`, "Refer to the dependency by what it does…"), it should. | should |
| C3 | `session-launch.ts:10-50` | The bouncer listens for the `session:launch` hook, which only dotfiles' `delegate` emits (`~/workspace/dotfiles/docs/architecture/pi-hooks.md:23`). It is harmless when nothing emits it, but it is undocumented outside dotfiles. | should (document it as an optional integration) |
| C4 | `index.ts:172-174`, `index.ts:413` | Only a tool literally named `bash` is gated. An extension that registers its shell under another name escapes the bouncer. Dotfiles' `pi-bg-bash` keeps the name `bash`, so the bug does not appear there. | should (document it; optional feature F9) |
| C5 | `mode-switch.ts:274-283,475-484` | `/auto`, `/yolo`, `--auto` and `--yolo` are generic names that another permission extension may also register. How Pi handles a duplicate command or flag is unknown (not in the docs read). | should (document it; optional aliases F10) |

### D. Personal defaults

| # | Where | What |
|---|---|---|
| D1 | `rules/built-in-policy.ts:48` | `grep` steer on by default (see C1). |
| D2 | `rules/filesystem.ts:48,51-52` | `~/workspace`, `~/pi` and `~/.pi` are protected by default (see A6). |
| D3 | `jev.ts:32` | Jev's key comes from `opencode-go` (see B1). |
| D4 | `judge.ts:244-245`, `jev.ts:36`, `mode-switch.ts:312-313`, `judge-request.ts:10,13`, `history.ts:10-17`, `facts.ts:23` | Budgets and brakes are constants: 10 s per model, 20 s per line, 5 s for Jev, a pause after 3 denies in a row or 20 per session, 4,000 and 8,000 character budgets, 50 history entries, 10 earlier messages. These are reasonable defaults, but none can be configured. |

### E. Jargon a stranger would not understand

- **"route"** is the dotfiles word for a Pi agent dir or profile
  (`~/workspace/dotfiles/pi/AGENTS.md`). It appears 10 times in README.md and 27 times in
  the two SKILL.md files, and in messages users and the model see:
  - `always-ask.ts:14`: `"<prefix>" is on the route's always-ask list`, in
    the dialog title and the no-UI deny.
  - `mode-switch.ts:146`: "Auto mode stays off: the route's bouncer config
    has no judge list…"
  - `mode-switch.ts:482`: the `/auto` command description, "…from the route's
    judge list…".
  - `project-config.ts:97-100`: "…only the route sets log limits / auto mode
    / the start mode".
- **"daily route"** and **"scratch route"** appear at `index.ts:3`,
  `README.md:199` and `test/auto-config.test.ts:2,146`.
- **Jev**, **SystemOne**, **OpenCode Zen** and **opencode-go** are
  introduced without explanation at `README.md:113-140`.
- **Steer rule**, **always-deny set**, **unreadable-command deny**, **judge
  list**, **session allow**, **hand-off** and **ask** (as a noun) are defined
  only in `~/workspace/dotfiles/CONTEXT.md` ("Pi bouncer" section), which does not move
  with the repository. The README uses them as if the reader knew them.
- `README.md:1-29` explains the rules as one dense paragraph, with no list of
  rule names. Yet rule names are what `levels` takes and what every deny
  message shows (`(rule: git-push-force)`).
- `README.md:30-56` says "install it from `<path to this directory>`", runs
  `pnpm install` first, and only then mentions npm "once it is published".
- `index.ts:1-105` is a 105-line header comment that repeats the README and
  refers to `~/workspace/dotfiles/.scratch/permission-gate/`.

---

## 2. Usability gaps for a new user

Each gap is marked **[feature]** (new behaviour) or **[refactor]** (same
behaviour, better shape or text).

### First run: what a stranger actually gets

- **No config file.** The built-in levels apply, the mode is normal, and asks
  open dialogs. That is good. Nothing tells the user the bouncer is active,
  where its config file goes, or what it catches. The footer is empty in
  normal mode (`mode-switch.ts:98-114`). → F1 `/bouncer` command, F2
  first-run notice.
- **No `rg`.** Every grep is blocked and the model is sent to a missing tool
  (C1). → Decision D-1 and F5 (grep becomes a custom rule).
- **No judge models.** `/auto` refuses with "the route's bouncer config has
  no judge list (auto.models). The auto-judge-list skill can make one."
  (`mode-switch.ts:146`). The dialog hides the Auto choice
  (`index.ts:282-291`). The behaviour is right, but the message uses jargon
  and gives no example config. → R4 wording, F1 `init`, README quickstart.
- **No API key for a listed model.** The entry reports "no configured auth"
  (`judge.ts:194`), which is fine. A Jev key missing for `opencode-go` is
  reported once per session as "no opencode-go key" (`jev.ts:33`), which
  means nothing to a stranger (B1). → F7.
- **No UI** (print, JSON, or RPC without dialogs). Every ask denies. This is
  correct, but only the README's Dialog section mentions it. → README.
- **No parser.** This happens only for local-path installs. The message has
  the wrong path (A2). → R3.

### Discoverability

- The only commands are `/auto [on|off|status]` and `/yolo [on|off]`. No
  command lists the rules, their effective levels, the config files that
  loaded, the log location, or config problems. `/auto status` covers only
  auto mode (`mode-switch.ts:375-412`). → F1 [feature].
- Config problems surface only as a warning at session start
  (`index.ts:220-228`). The user cannot re-check after editing without
  `/reload`. → F1 `status` re-reads and validates without applying
  [feature].

### Configuration: documentation, validation, errors

- There is no reference for every key, its type and its default. Validation
  is thorough (`config.ts`, `auto-jev-config.ts`), but there is no JSON
  Schema for editor completion. A `$schema` key would itself be reported as
  `unknown key "$schema"` (`config.ts:344`). → F3 [feature].
- Messages say "route" (section E). → R4 [refactor; text only].

### Adding your own rules and allow/deny patterns

- Today a user can only change built-in levels (`levels`) and add auto-mode
  prefixes (`auto.alwaysAsk`), and those prefixes **apply only in auto mode**
  (`config.ts:34-35`). The `rules` key is reserved and reports "not
  supported yet" (`config.ts:342-343`). The glossary already defines a
  custom rule as "a program name plus arguments that must all appear in
  order, with a rule level" (`~/workspace/dotfiles/CONTEXT.md`, "Custom rule"). → F5
  [feature].
- No rule except the unreadable denies and the always-deny set can be turned
  off; `levels` accepts only `ask` and `deny` (`config.ts:126`). → F4
  [feature].
- `rm-root` protected paths cannot be extended (A6). → F6 [feature].
- There is no persistent allow. Session allows end at the next session
  start (`ask.ts:156-171`). A per-project persistent allow list is a common
  request, but it would weaken the trust model. This plan does not add one;
  "Turn a rule off" (F4) and trusted project levels cover the need.

### Other things a public package of this kind normally has

- A security disclaimer. Pi's own `docs/security.md` says approval prompts
  are not a security boundary. The README should say plainly that the
  bouncer is a guard rail against accidents and is not a sandbox.
- A privacy note. Auto mode sends commands, the user's messages, the git
  branch and remotes, and the session history to third-party model
  providers (`README.md:88-93`). This must be stated up front.
- Compatibility: which Pi version, which Node, which operating systems
  (macOS and Linux; Windows `powershell` is not gated).
- A SECURITY.md that says how to report a bypass, a CHANGELOG, a LICENSE,
  and CI.

---

## 3. Packaging needs

### LICENSE

MIT, `Copyright (c) 2026 Gage Vander Clay`. Add it to `files`.

### package.json

Current state: `package.json` in `~/workspace/pi-bouncer`. Changes:

- `"license": "MIT"`, `"author"`, and `"repository": {"type": "git", "url":
  "git+https://github.com/<owner>/pi-bouncer.git"}`, plus `homepage` and
  `bugs` (the owner is decision D-7).
- `"description"`: plain words, for example "Guards Pi's bash tool: asks
  before destructive commands, blocks catastrophic ones, with optional
  model-judged auto mode."
- `"keywords"`: keep `pi-package` (it makes the package eligible for the
  pi.dev gallery, per Pi packages.md), and add `pi`, `pi-extension`, `bash`,
  `safety`, `guardrails`, `permissions`.
- `"engines": {"node": ">=22.19.0"}`, which matches Pi 1.0's own engines
  field. Whether the CLIs' `import.meta.main` (`explain.ts:192`,
  `bench.ts:482`) exists on 22.19 is **unknown**; the CI matrix in step 3
  checks it. If it does not, either raise the floor or replace
  `import.meta.main` with a `process.argv[1]` comparison.
- `peerDependencies`: keep `"@earendil-works/pi-coding-agent": "*"`. Pi's
  packages.md says: "Declare the host-provided packages listed above in
  `peerDependencies` with a `"*"` range." A real minimum goes in the README,
  plus a runtime check that degrades with a clear message (step 2.6),
  because a range is not what Pi checks.
- `devDependencies`: `@earendil-works/pi-coding-agent` is already pinned at
  `1.0.0` by `a4e8f94`. This replaces the dotfiles Makefile's
  `PI_PACKAGE_LINKS`. Keep it pinned, and bump it on purpose.
- `files`: `["*.ts", "rules", "scan", "skills", "dist", "schema",
  "README.md", "LICENSE", "CHANGELOG.md"]`. `test/` stays out, as it is
  today. The tarball contents are checked in CI (step 1.3).
- `scripts`: `"lint": "biome ci ."`, `"typecheck": "tsc -p ."`,
  `"test": "node --test test/*.test.ts"`,
  `"check": "pnpm lint && pnpm typecheck && pnpm test"`,
  `"build": …` (step 2.5), and `"prepack": "pnpm build"`.
- `"publishConfig": {"access": "public"}`. `"provenance": true` waits for
  `release.yml`: npm generates provenance only in CI, so it would make the
  hand publish of 0.1.0 (D-8) fail.
- Optional: `pi.image` for the gallery.

### CI (`.github/workflows/ci.yml`)

- Trigger on push and pull_request.
- Node matrix: `22.19.x` (Pi's floor) and `24.x` (current LTS). Add `26.x`
  only if the user wants to keep testing on what they run locally.
- Steps: `pnpm/action-setup`, `pnpm install --frozen-lockfile`,
  `pnpm exec biome ci .`, `pnpm exec tsc -p .`, `node --test test/*.test.ts`
  with `HOME` set to a fresh temporary directory and `PI_CODING_AGENT_DIR`
  and `PI_BOUNCER_LOG_DIR` unset, so a test that leans on the developer's
  home fails in CI.
- A `pack` job: `pnpm pack`, then a check that the tarball has the expected
  file list (`scripts/check-pack.mjs`). Then install the tarball into
  `$(mktemp -d)/node_modules` and run
  `node node_modules/pi-bouncer/dist/explain.js --trusted 'rm -rf /'`,
  expecting `rm-root`. This is the regression test for A3.
- A release workflow (`release.yml`) on `v*` tags runs `pnpm publish
  --provenance` with an `NPM_TOKEN` secret. This depends on decision D-8.

### CHANGELOG.md

Use the Keep a Changelog format. `## [Unreleased]` collects each step below
as it lands. `## [0.1.0]` is the first public release; its "Changed" section
lists every deliberate default change (D-1, D-2 and the wording in R4) and
the one config line that restores the old behaviour.

### README structure (step 4.1)

1. One-paragraph summary, then "This is a guard rail, not a sandbox" with a
   link to Pi's security doc.
2. Install: `pi install npm:pi-bouncer`. Local path and git installs are
   secondary.
3. Quick start: what happens on first run, `/bouncer`, an example dialog,
   and how to turn on auto mode with a two-line config.
4. Modes (normal, auto, YOLO): short, with the table that is there today.
5. Rules: a table of every rule name with its default level, what it
   catches, an example, whether it is in the always-deny set, and whether
   its level can be changed.
6. Configuration: the file locations (user and project), precedence and
   project trust, and every key. Full reference in `docs/configuration.md`;
   JSON Schema in `schema/`.
7. Auto mode: judge list setup, the privacy note on what is sent, costs,
   budgets, pause, and the `auto-judge-list` skill.
8. Jev (optional): what it is, the supported providers, cutoffs.
9. Commands, flags and skills.
10. Log and debugging, with the `bouncer-debug` skill.
11. Integrations: the `session:launch` hook.
12. Compatibility and limitations: Pi version, Node, operating systems, tool
    names gated, `!` commands not gated, refusal detection per provider.
13. Glossary (moved from dotfiles' CONTEXT.md) and License.

The current README's detailed prose (the timing and tie-break rules) moves
into `docs/behaviour.md`, so the README stays readable.

---

## 4. Sequenced plan

Every step leaves the suite green. Run `pnpm check` (or its three commands)
after each step. "Preserved" names the behaviour the step must not change;
"Proof" names the test that shows it. Phases 1 and 2 change no default.
Phase 3 adds features, and each one is off or identical by default unless it
says "decision". All work happens in `~/workspace/pi-bouncer`.

### Phase 1: make the repository stand alone (no behaviour change)

**1.1 Make the suite hermetic.**
- Files: `test/auto-config.test.ts` (lines 146-160), and a new
  `test/fixtures/example-config.json`, which is a copy of today's
  `~/workspace/dotfiles/pi/.pi/agent/bouncer.json` (startMode auto, four models,
  firstByProvider, `"jev": {}`).
- Preserved: the test still proves that a realistic full config loads with
  no problems.
- Proof: `HOME=$(mktemp -d) env -u PI_CODING_AGENT_DIR -u PI_BOUNCER_LOG_DIR
  node --test test/*.test.ts` gives 1875 passing. Run it before the change
  too, to confirm that only this test depends on the home directory. If
  others do, fix them in this same step.

**1.2 LICENSE and package metadata.**
- Files: `LICENSE`, `package.json` (every field in section 3 except
  `build`/`prepack`, which wait for 2.5).
- Preserved: the `pi` manifest (`./index.ts`, `./skills`), dependencies,
  and scripts.test.
- Proof: `pnpm check` passes; `pnpm pack --dry-run` lists LICENSE and no
  `test/` files.

**1.3 CI.**
- Files: `.github/workflows/ci.yml`, `scripts/check-pack.mjs`. The pack
  job's install-and-run check is added in 2.5, once `dist/` exists.
- Proof: a green run on a branch push.

**1.4 CHANGELOG, AGENTS.md, glossary.**
- Files: `CHANGELOG.md`; `AGENTS.md` (how to run checks, the glossary
  pointer, "characterization tests stay authoritative", "never weaken the
  always-deny set"); `docs/glossary.md`, copied from the "Pi bouncer"
  section of `~/workspace/dotfiles/CONTEXT.md` with "route" defined as "Pi agent dir"
  (renaming follows in R4).
- Proof: `pnpm check` (biome ignores Markdown).

**1.5 Move the design evidence the code cites.**
- Files: `docs/design-notes.md`, holding about a page each on the Jev cutoff
  evidence (from `~/workspace/dotfiles/.scratch/bouncer-jev-judge/spec.md`, "## Comments",
  tickets 06 and 10), the project-trust rules (from
  `~/workspace/dotfiles/.scratch/bouncer-project-trust/spec.md`) and the grep steer rationale.
  Update `auto-jev-config.ts:13-21` to cite `docs/design-notes.md`, and
  `jev.ts:1-8` to drop the private `pi-jev-device` path while keeping the
  credit "based on TypeSafe's SystemOne wire format".
- Preserved: all code. Only comments change.
- Proof: `pnpm check`.

**1.6 Neutralize the code comments.**
- Files: `index.ts:1-105`. Cut the header to about 20 lines that point at
  README and docs, and drop "daily route", the `pnpm install` note and the
  `~/workspace/dotfiles/.scratch/permission-gate` line. Replace "route" with "user config" in
  comments throughout.
- Proof: `pnpm check`.

### Phase 2: refactors that protect behaviour and open seams

**2.1 Rename the mode-holder key.**
- Files: `mode.ts:17` changes to `Symbol.for("pi-bouncer.mode")`.
- Preserved: the mode survives `/reload` within one process.
- Proof: the existing reload tests in `test/yolo.test.ts` (for example
  "--yolo applies once: /yolo off then a reload stays off"), plus a new
  one-line test that `processModeHolder()` returns the same object twice.
  The cost is that a process that upgrades mid-flight and then reloads loses
  its mode once. This is acceptable and noted in CHANGELOG.

**2.2 Collect the tunables into one module.** Skipped (2026-10-02): the
limits stay where they are used; revisit together with 3.7.
- Files: a new `limits.ts` that exports `DEFAULT_LIMITS` with `modelMs`,
  `lineMs`, `jevMs`, `pauseInRow`, `pauseTotal`, `earlierChars`,
  `historyChars`, `historyMax` and `gitTimeoutMs`. `judge.ts:244-245`,
  `jev.ts:36`, `mode-switch.ts:312-313`, `judge-request.ts:10,13`,
  `history.ts:10-17` and `facts.ts:23` import from it. Values do not change.
- Preserved: every budget, and every message that prints one ("no reply
  within 10 s", "the line's 20 s ran out").
- Proof: the existing suite unchanged, especially `auto-judge.test.ts`,
  `auto-pause.test.ts`, `auto-jev.test.ts` and `judge-request.test.ts`.

**2.3 Let Jev's call vary.** Done with 3.8.
- Files: `jev.ts`. `jevAsker(registry, model?)` returns how to ask Jev, or
  why it cannot be asked; `ruling.ts` (`callJev`) and the bench use it. The
  5 s budget, abort handling and key redaction are shared by both paths.
- Preserved: the URL, the model, the key provider, "no opencode-go key",
  key redaction in errors, the 5 s budget, and the abort behaviour.
- Proof: `src/auto-jev.test.ts` unchanged and passing.

**2.4 Resolve Pi's package for the CLIs.**
- Files: a new `pi-package.ts` that exports `importPi()`. It tries a bare
  `import("@earendil-works/pi-coding-agent")`, then `$PI_PACKAGE_DIR`, then
  the realpath of `pi` on `PATH`, walking up to the nearest `package.json`
  (the same algorithm as `~/workspace/dotfiles/Makefile:268-273`). `explain.ts:117-131`
  and `skills/auto-judge-list/bench.ts:432-445` use it. The error names all
  three places tried.
- Preserved: explain's `--trusted`/`--untrusted` override and its exit code
  2 on failure; bench's "spends real quota" behaviour.
- Proof: the existing `test/explain.test.ts` and `test/auto-bench.test.ts`;
  plus a new `test/pi-package.test.ts` that points `PI_PACKAGE_DIR` at a
  temporary fake package exporting a stub, and checks the error text when
  nothing resolves.

**2.5 Make the CLIs run from an npm install (fixes A3).**
- Decision D-5.
- Files: `tsconfig.build.json` (extends `tsconfig.json`, `noEmit: false`,
  `outDir: dist`, `rewriteRelativeImportExtensions: true`, excludes `test/`);
  `package.json` `build` and `prepack`; `.gitignore` adds `dist/`;
  `skills/bouncer-debug/SKILL.md:304-308` calls
  `node <skill dir>/../../dist/explain.js`; `skills/auto-judge-list/SKILL.md`
  lines 91, 110 and 135 call `node <skill dir>/../../dist/skills/auto-judge-list/bench.js`.
  For a local-path install from a git checkout, the SKILL.md says to run
  `pnpm build` once, or to run the `.ts` file directly, since that works
  outside `node_modules`.
- First check that TypeScript 7.0.2 emits correctly with
  `rewriteRelativeImportExtensions`. If it does not, fall back to
  `esbuild --bundle --platform=node --format=esm` for the two entry points,
  added as a devDependency.
- Preserved: the extension itself still loads `./index.ts` through Pi's
  jiti, unchanged.
- Proof: the CI pack job from 1.3 gains its install-and-run check (installs
  the tarball under `node_modules` and runs `dist/explain.js`), plus
  `test/explain.test.ts` unchanged.

**2.6 Startup capability check.**
- Files: `index.ts`, `startSession`. If `ctx.isProjectTrusted` or
  `ctx.modelRegistry` is missing, warn once that the installed Pi is older
  than the bouncer supports, and treat the project as untrusted. That is the
  strict side, as today.
- Preserved: everything on Pi 1.0.
- Proof: a new harness test with a context that lacks `isProjectTrusted`
  shows one warning, and the project file may only tighten rules.

**2.7 Correct the parser-unavailable advice (A2).**
- Files: `verdict.ts:64-71`. The message says "the bouncer could not load
  its bash parser (unbash), so every bash command is blocked. Tell the user
  to reinstall the package (`pi install npm:pi-bouncer`), or for a local
  checkout to run `npm install` in <package dir>". The package dir comes
  from `import.meta.dirname`.
- Preserved: the rule name, the deny, and the fail-closed behaviour.
- Proof: `test/fail-closed.test.ts`, with its expected text updated. This
  is a deliberate text change.

**2.8 Replace "route" in user- and model-facing text.**
- Decision D-4.
- Files: `always-ask.ts:14` ("is on your auto.alwaysAsk list");
  `mode-switch.ts:146,155` ("Auto mode stays off: no judge list
  (auto.models) in <path to bouncer.json>. Run /bouncer init or the
  auto-judge-list skill."); `mode-switch.ts:482`; `project-config.ts:97-100`
  ("only the user config (<agent dir>/bouncer.json) sets …"); `jev.ts:33`
  stays until F7.
- Preserved: every decision, level and log field. The log's `type`, `how`
  and other values do not change, so old logs stay readable by the debug
  skill.
- Proof: the existing tests that assert these strings, with expectations
  updated: `test/auto.test.ts:80`, `test/auto-config.test.ts:129,320`, and
  whatever `rg -n "route's|only the route" test` finds. No other expectation
  may change.

### Phase 3: features (old behaviour stays the default unless a decision says otherwise)

**3.1 (F3) Accept `$schema` and ship a JSON Schema.** [feature]
- Files: `config.ts`, `parseKey`, ignores a top-level `$schema` string;
  `schema/bouncer.schema.json` covers every key: levels, log, auto,
  startMode, and later rules, protect and tools.
- Proof: a new `test/schema.test.ts`. Every fixture config, the valid ones
  in `test/config.test.ts` and `test/auto-config.test.ts`, must validate
  against the schema, using a tiny hand-rolled validator or a pinned
  `ajv` devDependency. `$schema` produces no problem. Keeping the schema and
  the validator in step is enforced by this test.

**3.2 (F1) The `/bouncer` command.** [feature]
- Files: a new `commands.ts`. `mode-switch.ts` is 549 physical lines. It
  still passes biome's 500-line cap (`biome.json`,
  `noExcessiveLinesPerFile`), which evidently does not count every line, but
  it has no room to grow, so the command must not go there. `index.ts` registers it.
- Subcommands:
  - `status` (the default): mode, parser loaded, config files with
    loaded/missing/problems, project trust, every rule with its effective
    level, the log path, and a one-line auto summary.
  - `rules`: names, levels and summaries.
  - `explain <command>`: an in-process replay through `explain()`
    (`explain.ts`) under the session's config. It works whether or not the
    `dist/` CLI does.
  - `init`: writes `<agent dir>/bouncer.json` with
    `{"$schema": …, "levels": {}}` only when no file exists, and says where.
  - `check`: re-reads both files and lists problems without applying them.
- Preserved: `/auto` and `/yolo` are untouched.
- Proof: a new `test/bouncer-command.test.ts` through the harness (the
  harness already drives registered commands for `/auto` and `/yolo`).

**3.3 (F2) First-run notice.** [feature]
- Decision D-6.
- Files: `index.ts`, `startSession`. When no user config file exists,
  `ctx.hasUI` is true, and this process has not shown it before (a flag on
  the mode holder), notify once at info level: "Bouncer is on: it asks
  before destructive bash commands. /bouncer shows rules and config."
- Proof: a harness test checks that the notice appears once per process and
  never when the file exists. Existing tests that count notifications must
  either write a config or tolerate the notice. Prefer having the harness
  write `{}` by default, so that no existing assertion changes.

**3.4 (F4) `"off"` as a level.** [feature]
- The grep default is no longer part of this step; D-1 moves grep into a
  custom rule in 3.6.
- Files: `verdict.ts` (`VerdictLevel` gains `"off"`, or a separate
  `ConfigLevel`), `config.ts:113-132` (`validLevels`), `config.ts:380-385`
  (`effectivePolicy` drops entries set to off), `project-config.ts:43-57`
  (refuse a loosening by rank, off < ask < deny; same results for ask and
  deny), `rules/built-in-policy.ts`, and the steer entry's level type
  (`rules/rule.ts:42-48`).
- Rules:
  - A normal rule accepts `ask`, `deny` or `off`.
  - A steer rule accepts `deny` (on) or `off`. After 3.6 no built-in steer
    rule remains, but the type keeps this so custom steer rules can use it.
  - The always-deny set and unreadable denies never accept `off`; trying is
    a problem.
  - An untrusted project may not lower a level. A trusted project may turn a
    rule off, except the always-deny set.
- Preserved: every existing level and every grep behaviour.
- Proof: new cases in `test/config-levels.test.ts` and
  `test/project-trust.test.ts` for `off`.

**3.5 (F6) Extendable protected paths, and Linux defaults.** [feature]
- Decision D-2.
- Files: `rules/filesystem.ts:23-66` takes the lists from `Where` (or the
  policy) instead of module constants; `rules/rule.ts` (`Where` gains
  `protectedHome` and `protectedPaths`); `config.ts` adds
  `"protect": {"home": ["code"], "paths": ["/srv/data"]}`. It is add-only:
  built-ins can never be removed. Both the user file and the project file
  may add, even an untrusted project, because adding is stricter.
- Preserved: every current protected path.
- Proof: `test/rm-root.test.ts` unchanged, plus new cases for configured
  additions, and for Linux defaults if D-2 adds them.

**3.6 (F5) Custom rules, and grep moves into one.** [feature]
- Decisions D-1 and D-3.
- Files: `config.ts` (the `rules` key replaces the "not supported yet" error
  at `config.ts:342-343`), a new `rules/custom.ts`, `verdict.ts`
  (`RuleName` widens to built-in names plus custom names), and
  `rules/built-in-policy.ts` (custom ask/deny entries go after the
  built-ins; custom steer entries go last, where grep sits today).
- Shape, following the glossary: `{"name": "kubectl-delete", "command":
  "kubectl", "args": ["delete"], "level": "ask" | "deny", "summary":
  "deletes cluster resources"}`. `command` is one program name or a list of
  them (`["grep", "egrep", "fgrep"]`), compared by `commandName` so a path
  such as `/usr/bin/grep` matches. `args` must all appear in order. Matching
  uses the same unwrapped argv as `auto.alwaysAsk` (`always-ask.ts:17-29`),
  so wrappers, chains and `git -C` cannot hide a match.
- Matching also covers the commands that `find` (`-exec`, `-execdir`, `-ok`,
  `-okdir`) and `fd` (`-x`, `-X`, `--exec`, `--exec-batch`) run, which the
  scan does not peel. Today only `rules/grep.ts:23-49` does this; its
  `findCommands`/`fdCommands` move into a shared helper (for example in
  `rules/hidden-exec.ts`) that custom rules use for every rule, so
  `find … -exec kubectl delete …` cannot slip past a `kubectl delete` rule.
- Steer form, in 0.1.0: `{"instead": "Use … instead."}`. A steer rule's
  level is `deny` (or `off`, from 3.4); it is denied in every mode, YOLO
  included, by its kind, exactly as the built-in steer is today
  (`rules/built-in-policy.ts:57-61`), and its deny tells the model the
  `instead` text.
- Mode semantics for ask/deny custom rules are exactly those of built-in
  rules: YOLO allows them, because they are not in the always-deny set;
  auto mode sends their asks to the judge.
- grep moves out of the code: delete `rules/grep.ts` and its entry at
  `rules/built-in-policy.ts:48`, so the package ships no grep rule and grep
  runs untouched by default. The owner's
  `~/workspace/dotfiles/pi/.pi/agent/bouncer.json` gains, in the same
  release, a `rules` entry with `"name": "grep"`, `"command": ["grep",
  "egrep", "fgrep"]`, `"level": "deny"`, `"summary": "grep is not allowed
  here"` and today's `grepInstead` text (`rules/grep.ts:62-64`). The same
  rule goes into `examples/` as a "prefer rg" recipe, and the CHANGELOG
  gives it as the way to restore the old behaviour. No `rg`-on-`PATH` check
  is needed: a user who writes the rule chose it.
- Trust: an untrusted project may add only ask/deny rules, never steer
  rules, because steer text is sent to the model, which makes it a
  prompt-injection path. Names must not collide with built-ins.
- Preserved: the built-in policy order, every built-in decision, and every
  grep behaviour once the grep custom rule is configured (deny text, rule
  name `grep` in messages and the log, egrep/fgrep, find and fd slots, YOLO
  and auto mode).
- Proof:
  - A new `test/custom-rules.test.ts` (matching, several names, find and fd
    slots, wrappers, levels, the dialog title, session allows keyed by custom
    rule name, logging, YOLO and auto behaviour, steer form, project trust).
  - The grep-dependent tests (`test/grep.test.ts`, `test/find-fd-rg.test.ts`,
    and the grep cases in `test/yolo.test.ts`, `test/auto*.test.ts` and
    `test/explain.test.ts`) get a harness config holding the grep custom
    rule, from one shared fixture, and otherwise keep their assertions.
  - One new test shows that grep runs untouched with no config.
  - `test/config.test.ts`: the level table at line 21 drops `grep`, and the
    old "not supported yet" assertion goes. No other expectation changes.

**3.7 (F8) Configurable budgets and brakes.** [feature] Deferred
(2026-10-02) until someone asks.
- Files: `config.ts` adds `auto.limits` (`modelMs`, `lineMs`, `jevMs`,
  `pauseInRow`, `pauseTotal`), validated as positive integers within sane
  bounds and user-file only; the modules from 2.2 read limits from the
  config, with `DEFAULT_LIMITS` as the fallback.
- Preserved: the defaults and the message text, which shows the configured
  seconds.
- Proof: the existing auto tests unchanged, plus new tests with small
  limits.

**3.8 (F7) Jev through Pi's classifier registry.** [feature] Done.
- Decision D-9.
- Config: optional `auto.jev.model`, a Pi classifier model as
  `provider/id`. Pi's catalogue serves Jev from TypeSafe
  (`typesafe/jev-latest`), OpenRouter (`openrouter/typesafe/jev-1.13`),
  Cloudflare, Vercel's AI Gateway and pay-as-you-go OpenCode; llama.cpp
  models and extension-registered classifiers work too. A provider Pi does
  not know needs a Pi extension that registers it (Pi's `models.json` cannot
  define classifier models).
- `jev.ts` resolves the model with `getModelOfType("classifier", …)`,
  checks `hasConfiguredAuth`, and calls `classify` with `maxRetries: 0` and
  the bouncer's own signal. Pi's `bool` questions and answers map to and
  from SystemOne's `noul`. The provider's key (when Pi has one) is still
  scrubbed from errors.
- The log, notices and `/auto status` name the model when it is set; with
  no `model` everything is as before (`opencode-go/jev-1.13`).
- Absent `model` keeps the Zen URL with the `opencode-go` key. Pi lists the
  same Zen model as `opencode/jev-1.13`, but resolves its key under
  `opencode`, where the owner has none (checked 2026-10-02: `opencode`
  unconfigured, `opencode-go` stored). Setting `OPENCODE_API_KEY` or storing
  the key for `opencode` would make `"model": "opencode/jev-1.13"` the same
  call through Pi.
- Not built: a custom URL-and-key option inside the bouncer (Pi's
  extension route covers it), and limits for the call (3.7).
- Proof: `src/auto-jev.test.ts` unchanged; `src/jev-pi.test.ts` (allow,
  unsure, error with the key hidden, unknown model, no auth, abort,
  status); config tests for a valid and an invalid `model`. Checked once
  against Pi 1.0's real registry with a stubbed network: both OpenRouter
  and TypeSafe resolve, get the right URL and key, and answer readably.
  The `jev` bench subcommand takes `--model provider/id`.

**3.9 (F9, optional) Gate other shell tools.** [feature]
- Files: `config.ts` adds `tools: ["bash"]` (user file only), and
  `index.ts:172-174,413` checks names against it. The input must have a
  string `command`; anything else is skipped with a once-per-session
  warning.
- Preserved: the default `["bash"]`.
- Proof: a harness test with a tool named `bg_bash`.

**3.10 (F10, optional) `/bouncer auto|yolo` aliases.** [feature]
- Files: `commands.ts` forwards to the existing handlers.
- Proof: a harness test.

### Phase 4: docs, skills, release

**4.1 README rewrite** in the structure from section 3; add
`docs/configuration.md`, `docs/behaviour.md` and `examples/*.json` (minimal,
auto mode with Anthropic, auto mode with OpenRouter, project file).
- Proof: `test/schema.test.ts` validates `examples/*.json`.

**4.2 Skills.**
- Replace "route" with "agent dir" in both SKILL.md files.
- Add fallbacks when `jq`/`zcat`/`rg` are missing: read the JSONL with
  `node -e` or with the read tool.
- Point at the `dist/` CLIs and mention `/bouncer explain`.
- Make the research step's sources provider-neutral
  (`skills/auto-judge-list/SKILL.md:55`).
- Proof: a manual dry read. If the user wants, `make test-pi-skills-live`
  stays in dotfiles.

**4.3 SECURITY.md**: report bypasses privately (GitHub security advisories),
and state what is in scope (a parse or wrapper bypass of a deny) and what
is out of scope (a judge being talked into allowing a command, which is
documented as not a boundary).

**4.4 Release 0.1.0.**
- Finish CHANGELOG.
- Run `pnpm pack`, then install the tarball into a clean agent dir
  (`PI_CODING_AGENT_DIR=$(mktemp -d) pi install ./pi-bouncer-0.1.0.tgz`, if
  Pi accepts tarballs; otherwise `npm:` after publishing to a dist-tag such
  as `next`).
- Start Pi and walk through:
  - a first-run notice, `/bouncer`, and `rm -rf build` asking;
  - `sudo ls` denied;
  - `/auto` refusing with a clear message;
  - `/bouncer init`.
- Then `npm publish`, tag `v0.1.0`, push.

### Dotfiles follow-up (separate change, listed for completeness)

- Switch `pi/.pi/agent/settings.json` from `git:github.com/gvanderclay/pi-bouncer`
  to `npm:pi-bouncer@0.1.0` if the user wants the published build, or keep
  following `main`.
- Add the grep custom rule (step 3.6) to `pi/.pi/agent/bouncer.json` in the
  same release that removes the built-in grep rule.
- Remove `pi/extensions/bouncer/` (done) and the Makefile targets
  `check-pi-bouncer` and `test-pi-bouncer` (`~/workspace/dotfiles/Makefile:249-261`).
  Remove the `pnpm install` exception in `~/workspace/dotfiles/AGENTS.md` and the line
  "Bouncer changes: run make check-pi-bouncer" in `~/workspace/dotfiles/pi/AGENTS.md`.
- Repoint `docs/architecture/pi-hooks.md:23` and `make test-pi-hooks` (which
  runs "the bouncer's session:launch contributor test") at the new repo, or
  keep a copy of that contract test in dotfiles.
- Replace the "Pi bouncer" glossary section in `CONTEXT.md` with a pointer
  to `pi-bouncer/docs/glossary.md`.

---

## 5. Feature preservation checklist

Before release, confirm that each of these still exists, and that the named
tests pass unchanged except where a step above says otherwise:

- [ ] The rule set and levels: `config.test.ts`, `rm-root.test.ts`,
  `recursive-rm.test.ts`, `git*.test.ts`, `publish.test.ts`, `system.test.ts`,
  `remote-script.test.ts`.
- [ ] The scanner (chains, substitutions, wrappers, inline scripts):
  `compound.test.ts`, `substitutions.test.ts`, `wrappers.test.ts`,
  `inline-scripts.test.ts`, `normalize.test.ts`, `parse-errors.test.ts`.
- [ ] The dialog choices and session allows: `ask-*.test.ts`.
- [ ] YOLO mode: `yolo.test.ts`. Auto mode, the judge list, firstByProvider,
  alwaysAsk, pause, history and facts: `auto*.test.ts`.
- [ ] Jev: `auto-jev.test.ts`. Bench: `auto-bench.test.ts`.
- [ ] Project trust and config merge: `project-trust.test.ts`,
  `config-levels.test.ts`.
- [ ] Log and rotation: `log*.test.ts`. Explain: `explain.test.ts`.
- [ ] The `session:launch` hook: `session-launch.test.ts`. Fail closed:
  `fail-closed.test.ts`. Stop reason: `reason.test.ts`.
- [ ] The grep steer, reproduced exactly by the grep custom rule:
  `grep.test.ts`, `find-fd-rg.test.ts`.
- [ ] `startMode`, `--auto`, `--yolo`, `/auto status`, the footer, and both
  skills.

---

## 6. Decisions the user must make

**D-1. The grep steer rule's default.** Decided 2026-10-02.
- Decision: **the package ships no grep rule.** grep becomes a custom steer
  rule (step 3.6) that the owner keeps in their own `bouncer.json`, as
  `rules/grep.ts:4-5` already intended.
- Reason: it encodes one user's tool preference, and it breaks searching
  for anyone without ripgrep (C1). Moving it to config also proves custom
  rules can express a real built-in rule, since the existing grep tests run
  unchanged against the config.
- Alternatives rejected: keep it built in but off by default, turned on with
  `"levels": {"grep": "deny"}` (the original recommendation; leaves a
  personal rule in the package); keep it on and only warn when `rg` is
  missing (a stranger's agent gets refused `grep` for a reason they never
  chose).

**D-2. Linux protected paths and the personal home folders.**
- Recommendation: **add** Linux system directories (`/home`, `/root`,
  `/boot`, `/lib`, `/lib64`, `/srv`, `/dev`, `/proc`, `/sys`, `/snap`,
  `/nix`) to `rm-root`. **Keep** `~/workspace`, `~/pi` and `~/.pi`, because
  protecting more is strictly safer and removing them would change the
  user's behaviour. **Do not** add guesses such as `~/code`; `protect.home`
  covers those.
- This is a deliberate default change: those paths move from ask to deny,
  and YOLO no longer allows them. CHANGELOG notes it.

**D-3. Custom rules in the first release, or later.**
- Decision (2026-10-02): **include them in 0.1.0, with the steer form**,
  because D-1 moves grep into one. The original recommendation deferred the
  steer form to 0.2.0.
- Reason: the `rules` key is already reserved and promised in user-facing
  text, and custom rules are the most-asked feature for this kind of tool.
- Alternative: ship 0.1.0 with only F4 (turning rules off) and F6 (protected
  paths). That is faster, but leaves users unable to guard their own
  commands outside auto mode.

**D-4. Rewording "route" in messages.**
- Recommendation: **yes**, in user-facing and model-facing text and in docs.
  Log field values stay as they are, so existing logs keep working.
- This changes asserted strings in a handful of tests (step 2.8).

**D-5. How the helper CLIs run from npm.**
- Recommendation: **compile to `dist/` at pack time** and point the skills
  at it. `/bouncer explain` comes as well, for humans.
- Alternatives rejected:
  - Shipping only `.ts`. Node will not run it under `node_modules`.
  - Moving the extension itself to compiled JavaScript. That is a bigger
    change to a load path that works today.

**D-6. The first-run notice.**
- Recommendation: **show it once per process, only when no user config
  file exists.** `/bouncer init` writing a file silences it.
- Alternative: never show it. Then discoverability depends on the README.

**D-7. Repository owner and URL**, for `repository`, `homepage` and `bugs`.
- Recommendation: `github.com/gvanderclay/pi-bouncer`. This needs
  confirmation; the git author email is the only identity seen.

**D-8. Publishing.**
- Recommendation: **publish 0.1.0 by hand** with npm two-factor
  authentication, then add the tag-triggered `release.yml` with provenance
  for later versions.

**D-9. Jev's provider.**
- Decision (2026-10-02): **an optional `auto.jev.model` (`provider/id`)
  goes through Pi's classifier registry; without it Jev keeps the Zen URL
  and `opencode-go` key.** See 3.8.
- Reason: no config changes nothing for the owner, whose key Pi holds under
  `opencode-go` while Pi's Zen Jev (`opencode/jev-1.13`) looks under
  `opencode`, and Pi handles every other provider and its credentials.
- Rejected: a bouncer-side table of provider URLs plus a custom URL and
  key variable. It duplicates Pi; decide at 1.0 whether `model` becomes
  required.

**D-10. Git history depth.**
- `~/workspace/pi-bouncer` starts at the rename commit `72c3840`. The
  earlier `pi/extensions/permission-gate/` history (for example `fece4f4`
  and `013bf45`) was not carried over.
- Decision (2026-10-02): **accept the shorter history.** The earlier
  commits stay in the dotfiles repository; `main` is never force-pushed.
- Rejected: re-extract with `git
  filter-repo --path pi/extensions/permission-gate/ --path
  pi/extensions/bouncer/ --path-rename
  pi/extensions/permission-gate/:pi/extensions/bouncer/ …`, then re-apply
  `a4e8f94`. This only works if nothing else has been committed there yet.

## 7. Risks

- **The bouncer gates its own development.** Every command an agent runs
  while doing this plan goes through the bouncer installed from `main`
  (`settings.json:23`). A bug pushed in a half-finished step can deny every
  bash call after `pi update`, and the bouncer fails closed. Keep each step
  small and green, and try unpushed changes with `pi -e ~/workspace/pi-bouncer`.
  If the bouncer breaks, the user can start Pi with `--no-extensions`.
- **Biome limits.** `noExcessiveLinesPerFile` is 500 and
  `noExcessiveLinesPerFunction` is 60 (`biome.json`). `mode-switch.ts` (549 physical lines) and
  `index.ts` (473) are close to the file limit, so new code goes in new modules
  (`commands.ts`, `rules/custom.ts`, `limits.ts`).
- **The test harness counts notifications.** The first-run notice (3.3) and
  the `rg` check (3.4) can change counts in many tests. Mitigate by having
  the harness write a config by default and stub `PATH` lookups behind a
  seam.
- **Pi API drift.** `classify`, `getModelOfType` and `isProjectTrusted`
  exist in Pi 1.0. The peer range stays `"*"` per Pi's guidance, so step 2.6
  is the guard.
- **Jev's cutoffs were measured on the Zen route only.** Another provider's
  `jev-1.13` should behave the same, but that is unverified. The README
  should say so, and the bench's `--model` flag lets a user re-measure.
