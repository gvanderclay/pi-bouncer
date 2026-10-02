# Spec: per-child profiles

What a user sees once profiles ship. Why each point is so is in
`docs/research/child-permissions/decisions.md` (cited as Q<n>); how it is
built, pull request by pull request, is in `docs/profiles-plan.md`. Each
numbered point is a requirement a ticket's tests must show.

## S1. Config

1. The user config and a project's `.pi/extensions/bouncer/config.json` accept
   `profiles` (name → profile) and `agents` (agent name → profile name)
   (Q3, Q17).
2. A profile may hold `levels`, `rules`, `protect` and `mode`, each checked
   as the top-level key of the same name is. `mode` is `"off"` or `"auto"`;
   `"yolo"` is a problem (Q2, Q8, Q19).
3. A profile name matches `^[a-z0-9][a-z0-9-]*$`. An `agents` entry naming a
   profile neither file defines is a problem.
4. Config problems in profiles are reported with their path in the
   session-start warning and `/bouncer check`, whether or not the session
   uses that profile.
5. The JSON schema describes both keys, and `examples/` holds a profile
   example.

## S2. Which profile a session runs

1. The agent name is the first non-blank of `PI_BOUNCER_AGENT`,
   `PI_SUBAGENT_AGENT`, `PI_DADDY_DEFINITION`, kept in one list in the code
   (Q10, Q15). No agent name: the normal rules, as today.
2. `PI_BOUNCER_AGENT=<name> pi` starts a top-level session as that agent; no
   new flag (Q21).
3. An agent with no `agents` entry runs its parent's rules (Q4).
4. A profile neither file defines, or whose user-config definition has any
   problem, is broken: the session runs the normal rules and the start
   warning names the profile (Q13). A broken project definition is dropped
   and the user's definition stands.

## S3. What a profile changes

1. A profile starts from the normal rules and changes only what it names
   (Q6): its `levels` override entry by entry, its `rules` replace a normal
   custom rule of the same name or are added, its `protect` paths are added.
2. A profile from the user config may loosen as well as tighten (Q1). The
   always-deny set still holds: it can be `ask` at most, and auto and YOLO
   mode deny it whatever the level.
3. A project's profiles follow today's trust rules (Q7). An untrusted
   project's profile only tightens: lower levels, a steer rule and
   `mode: "auto"` are refused, `mode: "off"` applies. A trusted project's
   profile may also loosen outside the always-deny set and set `"auto"`.
   No project lowers the always-deny set.
4. A trusted project's `agents` entry overrides the user's. An untrusted
   project's entry applies only to an agent the user config does not map,
   naming a profile the user config does not define.

## S4. Modes

1. A child whose parent is in auto or YOLO mode runs in the parent's mode,
   whatever its profile says (Q14).
2. Otherwise a profile's `mode` replaces `startMode`: `"auto"` starts auto
   mode (or stays off with today's notice when no judge resolves), `"off"`
   starts off even with `startMode: "auto"`.
3. Top-level `startMode` stays user-config only.

## S5. Children

1. pi-squire's `session:launch` payload carries the agent's name as `agent`
   (pi-squire pull request).
2. The bouncer's `session:launch` listener sets `PI_BOUNCER_AGENT` in the
   child's environment: the child's agent when that agent has a working
   profile, else the parent's agent when the parent runs a profile, else
   nothing. It never overwrites a `PI_BOUNCER_AGENT` already in the payload
   (Q4, Q10, Q18).
3. Launchers that set one of the S2.1 variables themselves work without the
   listener (Q5).

## S6. The `bouncer-escape` rule

1. A normal rule, at `deny` by default, settable to `ask` or `off` in
   `levels` (Q9, Q11, Q12). YOLO lets it through like any rule-level deny;
   auto mode denies it without a judge call.
2. It matches bash that starts `pi` with `--yolo`, or that sets or clears an
   S2.1 variable: `VAR=x cmd`, a bare `VAR=x`, `env VAR=x`, `export`,
   `declare`/`typeset`/`readonly`/`local`, `unset VAR`, `env -u VAR`, and
   `env -i` running `pi`. These are matched inside `sh -c`, `$(…)` and
   wrappers too.
3. Starting plain `pi`, and reading the variables (`echo "$PI_BOUNCER_AGENT"`,
   `printenv`, `rg`), stay allowed.
4. The CHANGELOG names `"levels": {"bouncer-escape": "off"}` as the line
   that restores the old behaviour.

## S7. Visibility

1. `/bouncer status` has a `Profile:` line: none; the profile, agent and
   variable it came from; an agent with no profile; or a broken profile
   (Q20).
2. Every log record of a session running a profile carries `agent` and
   `profile`; the session record's config carries the profile choice.
3. The `bouncer-debug` replay takes `--agent` to replay a call under the
   profile it ran in.
4. The profile is not shown in the footer.

## Known limits (not in this work)

- A parent started with `PI_BOUNCER_AGENT` passes it to children of launchers
  that copy its environment, and it outranks their own variable; to be fixed
  in a later "subagent library compatibility" pass.
- In-process children share the process-wide mode (`src/mode.ts`).
- Forwarding a child's question to the parent session (Q16) is the next
  feature.
- `pi` started under another name (`node …/cli.js`, `npx`, an alias) is not
  caught by `bouncer-escape`.
