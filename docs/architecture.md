# Architecture

How the bouncer is put together, and what to change next. Written at v0.2.0;
the map is updated for the cleanup in `docs/refactor-plan.md` (pull requests
#19 to #24). Findings marked *Done* have landed; the rest are open, each
waiting for the trigger its recommendation names. Words
for the bouncer's behaviour come from `docs/glossary.md`. Words for code
structure come from the `codebase-design` skill:

- A **module** is anything with an interface and an implementation: a
  function, a file or a group of files.
- Its **interface** is everything a caller has to know to use it: arguments,
  ordering, error behaviour, required state.
- A module is **deep** when a lot of behaviour sits behind a small interface,
  and **shallow** when the caller has to know nearly as much as the module
  does.
- A **seam** is the place where behaviour can be swapped without editing the
  code around it. An **adapter** is one thing plugged into a seam. One adapter
  means the seam is only hypothetical; two mean it is real.

## The map

One bash call goes through these stages. Each stage names the files that own
it.

1. **Entry** (`src/index.ts`). Pi loads `bouncer()`. It builds one runtime
   (gate, mode holder, session state, logging), registers `/yolo`, `/auto`,
   `/bouncer` and the `session:launch` listener, and subscribes to four Pi
   events. `session_start` loads the config and resets the session state.
   `tool_call` decides a bash call. `tool_result` records history for the
   judge. `message_end` puts back the reason for a stopped call, which Pi
   would otherwise drop.
2. **Reading the command** (`src/scan/`). `scan(parse, command)` in
   `walk.ts` turns a command string into a flat list of invocations. It looks
   inside `sh -c`/`eval` (`inline-scripts.ts`), wrappers such as `env`,
   `xargs`, `find -exec` and `fd -x` (`wrappers.ts`), and substitutions. The
   parser (unbash) is passed in, so tests and a missing parser both work.
3. **Rules and policy** (`src/rules/`, `src/policy.ts`). A rule is the data
   `{ name, summary, matches(invocation, where) }` (`rules/rule.ts`).
   `rules/built-in-policy.ts` lists every built-in rule in evaluation order,
   with its shipped level, and holds the always-deny set. `rules/custom.ts`
   turns user-written rules into the same shape. `policy.ts` applies the
   configured levels to give the effective policy.
4. **Ranking** (`src/rank.ts`, `src/verdict.ts`, `src/always-ask.ts`).
   `rank`, `rankYolo` and `rankAuto` run each invocation past each policy
   entry and combine the matches: a deny wins, a steer denies the line unless
   a real deny comes later, everything else becomes an ask. The three
   functions differ only in which matches count as a deny. `verdict.ts` builds
   the text the model and the user read.
5. **Deciding** (`src/gate.ts`, `src/ask.ts`). `createGate(parser, policy)`
   returns `decide(command, call)` and `reset(policy)`. `decide` picks the
   ranking for the bouncer mode and then either allows, denies, asks the user
   (`askUser` in `ask.ts`, one dialog per ask, with session allows) or, in
   auto mode, asks the judge. `inspect` gives the same answer without a UI,
   for `/bouncer explain` and the `explain.ts` command-line tool.
6. **Config, project trust and profiles** (`src/config.ts`,
   `src/project-config.ts`, `src/levels.ts`, `src/protect.ts`,
   `src/profiles.ts`, `src/profile-resolve.ts`, `src/agent-env.ts`).
   `loadConfig(agentDir, project, agent)` reads the user config and the
   project file, refuses what an untrusted project may not loosen, builds the
   normal rules, picks the session's profile from its agent name, lays the
   profile on top and returns one `GateConfig`. It never throws: each bad part
   becomes a problem line and falls back to the built-in value.
7. **Modes** (`src/mode.ts`, `src/mode-switch.ts`). The bouncer mode (off,
   auto, YOLO) lives in one object per process, kept on `globalThis` so
   `/reload` keeps it. `mode-switch.ts` turns modes on and off from
   commands, flags, dialog choices and the config's start mode. It also
   pauses auto mode after repeated judge denies.
8. **The judge** (`src/ruling.ts`, `src/judge.ts`, `src/jev.ts`,
   `src/jev-questions.ts`, `src/auto-config.ts`, `src/judge-wiring.ts`,
   `src/judge-request.ts`, `src/history.ts`, `src/facts.ts`).
   `ruleLine(request, auto, provider, run)` asks Jev first when it is
   configured, then the judge list in order (`judgeOrder` in
   `auto-config.ts`), all within one 20-second budget. `judgeFor` in
   `judge-wiring.ts` gathers a call's request and reports judge failures.
   `judge-request.ts` builds what the judge sees, cut to size. `history.ts` keeps the session's bash commands and
   written paths. `facts.ts` reads git state and remotes.
9. **The log** (`src/log.ts`). `appendRecord`, rotation and pruning, and the
   three record types (`SessionRecord`, `CallRecord`, `ModeRecord`) that
   `appendRecord` accepts. `log.ts` builds each record's head (`recordHead`)
   and the call record (`callRecord`). The `bouncer-debug` skill is the only
   reader.
10. **Children** (`src/session-launch.ts`). A synchronous listener on
    pi-squire's `session:launch` event adds `--auto` or `--yolo` to the
    child's arguments and sets `PI_BOUNCER_AGENT` in its environment.
11. **Commands and skills**. `src/commands.ts` is `/bouncer`: status, rules,
    explain, init and check. `skills/bouncer-debug` explains past decisions
    from the log. `skills/auto-judge-list` benchmarks judge models through
    the real `runJudge`, `judgeRequest`, `jevAsker` and `rankAuto`, so the
    benchmark cannot drift from production.

## What is deep, and where the seams are

These parts are in good shape; leave them alone.

- **The rule seam is real and deep.** More than 20 built-in rules and every
  custom rule plug into one three-field shape, and `rank.ts` is the only code
  that walks them. A new rule touches its own file and one line of
  `built-in-policy.ts`.
- **The scan is deep.** `scan(parse, command)` hides wrappers, inline
  scripts, substitutions and depth limits behind one call. The parser is
  passed in, so there are two adapters: unbash and the missing parser that
  denies everything.
- **The gate is deep at its own interface.** `decide` and `reset` are the
  whole surface, and its tests drive it through that surface.
- **`loadConfig` is deep.** One call gives the whole session configuration,
  including trust refusals and the profile, and it reports problems instead
  of throwing. The profile layer (`withProfile`, `chooseProfile`) is pure and
  tested on its own.
- **The judge chain is deep, and its seam is real.** `ruleLine` hides Jev,
  cutoffs, judge order, per-model timeouts and the shared budget. The model
  registry it calls has three adapters: Pi's registry, the empty stand-in in
  `registryOf` (`mode-switch.ts`), and the one the benchmark builds with
  `importPi`.

### Leaky or thin seams

Each finding ends with a recommendation.

1. **`Call` makes the caller know auto mode's internals.** The gate's
   interface is small, but its `Call` argument has ten fields
   (`gate.ts`), including `paused`, `alwaysAsk`, `autoChoice` and a
   `redecide` closure. `index.ts` (`callIn`, `autoChoiceFor`) computes all of
   them, so the rules for when auto mode pauses or offers its dialog choice
   are split between the gate, `index.ts` and `mode-switch.ts`.
   *Recommendation:* when auto mode next changes, give the gate one "auto
   mode" argument (judge, pause state, always-ask list, choice) built in one
   place, rather than spreading the fields across `Call`. Not worth doing on
   its own.

2. **`mode-switch.ts` is a shallow grab bag.** At 473 lines it holds mode
   switching, the status line, `/yolo` and `/auto`, the pause brakes,
   `judgeFor` (which assembles the judge request), failure notices, the log's
   record head and the logging wrapper. `index.ts` imports twelve names from
   it and does the wiring itself, so the file gives little leverage.
   *Recommendation:* split by reason to change: move `judgeFor`,
   `notifyFailures` and `registryOf` into an auto-judge module beside
   `ruling.ts`, and `recordHead`/`createLogging` into `log.ts`. That leaves
   `mode-switch.ts` about modes. Do this before the next auto-mode feature.
   *Done* in #23 and #24: the judge wiring is `src/judge-wiring.ts`.
   `registryOf` stayed in `mode-switch.ts`, so the two files import one way.

3. **`SessionState` is a shared, mutable bag.** `index.ts`, `mode-switch.ts`,
   `commands.ts` and `session-launch.ts` all read it, and `index.ts`
   reassigns `config` and `remotes` on it. Nothing owns its invariants.
   *Recommendation:* leave it until per-session modes (issue #8) force a
   change, then make the session object own the mode as well. That is the
   same change.

4. **The bouncer mode is process-wide (known limit, issue #8).** The mode
   holder is already passed into `bouncer()` as an argument, so the seam
   exists, but it has one adapter, the `globalThis` object. In-process
   children therefore share the parent's mode. Separately, an inherited
   `PI_BOUNCER_AGENT` outranks a launcher's own variable (`AGENT_VARIABLES`
   in `agent-env.ts`). *Recommendation:* keep both as documented limits; when
   #8 is taken up, a per-session holder is the second adapter and should be
   the first step.

5. **Forwarding a child's question to the parent (issue #9) has a seam
   ready.** `askUser` takes an `AskUI` (`select`, `input`) and nothing else
   from Pi. A forwarding adapter that sends the question to the parent
   session and waits for the answer fits there without changing the gate.
   *Recommendation:* build #9 as a second `AskUI` adapter.

6. **The log's record shapes have no type.** `callRecord` and `recordHead`
   build plain objects, and `appendRecord` takes `object`. The bouncer-debug
   skill depends on those field names, but only `ConfigRecord` is typed.
   *Recommendation:* add `CallRecord`, `SessionRecord` and `ModeRecord`
   types in `log.ts` and have `appendRecord` accept only those, so a renamed
   field fails the typecheck instead of breaking the skill silently.
   *Done* in #23.

7. **The profile layer carries the agent twice.** `AgentSource { name,
   variable }` and `ProfileChoice { agent, from }` are the same pair under
   different names, and `agentOf` in `commands.ts` converts back by hand so
   that `/bouncer check` and `explain` can call `loadConfig` again.
   `GateConfig.profiledAgents` exists only for `session-launch.ts`.
   *Recommendation:* make `ProfileChoice` hold an `AgentSource` field. Keep
   `profiledAgents`; it is the cheapest way to answer the launch listener.
   *Done* in #22.

8. **`profiledAgents` calls `chooseProfile` with placeholder arguments**
   (`profile-resolve.ts`). It builds an empty `Normal` and an empty variable
   name, because it only needs to know whether a profile resolves.
   *Recommendation:* split the "which profile name, and is it broken" part
   out of `chooseProfile` into a small function both call. *Done* in #22:
   `resolves` in `profile-resolve.ts`.

## What to cut or simplify (ponytail audit)

Ranked by size of cut. Tags: `shrink` keeps the behaviour in fewer lines,
`delete` removes something unused, `yagni` removes a layer nothing needs.
*Done:* every item in this list landed in #19 to #22.

- `shrink` `isObject` is copied in `levels.ts`, `protect.ts`,
  `rules/custom.ts` and `profiles.ts`, with a variant in `config.ts`.
  Export one from a small `src/json.ts`. [5 files]
- `shrink` `validMode` in `profiles.ts` repeats `validStartMode` in
  `config.ts` apart from the key named in the message. Use one function that
  takes the key. [`profiles.ts`, `config.ts`]
- `shrink` `config.ts` is at 496 lines, against Biome's 500-line cap.
  Move `validAuto`, `validFirstByProvider`, `validList` and `judgeOrder` into
  `auto-jev-config.ts`, renamed `auto-config.ts`, so the next config key does
  not hit the cap. [`config.ts`]
- `shrink` `AgentSource` and `ProfileChoice` both carry the agent and its
  variable; see seam finding 7. Removes `agentOf` from `commands.ts`.
  [`profiles.ts`, `commands.ts`]
- `yagni` `profiledAgents` passes placeholders into `chooseProfile`; see seam
  finding 8. [`profile-resolve.ts`]
- `yagni` `profiles.ts` re-exports `chooseProfile` and `profiledAgents` from
  `profile-resolve.ts`, while `profile-resolve.ts` imports types from
  `profiles.ts`. Have `config.ts` import from `profile-resolve.ts` directly
  and drop the re-export line. [`profiles.ts`]
- `delete` Exports that nothing outside their file uses, not even a test:
  `alwaysAskSummary`, `JEV_ALLOW_AT`, `JEV_DENY_AT`, `NO_PROTECT`,
  `FD_NAMES`, `FD_VALUE_LETTERS`, `FIND_EXEC_ACTIONS`, `jevKey`,
  `judgePrompt`, `lowestReasoning`, `contributeMode`, `contributeAgent`,
  `UnreadableDeny`, `RulingRun`, `GitCommand`. Drop the `export` keyword so
  the interfaces are only what callers use. No lines saved.
- `shrink` Two unrelated types are both called `Read` (`rank.ts` and
  `config.ts`). Rename the one in `config.ts` to `FileRead`. No lines saved.

Kept on purpose, though they look like candidates: `error-text.ts` (three
lines, eight callers), `agent-dir.ts` (copies Pi's logic because the bouncer
must not import Pi at run time), the three `rank*` functions (they share
`rankHits` and differ only in one rule), and the two bench entry points
(`bench.ts:404` already passes its registry loader into `jev-bench.ts`; what
is left repeated is one argument-resolution line each).

net: about -30 lines, -0 dependencies possible. Mostly lean already; the
biggest win is structural (findings 2 and 6 above), not deletion.

## Not verified

No session has yet been seen running a profile end to end. pi-squire's
`session:launch` payload carries `agent`, but that change may not be
released, so a delegate may still run its parent's profile.
