# Plan: clean up the architecture findings

Fixes the findings in `docs/architecture.md`. Seven steps, each its own branch
and pull request, ordered cheapest and safest first, because the bouncer gates
the shell it is developed in: a merged step that breaks a rule breaks every
bash call on `main`.

Status: done. Steps 0 to 6 merged as pull requests #18 to #24 on 2026-10-02.
Step 6 kept `registryOf` in `src/mode-switch.ts`, exported, because either
option in its edit 2 would have made the two files import each other. What is
left is under "Deferred, with their trigger".

Each step is written to be executable on its own by someone who has read
nothing else: it names the files, the symbols, the invariants that must not
move, the test edits it needs and the commands that prove it worked.

## Working rules for whoever executes a step

Read `AGENTS.md` and `docs/glossary.md` first. Then:

- **Environment.** The installed bouncer guards this shell. It denies bash
  containing `grep` (use `rg`), `pi --yolo`, and anything that sets or clears
  `PI_BOUNCER_AGENT`, `PI_SUBAGENT_AGENT` or `PI_DADDY_DEFINITION`. Keep such
  strings inside files you write, never on a bash command line. Do not start a
  `pi` session to check your work: no step here needs one, and the tests are
  the acceptance bar.
- **Repository.** Never commit to `main`. Branch from an up-to-date `main`,
  open the pull request with `gh pr create`, fill in
  `.github/pull_request_template.md`, and merge with
  `gh pr merge --squash --auto`. Use the pull request title given in the step;
  it becomes the commit message.
- **Before every commit.** `pnpm check` (lint, typecheck, tests). After a step
  that adds, removes or renames a top-level path, also
  `node scripts/check-pack.mjs`. None of these steps does, so that check is
  only needed if you deviate.
- **In a fresh checkout or worktree.** `pnpm install` first; each worktree
  needs its own.
- **Scope.** Touch only the files the step names. Before pushing, run
  `git diff origin/main --stat` and confirm every listed file is one the step
  asks for. A delegated edit has previously rewritten unrelated documentation;
  that is a reason to stop and revert, not to push.
- **Changelog.** No step here changes what a user sees, so none adds a
  `CHANGELOG.md` entry and none changes `version`. If you find yourself needing
  either, you have changed behaviour: stop and say so.
- **Tests.** A step's "test edits" list is complete. If a test outside that
  list fails, the step changed behaviour; stop and report rather than editing
  the test. Never weaken the always-deny set (`src/rules/built-in-policy.ts`)
  or the unreadable-command denies.
- **Line numbers** below are as of v0.2.0 (`08b6bb4`) and drift as earlier
  steps land. Locate code by symbol name, not line number.
- **Compiler settings** that shape every edit: `strict`,
  `verbatimModuleSyntax` and `exactOptionalPropertyTypes` are all on
  (`tsconfig.json:3,10,14`). Type-only imports need the `type` keyword, and an
  optional field may not be assigned `undefined`: build records with
  conditional spreads, as `callRecord` in `src/index.ts` already does.

Run the steps in order, one merged pull request at a time. Steps 1, 2 and 3
look independent but all three edit `src/config.ts`, and steps 5 and 6 both
edit `src/mode-switch.ts` and `src/index.ts`, so parallel branches would
conflict at merge for no gain. Step 4 must land before 5 and 6, which touch
the same files.

### Delegating a step

Give a delegate the working rules above plus exactly one step, never two: the
steps are ordered so that each one's diff stays reviewable, and a delegate
that merges two makes both harder to check. Tell it to prefix every bash
command with `cd <checkout> &&` if it runs somewhere else. Wait for one step to
merge before starting the next, and have the next delegate branch from the new
`main`; do not stack branches. When a delegate reports back, check
`git diff origin/main --stat` yourself before merging.

---

## Step 0. Land the overview and this plan

**Goal.** Put `docs/architecture.md` and `docs/refactor-plan.md` in the
repository, and point `AGENTS.md` at them so a later session finds them.

**Branch and pull request title.** `docs-architecture` /
"Add the architecture overview and its cleanup plan".

**Edits.**

1. Add `docs/architecture.md` and `docs/refactor-plan.md` as they are.
2. In `AGENTS.md`, in the opening paragraph that names `docs/glossary.md` and
   `docs/plan.md`, add one sentence: the architecture overview and the cleanup
   plan are `docs/architecture.md` and `docs/refactor-plan.md`.

**Must not change.** No source file, no test, no schema.

**Test edits.** None.

**Verification.** `pnpm check` still passes (it does not lint Markdown, but
run it to confirm nothing else moved). `git diff origin/main --stat` lists
exactly three files.

**Done when.** The pull request is merged and both documents are on `main`.

---

## Step 1. Make each interface only what its callers use

**Goal.** Remove `export` from names nothing outside their own file uses, fix
a duplicated type name, and drop a re-export that makes two modules import
each other.

**Why.** `docs/architecture.md`, audit findings "delete exports", "two
unrelated types are both called `Read`" and "yagni `profiles.ts` re-exports".

**Branch and pull request title.** `shrink-interfaces` /
"Export only what callers use".

**Edits.**

1. Drop the `export` keyword, keeping the declaration and its body untouched,
   on these names. None appears in any other file, including `test/harness.ts`,
   `test/auto-harness.ts`, `test/jev-replies.ts` and any `*.test.ts`; verify
   each with `rg -w <name> . -g '!node_modules' -g '!dist'` before editing, and
   stop if a hit appears outside the file that declares it:
   - `alwaysAskSummary` — `src/always-ask.ts`
   - `JEV_ALLOW_AT`, `JEV_DENY_AT` — `src/auto-jev-config.ts`
   - `NO_PROTECT` — `src/protect.ts` (it stays used inside the file)
   - `FIND_EXEC_ACTIONS`, `FD_NAMES`, `FD_VALUE_LETTERS` —
     `src/rules/hidden-exec.ts`
   - `jevKey` — `src/jev.ts`
   - `judgePrompt`, `lowestReasoning` — `src/judge.ts`
   - `contributeMode`, `contributeAgent` — `src/session-launch.ts`
     (`src/session-launch.test.ts` reaches them through
     `registerSessionLaunch`, so it keeps working)
   - `UnreadableDeny` — `src/rules/rule.ts`
   - `RulingRun` — `src/ruling.ts`
   - `GitCommand` — `src/rules/git.ts`

   Do not go further than this list. In particular, leave `src/gate.ts`'s
   `Trace`, `AutoTrace`, `WithoutYolo`, `Match`, `Decision` and `Call`
   exported even though only `gate.ts` names them today: step 5 types the log
   records with them, and they are part of what a caller of `decide` receives.
2. Rename the file-local `Read` type in `src/config.ts` (the
   `missing | failed | object` union used by `readFile`) to `FileRead`, and
   update its three uses in that file. `src/rank.ts` keeps its own, unrelated
   `Read`.
3. In `src/profiles.ts`, delete the last line,
   `export { chooseProfile, profiledAgents } from "./profile-resolve.ts";`.
   In `src/config.ts`, change the import of `chooseProfile` and
   `profiledAgents` to come from `./profile-resolve.ts`, leaving the rest of
   that import from `./profiles.ts`.
4. In `src/profiles.test.ts`, change the import of `chooseProfile` and
   `profiledAgents` to `./profile-resolve.ts`; the other names in that import
   (`ParsedProfile`, `Profile`, `validAgents`, `validProfiles`, `withProfile`)
   stay from `./profiles.ts`. This is the only test edit in this step, and it
   is an import path, not an assertion.

**Must not change.** No assertion, no message text, no logic, no log field.

**Verification.** `pnpm check`; then
`node --test src/profiles.test.ts src/session-launch.test.ts src/config.test.ts`.

**Done when.** `pnpm check` is green with exactly one test file edited, and
that edit is an import path.

---

## Step 2. One `isObject`, one start-mode validator

**Goal.** Replace five copies of the same type guard with one shared helper,
and replace the two near-identical start-mode validators with one.

**Why.** `docs/architecture.md`, audit findings "`isObject` is copied" and
"`validMode` repeats `validStartMode`".

**Branch and pull request title.** `shared-json-helpers` /
"Share the JSON object guard and the start-mode validator".

**Edits.**

1. New `src/json.ts`:

   ```ts
   export type Json = Readonly<Record<string, unknown>>;

   export function isObject(value: unknown): value is Json {
   	return typeof value === "object" && value !== null && !Array.isArray(value);
   }
   ```

   All five existing copies have this exact body; four annotate the predicate
   as `Readonly<Record<string, unknown>>` and `src/config.ts` names that type
   `Json`. Tabs for indentation, as everywhere in `src/`.
2. Delete the local `isObject` (and, in `src/config.ts`, the local `Json`
   alias) from `src/levels.ts`, `src/protect.ts`, `src/rules/custom.ts`,
   `src/profiles.ts` and `src/config.ts`, and import `{ isObject }` from
   `./json.ts` (from `../json.ts` in `src/rules/custom.ts`). In `config.ts`,
   import the `Json` type too and keep every annotation as it reads today.
   Where a file annotated a variable as
   `Readonly<Record<string, unknown>>`, leave the annotation alone unless
   `tsc` asks for a change: `Json` is that type.
3. In `src/profiles.ts`, change `validMode` into the shared validator and
   export it:

   ```ts
   export function validStartMode(
   	value: unknown,
   	label: string,
   	problems: string[],
   ): StartMode | undefined {
   	if (value === "off" || value === "auto") return value;
   	problems.push(
   		value === "yolo"
   			? `${label}: "yolo" is not allowed: YOLO mode starts only with pi --yolo or /yolo`
   			: `${label} must be "off" or "auto"`,
   	);
   	return undefined;
   }
   ```

   `parseKey` in the same file calls it as `validStartMode(part, "mode", own)`
   and keeps returning `"."` as the separator.
4. In `src/config.ts`, delete the local `validStartMode` and call the imported
   one as `validStartMode(value, '"startMode"', problems)`. The label carries
   its own double quotes because that is how today's message reads.

**Must not change.** The four message texts, which tests pin exactly:
`src/auto.test.ts` (`'"startMode": "yolo" is not allowed: …'` and
`'"startMode" must be "off" or "auto"'`), `src/profiles.test.ts`
(`'profiles.w.mode: "yolo" is not allowed: …'` and
`'profiles.w.mode must be "off" or "auto"'`) and `src/bouncer-command.test.ts`
(`'  - profiles.readonly.mode: "yolo" is not allowed: …'`). The
`profiles.<name>.` prefix and its separator come from `parseProfile` and stay
as they are.

**Test edits.** None.

**Verification.** `pnpm check`; then
`node --test src/profiles.test.ts src/config.test.ts src/auto.test.ts
src/bouncer-command.test.ts src/project-trust.test.ts`.

**Done when.** `rg -c 'function isObject' src` reports one hit, in
`src/json.ts`, and no test changed.

---

## Step 3. Move the auto settings out of `config.ts`

**Goal.** Get `src/config.ts` well under Biome's 500-line cap by moving the
judge-list validation into the auto settings' own module, so the next config
key can be added.

**Why.** `docs/architecture.md`, audit finding "`config.ts` is at Biome's
500-line cap". Verified: `noExcessiveLinesPerFile` (`biome.json:44`,
`maxLines: 500`) counts every line, comments and blanks included — a 600-line
file with 200 lines of code still fails — and `config.ts` is 496 lines, so it
has four lines of headroom.

**Branch and pull request title.** `split-auto-config` /
"Move the auto settings into their own config module".

**Edits.**

1. `git mv src/auto-jev-config.ts src/auto-config.ts` so history follows the
   file. Its existing contents (`JevSettings`, `jevPart`, and the two cutoff
   constants, exported or not depending on whether step 1 has landed) stay as
   they are.
2. Move from `src/config.ts` into `src/auto-config.ts`, bodies unchanged:
   `AutoSettings`, `validAuto`, `validFirstByProvider`, `validList`,
   `isModelEntry`, `isNonEmptyString`, `CHECKED_AFTER` and `judgeOrder`.
   `AutoSettings` keeps re-exporting `JevSettings` through its `jev` field.
3. In `src/config.ts`, keep `GateConfig`, `LogLimits`, `BUILT_IN_LOG_LIMITS`,
   `readFile`, `validLog`, `LOG_CHECKS`, `isLogKey`, `Parsed`, `parseKeys`,
   `parseKey`, `assign`, `parseFile`, `routeConfigFile`, `withAgents`,
   `Project`, `loadConfig`, `normalRules`, `ConfigRecord` and `configRecord`.
   Import `validAuto`, `type AutoSettings` and `type JevSettings` from
   `./auto-config.ts`. `GateConfig.auto` and `ConfigRecord.auto` keep their
   current types. Do not re-export `AutoSettings` or `judgeOrder` from
   `config.ts`: repoint the two files that import them instead.
4. Repoint `src/ruling.ts`, which imports `type AutoSettings` and `judgeOrder`
   from `./config.ts`, at `./auto-config.ts`. Repoint `src/jev.ts`'s import of
   `JevSettings` the same way. Nothing else imports the moved names:
   `src/explain.ts` and `src/commands.ts` take `ConfigFile`, `GateConfig`,
   `Project`, `loadConfig`, `configRecord` and `routeConfigFile` from
   `config.ts`, and all of those stay.
5. Update the citation in `docs/design-notes.md` (the line that says the
   code's summary lives in `src/auto-jev-config.ts`) to the new path.

**Must not change.** Any validation message, any default, the judge order's
behaviour, and `config.ts`'s surface as `loadConfig`'s callers see it.

**Test edits.** One import path: `src/jev-pi.test.ts` imports
`type AutoSettings` from `./config.ts`; point it at `./auto-config.ts`. No
test imports `judgeOrder` or `auto-jev-config.ts` — they reach the config
through `test/harness.ts`. Confirm with
`rg -n 'auto-jev-config|judgeOrder|AutoSettings' src test skills`.

**Verification.** `pnpm check`; then
`node --test src/auto-config.test.ts src/config.test.ts src/auto-judge.test.ts
src/auto-jev.test.ts src/jev-pi.test.ts src/schema.test.ts`; then
`wc -l src/config.ts` and confirm it is comfortably under 500. The existing
`src/auto-config.test.ts` already covers the `auto` settings through
`test/harness.ts`, so the rename gives the module and its test the same name
by coincidence: that test needs no edit and is not a test of the moved code
alone.

**Done when.** `rg -n 'auto-jev-config' .` returns nothing outside this plan
and `docs/architecture.md`, and `pnpm check` is green.

---

## Step 4. One identity for a session's agent

**Goal.** Stop carrying the agent name and its environment variable twice
under two names, delete the by-hand conversion in `src/commands.ts`, and stop
`profiledAgents` from calling `chooseProfile` with placeholder arguments.

**Why.** `docs/architecture.md`, seam findings 7 and 8, and the audit findings
"`AgentSource` and `ProfileChoice` both carry the agent" and "`profiledAgents`
passes placeholders".

**Branch and pull request title.** `agent-identity` /
"Carry a session's agent as one value".

**Edits.**

1. In `src/profiles.ts`, give each `ProfileChoice` variant
   `readonly agent: AgentSource` (import the type from `./agent-env.ts`) in
   place of `readonly agent: string` and `readonly from: string`. `state` and
   `name` stay. The three variants remain `profile`, `unmapped` and `broken`.
2. In `src/profile-resolve.ts`:
   - Split `chooseProfile` so that resolving an agent name to a profile and
     asking whether it resolves share one path. Add
     `export function resolves(agent: AgentSource, user: ProfileFile,
     project: ProfileFile, trusted: boolean): boolean`, which runs the same
     `profileName` lookup and the same broken check `chooseProfile` does and
     returns whether the result would be a `profile` choice. Have
     `chooseProfile` build on the same pieces so the trust rule
     (`profileName`) and the broken check exist once.
   - `chooseProfile` stops destructuring `agent` into `who` and `from` and
     puts the `AgentSource` itself in the choice.
   - `profiledAgents` calls `resolves` and drops the placeholder `Normal` and
     the empty `variable`.
3. In `src/config.ts`, keep the log's shape: add
   `export type ProfileRecord = { readonly state: ProfileChoice["state"];
   readonly agent: string; readonly from: string; readonly name?: string }`
   and a small local function that flattens a `ProfileChoice` into it, in the
   key order `state`, `agent`, `from`, `name`, taking the strings from
   `choice.agent.name` and `choice.agent.variable`. `ConfigRecord.profile`
   becomes `ProfileRecord`, and `configRecord` writes the flattened value.
   `GateConfig.profile` stays a `ProfileChoice`. This is what keeps the
   session record's `config.profile` flat, as it is today.
4. In `src/index.ts`: `callRecord` writes
   `{ agent: profile.agent.name, profile: profile.name }`, and
   `warnAboutConfig`'s broken-profile message reads
   `profile.agent.name`. Both messages keep their current wording.
5. In `src/commands.ts`: delete `agentOf`, and have `explainCommand` and
   `check` pass `parts.session.config?.profile?.agent` straight into
   `loadConfig`, which takes an `AgentSource | undefined`. `profileLine` reads
   `profile.agent.name` and `profile.agent.variable`; its three output strings
   keep their current wording exactly.
6. In `src/session-launch.ts`, `contributeAgent` sets
   `env[key] = config.profile.agent.name`.

**Must not change.**

- The log's fields. Call records keep the flat `agent` and `profile` string
  fields, and session records keep `config.profile` as a flat
  `{state, agent, from, name}` object rather than gaining a nested agent.
  `src/log.test.ts` deep-equals whole records and
  `src/profile-session.test.ts` deep-equals `config.profile`, so both are
  checked by the suite. `skills/bouncer-debug`'s `SKILL.md` reads a call
  record's `agent` and `profile` (its "replay under the profile" recipe passes
  `--agent <agent>`), so those stay strings.
- The wording of `/bouncer status`'s profile line, the broken-profile warning
  and every config problem message.
- The resolution rules in `docs/profiles-spec.md` S2: which profile an agent
  gets, and what an untrusted project may and may not do.

**Test edits.** Only `src/profiles.test.ts`, which asserts `chooseProfile`'s
result directly:

- Its `FROM` constant (`const FROM = { agent: "scout", from:
  "PI_SUBAGENT_AGENT" }`) becomes `const FROM = { agent: SCOUT }`, where
  `SCOUT` is the file's existing `{ name: "scout", variable:
  "PI_SUBAGENT_AGENT" }`. That fixes the six places that spread `FROM`.
- The three assertions that spell the pair out inline (each currently
  `agent: "scout",` followed by `from: "PI_SUBAGENT_AGENT",`) become
  `agent: SCOUT,`.

`src/profile-session.test.ts` asserts the log's `config.profile` and must pass
unchanged: if it fails, the flattening in edit 3 is wrong, not the test.

**Verification.** `pnpm check`; then
`node --test src/profiles.test.ts src/profile-session.test.ts
src/bouncer-command.test.ts src/session-launch.test.ts src/log.test.ts
src/explain.test.ts`; then `rg -n '\bfrom:' src --glob '!*.test.ts'` and
confirm the only hits are unrelated.

**Done when.** `rg -n 'agentOf' src` is empty, `profiledAgents` passes no
placeholders, and `src/profile-session.test.ts` is unedited and green.

---

## Step 5. Type the log records

**Goal.** Give every log record a type, so renaming or dropping a field the
`bouncer-debug` skill reads fails the typecheck instead of breaking the skill
silently.

**Why.** `docs/architecture.md`, seam finding 6.

**Branch and pull request title.** `typed-log-records` /
"Type the bouncer log's records".

**Edits.**

1. In `src/log.ts`, add a shared head type and the three record types, then
   narrow `appendRecord(dir, record)` from `object` to their union:
   - head: `v: 1`, `type`, `time`, `sessionId`, `sessionFile` (string or
     `null`), `cwd`
   - `SessionRecord`: the head plus `reason`, `parser`, `config`
     (`ConfigRecord` from `./config.ts`) and the optional `yolo` and `auto`
     booleans that `src/index.ts` writes today
   - `CallRecord`: the head plus `command`, `ui`, `outcome`
     (`"allowed" | "blocked" | "stopped"`), `matches`, `asks`, the optional
     `reason`, the optional `agent` and `profile` strings, and the optional
     mode fields `yolo`, `withoutYolo`, `auto` and `withoutAuto` whose shapes
     come from `Trace` in `src/gate.ts`
   - `ModeRecord`: the head plus `on: boolean` and `how: How`. `How` lives in
     `src/mode-switch.ts`; import it as a type, or move it here if that reads
     better, and update `mode-switch.ts` to import it back.
   Use the existing types (`Match`, `AskAnswer`, `AutoTrace`, `WithoutYolo`,
   `JudgeSent`, `ConfigRecord`) rather than restating their fields. Optional
   fields must stay optional so the records keep omitting what they omit
   today; `exactOptionalPropertyTypes` is on, so build them with conditional
   spreads the way `callRecord` already does.
2. Move `recordHead` from `src/mode-switch.ts` into `src/log.ts`, returning the
   head type, and move `createLogging` there too. `src/mode-switch.ts` and
   `src/index.ts` import both from `./log.ts`. `createLogging`'s `Logging`
   type moves with it, and `src/index.ts`'s `Runtime.logging` and
   `mode-switch.ts`'s uses keep working through the import.
3. Move `callRecord` from `src/index.ts` into `src/log.ts`, returning
   `CallRecord | undefined`, and have `src/index.ts` call it with the same
   arguments it computes today. `src/index.ts` keeps deciding when to write.

**Must not change.** A single field name, field value or key order in the log.
No test calls `appendRecord`, `rotateIfNeeded`, `pruneByAge`, `recordHead` or
`createLogging` directly — they all go through `test/harness.ts` — so this step
is invisible to the tests if it is correct.

**Test edits.** None.

**Verification.** `pnpm check`; then
`node --test src/log.test.ts src/log-files.test.ts src/profile-session.test.ts
src/yolo.test.ts src/auto.test.ts`. The existing tests already pin the shape:
`src/log.test.ts` deep-equals a whole call record field by field and asserts
that an allowed call's record has no `reason` key at all, so a renamed,
dropped or newly added field fails them. Key order is not pinned and does not
matter: the log is JSON objects and `skills/bouncer-debug` reads fields by
name.

**Done when.** `appendRecord` accepts only the three record types, and no test
changed.

---

## Step 6. Split `mode-switch.ts` by reason to change

**Goal.** `src/mode-switch.ts` (473 lines) mixes mode switching with the
judge's wiring, its failure notices and the status line. Move the judge wiring
out so the file is about modes.

**Why.** `docs/architecture.md`, seam finding 2.

**Branch and pull request title.** `split-mode-switch` /
"Move the judge wiring out of the mode switch".

**Edits.**

1. New `src/judge-wiring.ts` holding, moved unchanged: `judgeFor`,
   `notifyFailures`, `registryOf` and `showJudging`. Do not name it
   `auto-judge.ts`: a `src/auto-judge.test.ts` already exists and covers
   something else.
2. It imports `type SessionState` from `./mode-switch.ts`, so the dependency
   runs one way: `mode-switch.ts` must not import `judge-wiring.ts`.
   `src/index.ts` imports `judgeFor` from `./judge-wiring.ts` instead.
   `registryOf` is used by `autoRefusal` and `autoStatus`, which stay in
   `mode-switch.ts`; export it from `judge-wiring.ts` and import it there, or,
   if you prefer no cross-import, move `autoRefusal` and `autoStatus` into
   `judge-wiring.ts` too and say so in the pull request description. Pick one
   and keep the import direction single.
3. `recordHead` and `createLogging` already moved in step 5; nothing more
   leaves for `log.ts` here.
4. What remains in `src/mode-switch.ts` is modes and their UI: `showMode`,
   `createModeSwitch`, `notifyMode`, `requestedOn`, `applyStartFlags`,
   `registerYolo`, `registerAuto`, `autoCommand`, `turnAutoOn`, `autoStatus`,
   `autoRefusal`, `resetPause`, `trackPause`, `SessionState`, `ModeSwitch`,
   `How`, the pause thresholds and the message constants. Renaming the file to
   `src/modes.ts` is optional; skip the rename if the diff is already large,
   and never combine it with a behaviour change.
5. Update imports in `src/index.ts` (it imports most of the file's exports:
   fourteen names before step 5, fewer after), `src/commands.ts`
   (`type SessionState`) and `src/session-launch.ts` (`type SessionState`).

**Must not change.** Any signature beyond the moves, any message text, the
pause thresholds (`PAUSE_IN_ROW` 3, `PAUSE_TOTAL` 20), the judge request's
contents, or the order in which `judgeFor` shows and restores the status line.

**Test edits.** None: no test imports `src/mode-switch.ts`. Confirm with
`rg -n 'mode-switch' src test skills`.

**Verification.** `pnpm check`; then
`node --test src/yolo.test.ts src/auto.test.ts src/auto-dialog.test.ts
src/auto-pause.test.ts src/auto-judge.test.ts src/auto-history.test.ts
src/auto-facts.test.ts src/bouncer-command.test.ts src/session-launch.test.ts`.

**Done when.** `src/mode-switch.ts` no longer mentions the judge request, and
`pnpm check` is green with no test edited.

---

## Deferred, with their trigger

Not scheduled here; each waits for the change that needs it, and each is its
own plan.

- **Group `Call`'s auto-mode fields** (`src/gate.ts`, `src/index.ts`): do it
  with the next auto-mode feature, when those fields change anyway. On its own
  it moves code without changing what anyone can do.
- **Per-session mode and an owned session object** (issue #8): the first step
  is a second mode holder, one per session, passed where the process-wide one
  is today; `ModeHolder` is already an argument to `bouncer()`, so the seam
  exists and needs its second adapter. It lands with #8, because the fix is
  only visible through in-process children. Take `SessionState`'s ownership
  with it: `src/index.ts` reassigns `config` and `remotes` on a bag four
  modules read.
- **Forward a child's ask to the parent** (issue #9): a second `AskUI` adapter
  in `src/ask.ts`'s terms — `select` and `input` are all the gate uses from
  Pi's UI — sending the question to the parent session and waiting for the
  answer. Its own feature, its own plan.

## Order and size

| Step | Files touched | Test edits | Risk |
| --- | --- | --- | --- |
| 0 | 3 docs | none | none |
| 1 | 12 source files, mechanical | 1 import path | low |
| 2 | 6 source files, 1 new | none | low |
| 3 | 4 source files, 1 renamed, 1 doc | 1 import path | low, biggest diff |
| 4 | 6 source files | `src/profiles.test.ts` only | medium: log fields must not move |
| 5 | 3 source files, 1 new type set | none | medium: same reason |
| 6 | 5 source files, 1 new | none | low, moves only |
