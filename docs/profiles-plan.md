# Plan: per-child profiles

Status: approved, not started. Written 2026-10-02 by a planning session from
`docs/research/child-permissions/decisions.md` (the agreed design, cited
below as "Q<n>") and the research beside it. Every decision there is settled;
this plan only builds it. Where this plan had to choose something the
decisions leave open, the choice is listed under "Decisions taken here" with
its reason. Things only the owner can settle are under "Open questions".

Unless a path says otherwise it is relative to `~/workspace/pi-bouncer` at
`dd15413`. Line counts are from that commit.

## Goal and scope

A Pi session can run under a **profile**: a named group of changes to the
bouncer's rules, picked by the session's **agent name**. A child session
started by a launcher gets the profile its agent maps to; a child with no
profile gets its parent's rules. One new normal rule stops the model from
starting `pi --yolo` or choosing an agent name from bash.

In scope:

- `profiles` and `agents` in the user config and the project file (Q3, Q7,
  Q17), with inherit semantics (Q6) and `levels`, `rules`, `protect` and
  `mode` in a profile (Q2, Q8, Q19).
- Reading the agent name from `PI_BOUNCER_AGENT`, then `PI_SUBAGENT_AGENT`,
  then `PI_DADDY_DEFINITION`, from one list (Q5, Q10, Q15, Q21).
- Passing the agent name, or the parent's own profile, to children through
  `session:launch`, with a small pi-squire change (Q4, Q10, Q18).
- Falling back to the parent's rules on a missing or broken profile (Q13).
- The parent's auto or YOLO mode winning over a profile's mode (Q14).
- The `bouncer-escape` rule (Q9, Q11, Q12).
- The profile in `/bouncer status` and in the bouncer log (Q20).

Out of scope:

- In-process children (nicobailon foreground, tintinweb, gotgenes). The mode
  stays process-wide (`src/mode.ts`); the plan only keeps the profile out of
  the process-wide holder so a per-session profile can come later.
- A "replace" profile that starts from nothing (Q6).
- Forwarding a child's ask to the parent's session (Q16, the next feature).
- The profile in the footer (Q20).
- Catching `pi` started by another name (`node …/cli.js --yolo`, `npx`, a
  shell alias). The rule reads the program name `pi` only.

## Words

New glossary entries, added in PR 4 with the feature:

- **Profile**: a named group of rule changes under `profiles` in the bouncer
  config. It starts from the session's normal rules and changes only what it
  names: rule levels, custom rules, `protect` paths and the start mode.
  _Avoid_: permission set, role, preset.
- **Agent name**: the name a launcher gives the session it starts, read from
  `PI_BOUNCER_AGENT` or a launcher's own variable. The `agents` map turns it
  into a profile. _Avoid_: role, subagent type.
- **Normal rules**: the effective policy the user config and the project file
  give with no profile. (The glossary's "effective policy" then says it
  includes the session's profile.)

## Config shape

Both files accept two new top-level keys.

```json
{
  "profiles": {
    "readonly": {
      "levels": {
        "recursive-rm": "deny",
        "git-push-force": "deny",
        "publish": "deny",
        "gh-delete": "deny"
      },
      "rules": [
        {
          "name": "no-commit",
          "command": "git",
          "args": ["commit"],
          "level": "deny",
          "summary": "a read-only agent does not commit"
        }
      ],
      "mode": "off"
    },
    "worker": {
      "levels": { "recursive-rm": "off", "git-clean": "off" },
      "protect": { "home": ["notes"] },
      "mode": "auto"
    }
  },
  "agents": {
    "scout": "readonly",
    "reviewer": "readonly",
    "orchestrator": "readonly",
    "builder": "worker"
  }
}
```

An untrusted project can only tighten. A project file such as this one
works whether or not the project is trusted:

```json
{
  "profiles": {
    "readonly": { "levels": { "remote-script": "deny" } },
    "lint-only": { "levels": { "recursive-rm": "deny" } }
  },
  "agents": { "linter": "lint-only" }
}
```

The agent is chosen when the session starts:

```bash
PI_BOUNCER_AGENT=orchestrator pi   # a top-level session in the readonly profile (Q21)
```

Validation:

- A profile name matches `^[a-z0-9][a-z0-9-]*$`, like a custom rule's name.
  An agent name is any non-empty string; launchers name agents freely.
- A profile is an object whose keys are `levels`, `rules`, `protect` and
  `mode`. Each is validated exactly as the top-level key of the same name is:
  `validLevels`, `validRules`, `validProtect`. `mode` is `"off"` or
  `"auto"`; `"yolo"` gets the problem `profiles.<name>.mode: "yolo" is not
  allowed: YOLO mode starts only with pi --yolo or /yolo`.
- `agents` maps an agent name to a profile name (a string). An entry naming
  a profile neither file defines is a problem.
- Every problem is reported with its path (`profiles.readonly.levels:
  unknown rule "x"`) in the session-start warning and `/bouncer check`, like
  every other config problem, whether or not this session uses that profile.

## Resolution rules

### The agent name

`src/agent-env.ts` holds the one list, in priority order:

```ts
export const AGENT_VARIABLES = [
	"PI_BOUNCER_AGENT", // set by the bouncer's session:launch listener, or by hand
	"PI_SUBAGENT_AGENT", // HazAT/pi-interactive-subagents
	"PI_DADDY_DEFINITION", // pi-daddy
] as const;
```

`agentFrom(env)` returns `{ name, variable }` for the first variable that is
set and not blank (trimmed), or `undefined`. A later launcher is supported by
adding a line to the list; the `bouncer-escape` rule reads the same list.

### The profile

Given the agent name, the session's profile is found in four steps:

1. **No agent name**: no profile; the normal rules apply. Today's behaviour.
2. **Agent to profile name.** The user config's `agents` entry, overridden
   by the project file's entry for the same agent when the project is
   trusted. An untrusted project's entry is used only when the user config
   has no entry for that agent **and** the user config defines no profile of
   that name, so the profile is wholly the project's and only tightens.
   Otherwise the entry is refused with a problem (`agents: "scout" would
   replace the user config's profile, and the project is not trusted`). No
   entry: **unmapped**, the agent gets its parent's rules (Q4).
3. **Profile name to layer.** Start from the user config's definition, if
   any. Apply the project file's definition of the same name on top, the way
   the project file is applied to the user config today:
   - `levels` override entry by entry, through `projectLevels` with the
     levels in force so far as the base. The always-deny set is never
     loosened by a project; an untrusted project only raises levels.
   - `rules` are added through `projectRules`: a name already used is
     refused, and so is an untrusted project's steer rule.
   - `protect` is added (`mergeProtect`), from any file.
   - `mode` from a trusted project's profile replaces the user's. An
     untrusted project's profile may set only `"off"`, which can only
     tighten; its `"auto"` is refused.
4. **Missing or broken: fallback (Q13).** The profile is **broken** when
   neither file defines it, or when the user config's definition has any
   problem (a bad key, a bad level, `mode: "yolo"`). A broken profile is
   ignored whole: the session gets its parent's rules and the warning names
   the profile. A project definition with a problem is dropped whole with
   that problem, and the user's definition stands, so a project cannot
   switch off a user's profile by writing a broken one. A refusal (step 2 or
   3) is not breakage: the refused entry is dropped and the rest applies,
   which only leaves the profile stricter.

"Parent's rules" in the child means the normal rules: the child cannot see
the parent's profile. A parent that runs a profile passes it on itself
(PR 5), and a parent started with `PI_BOUNCER_AGENT` passes it on to any
launcher that inherits its environment.

### Applying the profile (inherit, Q6)

The session's effective policy is the normal rules with the profile's layer
on top:

- `levels`: `{ ...normal levels, ...profile levels }`. A user-config profile
  may loosen as well as tighten (Q1), with the same limits as the user
  config: the always-deny set can be `ask` but never `off`, and YOLO and
  auto mode deny it whatever the level, so the always-deny set always holds.
- `rules`: a user-config profile rule with the name of a normal custom rule
  replaces it in place (so a profile can turn a custom rule off or change
  its level); any other name is added after the normal custom rules. Steer
  rules still go last (`effectivePolicy`).
- `protect`: the union of the normal additions and the profile's.
- `mode`: replaces `startMode` (below).

### Modes (Q14)

The child learns its parent's mode only from the flag the parent's
`session:launch` listener appends (`--auto` or `--yolo`, `src/session-launch.ts`).
`applyStartFlags` (`src/mode-switch.ts`) already lets a flag win over
`startMode`, so the profile's mode only has to take `startMode`'s place:
`GateConfig.startMode` becomes `profile.mode ?? userConfig.startMode ?? "off"`.
`src/mode-switch.ts` does not change.

| Parent's mode (flag the child gets) | Profile `mode` | Child starts in |
| --- | --- | --- |
| YOLO (`--yolo`) | any | YOLO |
| auto (`--auto`) | any | auto |
| off (no flag) | `"auto"` | auto, when a judge-list entry resolves; otherwise off with today's refusal notice |
| off (no flag) | `"off"` | off, even with `startMode: "auto"` |
| off (no flag) | absent | `startMode`, as today |

A launcher that does not emit `session:launch` passes no flag, so its child
starts in its profile's mode whatever its parent's mode is. That is a
launcher limit, documented, not fixed here.

## Decisions taken here

- **P-1: the profile lives on the session, not the mode holder.** It is
  resolved in `startSession` and kept on `GateConfig` (per extension
  runtime), read from an injectable `env`. Reason: a later per-session
  profile for in-process children only has to change where the agent name
  comes from (a session-id lookup instead of `process.env`). Rejected: a
  field on the process-wide `ModeHolder`, which would have to be undone.
- **P-2: "broken" means any problem in the user's definition.** Reason: a
  "readonly" profile applied with one of its levels silently dropped is
  worse than a loud fallback, and Q13 asks for a fallback. Rejected: today's
  per-part fallback, which would apply half a profile.
- **P-3: an untrusted project may map only an agent the user does not map,
  to a profile the user does not define.** Reason: re-mapping a user's
  agent, or pointing an agent at a user profile that loosens, would loosen
  from an untrusted file. Rejected: ignoring an untrusted project's `agents`
  entirely, which Q7 does not ask for.
- **P-4: a project profile may set `mode` under the trust rules.** The
  owner decided this: a trusted project's profile may set `"off"` or
  `"auto"`; an untrusted project's profile may set only `"off"`, because
  starting in auto mode loosens. This is the one place a project file can
  choose a start mode; top-level `startMode` stays user-config only
  (`ROUTE_ONLY` in `src/project-config.ts`).
- **P-5: profiles start from the normal rules, not from the parent's
  profile.** Q6 says so; noted because a child profile does not stack on a
  parent profile.
- **P-6: the rule is named `bouncer-escape`, sits last in the built-in
  policy, and ships at `deny`.** Last, so no existing ranking or reason
  changes. The name is the owner's to change in review.
- **P-7: one PR moves level validation out of `src/config.ts` first.** The
  profile parser needs `validLevels`, `src/config.ts` would import the
  profile module, and a profile module importing `src/config.ts` would be a
  cycle; the move also frees about 35 lines below the 500-line cap.

## The pull requests

Each one is green on `pnpm check` alone and leaves `main` safe. Try each with
`pi -e ~/workspace/pi-bouncer` before pushing: the bouncer gates the shell it
is built in. Biome's limits apply to new code too: 500 lines per file, 60 per
function, cognitive complexity 15.

Order: PR 1 → PR 2 → PR 3 → PR 4 → PR 5 → PR 6. The pi-squire PR (S) is
independent and can merge at any time; PR 5's agent-to-profile path only
takes effect once both are released.

Nothing a user can reach is half-built at any point: PR 1 and PR 3 change no
behaviour, PR 2 is complete on its own, and `profiles`/`agents` stay
"unknown key" problems until PR 4 makes them work end to end.

### PR 1: move level validation into `src/levels.ts` (no behaviour change)

- New `src/levels.ts`: `allowedLevels` and `validLevels`, moved verbatim
  from `src/config.ts` (lines 100–134), with `validLevels` exported. It
  imports `alwaysDenySet`/`builtInEntries` and the `Levels` type as
  `src/config.ts` does now.
- `src/config.ts` imports `validLevels` from it.
- Preserved: every problem text and every level a config may set.
- Proof: `pnpm check`, unchanged suite. No CHANGELOG entry (not
  user-visible).

### PR 2: the `bouncer-escape` rule

The scanner does not keep `NAME=value` prefixes today: `visitCommand`
(`src/scan/walk.ts:242`) walks them for substitutions but drops their names,
and a bare assignment `PI_BOUNCER_AGENT=x` becomes an invocation with an
empty name. The rule needs them, because an already-exported variable is
changed by a bare assignment, and `PI_BOUNCER_AGENT=x pi` is the commonest
form.

- `src/scan/walk.ts`: `Invocation` gains
  `readonly assignments: readonly string[]`, the names its command's own
  prefix sets: `command.prefix.flatMap((a) => (a.name ? [a.name] : []))`.
  Peeled invocations already spread their parent (`peelCommand`, `unwrap`),
  so `FOO=1 nohup pi` gives `pi` the name too. Invocations are built only in
  `src/scan/walk.ts`, so no test literal changes.
- New `src/agent-env.ts`: `AGENT_VARIABLES` (above). `agentFrom` follows in
  PR 3.
- New `src/rules/bouncer-escape.ts`, exporting `bouncerEscape: Rule`,
  summary "starting pi with --yolo, or choosing a bouncer profile, from bash
  sidesteps the user's rules". It matches an invocation when:
  - its name is `pi` and an option argument (before `--`, `optionArgs` in
    `src/rules/argv.ts`) is `--yolo` or starts with `--yolo=`; or
  - `assignments` holds a name in `AGENT_VARIABLES` (prefix or bare
    assignment, including inside `sh -c`, `$(…)` and wrappers); or
  - its name is `env` and an argument starts with `<VAR>=`; or
  - its name is `export`, `declare`, `typeset`, `readonly` or `local` and an
    argument is `<VAR>` or starts with `<VAR>=`; or
  - it clears a variable a profile depends on: `unset <VAR>`, `env -u <VAR>`
    (or `--unset=<VAR>`), or `env -i` / `env -` running `pi`. These close
    the way a profiled session could start a child under looser normal
    rules (owner's yes, open question 2).
- `src/rules/built-in-policy.ts`: `{ kind: "rule", rule: bouncerEscape,
  level: "deny" }` after `gh-delete`. Not in `alwaysDenySet`; `allowedLevels`
  therefore accepts `ask`, `deny` and `off`, and an untrusted project cannot
  lower it (`refusal` in `src/project-config.ts`). YOLO allows it like any
  rule-level deny (`rankYolo`); auto mode denies it without a judge call
  (`rankAuto`).
- `schema/bouncer.schema.json`: a `levels` property for it (`ask`, `deny`,
  `off`), and its name in the custom-rule `name` `not.enum`.
- `README.md`: a row in the rules table (`bouncer-escape` | deny |
  `pi --yolo`, or setting an agent variable).
- CHANGELOG `[Unreleased]` / Added: "The `bouncer-escape` rule denies bash
  that starts `pi --yolo` or sets or clears `PI_BOUNCER_AGENT`, `PI_SUBAGENT_AGENT` or
  `PI_DADDY_DEFINITION`. Starting `pi` otherwise is still allowed. `"levels":
  {"bouncer-escape": "ask"}` asks instead, and `"off"` restores the old
  behaviour." (A new deny is a changed default for anyone who ran
  `pi --yolo` from bash; the entry names the one line that undoes it.)
- Tests:
  - New `src/rules/bouncer-escape.test.ts` with `expectDeny`/`expectAllow`
    rows. Denied: `pi --yolo`, `pi -p hi --yolo`, `/opt/homebrew/bin/pi
    --yolo`, `nohup pi --yolo &`, `sh -c 'pi --yolo'`, `PI_BOUNCER_AGENT=w
    pi`, `PI_SUBAGENT_AGENT=w pi -p hi`, `PI_DADDY_DEFINITION=w pi`, `env
    PI_BOUNCER_AGENT=w pi`, `env -i PI_BOUNCER_AGENT=w pi`, `export
    PI_BOUNCER_AGENT=w`, `declare -x PI_SUBAGENT_AGENT=w`, `unset PI_BOUNCER_AGENT; pi`,
    `env -u PI_SUBAGENT_AGENT pi`, `env -i pi`, a bare
    `PI_BOUNCER_AGENT=w`, `export PI_BOUNCER_AGENT`, `cd x && PI_BOUNCER_AGENT=w
    pi`, `echo "$(PI_BOUNCER_AGENT=w pi -p hi)"`. Allowed: `pi`, `pi -p
    "try pi --yolo"`, `pi -- --yolo`, `pi --auto`, `echo
    PI_BOUNCER_AGENT=w`, `echo "$PI_BOUNCER_AGENT"`, `printenv
    PI_BOUNCER_AGENT`, `rg PI_BOUNCER_AGENT src`, `git commit -m "pi
    --yolo"`, `PI_OTHER=1 pi`, `unset FOO`, `env -i ls`.
  - `src/scan/` (a new `assignments.test.ts`): prefix names, bare
    assignment, none for `echo a=b`, names carried through `nohup` and
    `env -S`, and inside `sh -c`.
  - `src/rules/levels.test.ts`: a `denies` row `["bouncer-escape", "pi
    --yolo", "pi --yolo"]`.
  - `src/yolo.test.ts`: YOLO mode allows `pi --yolo`. `src/auto.test.ts`:
    auto mode denies it with no judge call.
  - `src/config-levels.test.ts`: the user config sets it `off` and `pi
    --yolo` runs; an untrusted project's `off` is refused.
  - Tables that list every rule gain the row: `src/config.test.ts:42`,
    `src/log.test.ts:385` (`config.levels`), and the `/bouncer status` and
    `/bouncer rules` expectations in `src/bouncer-command.test.ts`.
- Risk check before merging: run `pi -e .` and a few ordinary commands
  (`ls`, `pnpm check`, `git status`) to see nothing else is denied.

### PR 3: the profile module, not yet wired in (no behaviour change)

Pure functions with their own tests; nothing imports them yet, so no user
can reach them.

- `src/agent-env.ts`: `agentFrom(env: Readonly<Record<string, string |
  undefined>>): AgentSource | undefined`, with `AgentSource = { name: string;
  variable: string }`.
- New `src/profiles.ts` (aim for under 300 lines; split resolution into
  `src/profile-resolve.ts` if it grows past that):
  - Types: `Profile = { levels: Levels; rules: readonly CustomRule[];
    protect?: Protect; mode?: StartMode }`; a parsed definition is
    `{ kind: "ok"; profile }` or `{ kind: "broken"; problems }`.
  - `validProfiles(value, problems)` and `validAgents(value, problems)`, the
    parsers. Each profile is checked with its own problem list, prefixed
    `profiles.<name>.`; any problem makes it `broken`, and the problems are
    copied to the file's list.
  - `chooseProfile(agent, user, project, trusted, normal)`: steps 1–4 of
    "Resolution rules", returning the layer to apply and a
    `ProfileChoice`:
    ```ts
    type ProfileChoice =
    	| { readonly state: "profile"; readonly agent: string; readonly from: string; readonly name: string }
    	| { readonly state: "unmapped"; readonly agent: string; readonly from: string }
    	| { readonly state: "broken"; readonly agent: string; readonly from: string; readonly name: string };
    ```
    plus the refusal problems for the project file.
  - `withProfile(normal, layer)`: the merge in "Applying the profile":
    levels, rules (replace by name, else append), protect, mode.
  - `profiledAgents(user, project, trusted)`: every agent name whose profile
    resolves to `state: "profile"`, for PR 5.
- Tests, new `src/profiles.test.ts`, table-driven:
  - `agentFrom`: priority order; a blank value skipped; none set.
  - Parsing: a valid profile; an unknown key, a bad level, `mode: "yolo"`,
    a non-object profile and a bad profile name each make it broken with the
    named problem; an `agents` value that is not a string; an `agents` entry
    naming an undefined profile.
  - Resolution: unmapped; mapped; missing profile is broken; a broken user
    definition is broken; a broken project definition is dropped and the
    user's stands; a trusted project's `agents` entry overrides the user's;
    an untrusted project's entry is refused when the user maps the agent or
    defines the profile, and kept otherwise; an untrusted project profile
    raising a level applies and lowering one is refused; any project profile
    lowering an always-deny rule is refused; an untrusted project profile's
    steer rule is refused; a trusted project profile's `mode: "auto"`
    applies; an untrusted one's `"auto"` is refused and its `"off"` applies.
  - Merge: profile levels win over normal levels; `rm-root: "ask"` from a
    user profile applies; a user profile rule replaces a normal custom rule
    of the same name; `protect` is the union; `mode` absent leaves
    `startMode`.
- No CHANGELOG entry (not user-visible).

### PR 4: profiles take effect (config, start mode, status, log, docs)

- `src/config.ts`:
  - `Parsed` gains `profiles?` and `agents?`; `parseKey` gains the two keys
    (`validProfiles`, `validAgents`).
  - `loadConfig(agentDir, project, agent?: AgentSource)`. After the normal
    levels, custom rules and protect are computed, it calls
    `chooseProfile` and `withProfile`, then `effectivePolicy` on the result.
    Extract the normal-rules part into a helper so `loadConfig` stays under
    60 lines.
  - `GateConfig` gains `profile?: ProfileChoice` (absent when no agent
    name) and `profiledAgents: ReadonlySet<string>`; `startMode` comes from
    the profile when it sets one.
  - `configRecord` adds `profile` when present.
  - Budget: PR 1 freed about 35 lines; this adds about 25.
- `src/index.ts`:
  - `bouncer(pi, loadParser, logDir, agentDir, holder, env = process.env)`;
    `Runtime` keeps `env`.
  - `startSession` passes `agentFrom(rt.env)` to `loadConfig`.
  - `warnAboutConfig` already lists profile problems. A broken profile adds
    one line to that warning: `profile "readonly" for agent scout is broken,
    so this session uses the normal rules`.
  - `callRecord` adds `agent` and `profile` when `config.profile.state` is
    `"profile"` (Q20: on every decision record of a profiled session).
- `src/commands.ts`:
  - `status` adds a line after `Bouncer mode:`:
    - `Profile: none` (no agent name);
    - `Profile: readonly (agent scout, from PI_SUBAGENT_AGENT)`;
    - `Profile: none; agent scout (from PI_SUBAGENT_AGENT) has no profile`;
    - `Profile: none; "readonly" for agent scout is broken, so the normal rules apply`.
  - `check` and `explainCommand` pass the session's agent
    (`config.profile`'s `agent`/`from`) to `loadConfig`, so they show the
    same profile the session runs.
- `test/harness.ts`: `GateOptions.env`, passed to `bouncer`; default `{}`,
  so no existing test sees the developer's own variables.
- `schema/bouncer.schema.json`: move the `levels`, `rules` and `protect`
  schemas to `definitions` and `$ref` them from the top level and from a new
  `profiles` (`additionalProperties` of an object with those three plus
  `mode: enum ["off", "auto"]`, `propertyNames` with the name pattern) and
  `agents` (`additionalProperties: { type: string }`).
- Docs: `docs/configuration.md` gains `## profiles` and `## agents` (the
  examples above, the resolution steps in prose, the trust rules), and the
  "Files and precedence" bullets gain the project-profile limits;
  `startMode` says a profile's `mode` replaces it. `docs/behaviour.md`
  `## Modes` gains the mode table; `## The log` names the new fields.
  `docs/glossary.md` gains the three entries. `README.md` gains a short
  "Profiles" paragraph under Configuration. `examples/profiles.json` holds
  the user-config example (the schema test loads every example).
- CHANGELOG / Added: "Profiles: `profiles` names groups of rule changes
  (`levels`, `rules`, `protect`, `mode`), and `agents` maps an agent name to
  one. A session's agent name comes from `PI_BOUNCER_AGENT`, then
  `PI_SUBAGENT_AGENT`, then `PI_DADDY_DEFINITION`. A profile starts from the
  normal rules and may loosen or tighten; the always-deny set still holds,
  and an untrusted project's profiles only tighten. A missing or broken
  profile falls back to the normal rules with a warning. A profile's `mode`
  applies only when no `--auto` or `--yolo` is given. `/bouncer status`
  shows the profile, and the log records it."
- Tests (new `src/profile-session.test.ts`, through `loadGateSession` with
  `env`):
  - `PI_SUBAGENT_AGENT=scout` with `scout → readonly` (recursive-rm deny):
    `rm -rf build` is denied with no dialog; with no env it asks.
  - `PI_BOUNCER_AGENT` wins over `PI_SUBAGENT_AGENT`.
  - A loosening `worker` profile turns `recursive-rm` off and `rm -rf
    build` runs; `rm -rf ~` is still denied.
  - Unmapped agent: normal rules, status says so.
  - Broken profile: normal rules, one warning naming it, status says so.
  - Untrusted project profile adding a deny applies; lowering a level is
    refused and reported.
  - Modes: profile `mode: "auto"` with a judge list starts auto with no
    flag; `--yolo` with profile `mode: "off"` starts YOLO; `--auto` with
    profile `mode: "off"` starts auto; profile `mode: "off"` with
    `startMode: "auto"` starts off; profile `mode: "auto"` with no judge
    list stays off with the refusal notice.
  - Log: the session record's `config.profile`; each call record carries
    `agent` and `profile`; a session with no agent name has neither.
  - `src/bouncer-command.test.ts`: the four `Profile:` lines; `/bouncer
    check` reports a profile problem.
  - `src/schema.test.ts`: `VALID` gains both examples above; `INVALID`
    gains `mode: "yolo"` in a profile, a non-string `agents` value and an
    unknown key inside a profile. The existing test that the schema and the
    validator agree covers the rest.
- Verify by hand: `PI_BOUNCER_AGENT=orchestrator pi -e .` with the example
  config; `/bouncer status`; `rm -rf build` is denied; the log line has
  `"profile":"readonly"`.

### PR S (pi-squire): put the agent name on `session:launch`

In `~/workspace/pi-squire`, its own pull request, under that repo's
`AGENTS.md` (the README example is the hook contract).

- `index.ts`: `type LaunchPayload = { args: string[]; env: Record<string,
  string>; agent: string }`, and in `launch` (`index.ts:416`)
  `const payload: LaunchPayload = { args: argv, env, agent: start.agent.name }`.
- `README.md` `### session:launch`: a table row `agent` — "the agent's
  name, as in `<agent dir>/agents/<name>/AGENT.md`; read it, do not change
  it". Leave the `js session:launch` example as is.
- `SECURITY.md` "What reaches the delegate": a listener also sees the agent
  name.
- `test/hooks.test.ts`: the payload a listener sees has `agent: "scout"`.
- pi-squire `CHANGELOG.md` / Added: "`session:launch` payloads carry the
  agent's name as `agent`."

The bouncer reads `agent` only when it is a string, so either side may land
first.

### PR 5: pass the profile to children through `session:launch`

- `src/session-launch.ts`: `LaunchPayload` gains `agent?: unknown`;
  `registerSessionLaunch(pi, holder, session)` (from `src/index.ts`); the
  listener does today's flag append, then `contributeAgent(config, payload)`:
  - skip unless `payload.env` is an object without a `PI_BOUNCER_AGENT` key
    (listeners only add);
  - if `payload.agent` is a string in `config.profiledAgents`, set
    `env.PI_BOUNCER_AGENT = payload.agent` (the child's own profile);
  - else if the parent's `config.profile.state` is `"profile"`, set
    `env.PI_BOUNCER_AGENT` to the parent's agent name (Q18, and the
    fallback of Q4 and Q13: an unmapped or broken child gets the parent's
    rules);
  - else add nothing (the child runs the normal rules, as the parent does).
  Still synchronous, still never throws.
- `README.md` "Integrations": the listener also sets `PI_BOUNCER_AGENT`
  from the payload's `agent`, or passes the parent's profile on.
- CHANGELOG / Added: "A child started through `session:launch` gets its
  agent's profile, or its parent's profile when its agent has none."
- Tests, `src/session-launch.test.ts`: agent with a profile → its name;
  unmapped agent, parent in a profile → the parent's agent name; broken
  profile, parent in a profile → the parent's; unmapped, parent with no
  profile → no key; an existing `PI_BOUNCER_AGENT` in `env` is kept;
  a non-string `agent` is ignored; the existing four tests unchanged.

### PR 6: replay a profiled call in `bouncer-debug`

- `src/explain.ts` (the skill's script): an optional `--agent <name>` passes
  `{ name, variable: "--agent" }` to `loadConfig`, so a replay uses the
  profile the logged call ran under.
- `skills/bouncer-debug/SKILL.md`: when a call record has `agent`, pass
  `--agent` to the replay; mention the `profile` field when reading records.
- CHANGELOG / Added: "`bouncer-debug` replays a call under the profile it
  ran in."
- Tests: `src/explain.test.ts`, one replay with `--agent` that differs from
  the one without.

## Risks

- **A broken rule denies every bash call.** PR 2 touches the scanner and
  adds a rule on every line. Keep the scanner change additive (one field,
  no new branch on existing paths) and try `pi -e .` before pushing; a user
  stuck behind a bad rule can start Pi with `--no-extensions`.
- **False positives of `bouncer-escape`.** `env cmd PI_BOUNCER_AGENT=x`
  (a word after the command) also matches; the rule does not split `env`'s
  own operands from the command's. Rare, and the deny names the line to turn
  it to `ask` or `off`.
- **A child's status names its parent's agent** when the parent passed its
  own profile on (PR 5): `Profile: readonly (agent orchestrator, …)` in a
  `scout` child. Acceptable for a first version; a later
  `PI_BOUNCER_PROFILE` could fix it.
- **The parent and child read the config at different times.** PR 5 decides
  in the parent which profile the child gets; if the file changes between
  the two reads, the child applies its own reading, and a now-broken profile
  falls back to the normal rules with a warning.
- **Line caps.** `src/config.ts` after PR 4 should stay near 445 lines;
  `src/mode-switch.ts` is not touched.
- **Fail-safe direction.** A user profile that loosens is honoured only
  from the user config or a trusted project, so the worst an untrusted
  project can do is make a session stricter.

## Owner's answers to the open questions

1. **An inherited `PI_BOUNCER_AGENT` shadows a launcher's own variable.**
   When a parent was started with `PI_BOUNCER_AGENT=orchestrator`, a
   launcher that copies the parent's environment (pi-daddy, HazAT) starts
   every child with that value, and since `PI_BOUNCER_AGENT` comes first, a
   child HazAT marks `PI_SUBAGENT_AGENT=scout` runs the orchestrator's
   profile. Accepted for now and documented in `docs/configuration.md`
   (PR 4); fix it in a later "subagent library compatibility" pass.
2. **Clearing the variable.** Yes: `bouncer-escape` also covers `unset
   <VAR>`, `env -u <VAR>` and `env -i … pi` (PR 2).
3. **Project-profile `mode`.** Allowed under the trust rules: a trusted
   project's profile may set `"off"` or `"auto"`, an untrusted one only
   `"off"` (P-4).
