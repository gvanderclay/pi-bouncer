# Per-child permission profiles: decisions agreed with the owner

Agreed 2026-10-02 in a design interview; Q numbers are the interview's. The
research behind them is beside this file (`claude-code.md`, `gotgenes.md`,
`codex.md`, `pi-subagents.md`). The owner treats Claude Code and
@gotgenes/pi-permission-system as the gold standard, but does not want the
bouncer restrictive or annoying (gotgenes was why it was built).

## Shape

- A **profile** is a named group of rule changes in config under `profiles`;
  `agents` maps an agent name to a profile, e.g. `"agents": {"scout":
  "readonly"}` (Q3, Q17).
- A profile starts from the normal rules and changes only what it names
  ("inherit"; no "replace" mode for now, addable later without breaking)
  (Q6). It may hold `levels`, `rules`, `protect` (additive) and `mode` (off or
  auto only, never YOLO) (Q2, Q8, Q19).
- A profile may loosen as well as tighten, so a restricted orchestrator can
  hand work to a looser worker. The always-deny set always holds (Q1).
- Profiles and the agent map may live in the user config and in a project's
  `.pi/extensions/bouncer/config.json`, under today's project trust rules:
  untrusted only tightens, trusted may also loosen outside always-deny (Q7).

## How a child gets its profile

- The child reads `PI_BOUNCER_AGENT`; when unset, it falls back to
  `PI_SUBAGENT_AGENT` (HazAT) and `PI_DADDY_DEFINITION` (pi-daddy), kept in
  one extendable list (Q10, Q15). Any launcher that sets the variable works
  (Q5); the design must not block other subagent/workflow libraries later.
- pi-squire (`~/workspace/pi-squire`) adds the agent name as a field on its
  `session:launch` payload; the bouncer's listener (`src/session-launch.ts`)
  turns it into `PI_BOUNCER_AGENT` for the child (Q10).
- A user may start a top-level session in a profile with
  `PI_BOUNCER_AGENT=orchestrator pi`; no new flag (Q21).
- An agent with no profile gets its parent's rules; a parent running a profile
  passes it on to such a child (Q4, Q18).
- A missing or broken profile falls back to the parent's rules (Q13).
- In-process children (nicobailon foreground, tintinweb, gotgenes) are out of
  scope for now; the mode is process-wide (`src/mode.ts`), so leave room for a
  per-session profile/mode later.

## Modes

- A parent in auto or YOLO wins: the child runs in the parent's mode. A
  profile's own mode applies only when the parent is off (Q14, as Claude Code).

## Guarding bash

- Starting `pi` from bash stays allowed. One new normal (not always-deny) rule,
  deny by default and turnable off in `levels`, covers bash that runs
  `pi --yolo` or sets `PI_BOUNCER_AGENT`, `PI_SUBAGENT_AGENT` or
  `PI_DADDY_DEFINITION` (Q9, Q11, Q12). YOLO lets it through, like any deny.

## Visibility and later work

- `/bouncer` status shows the session's profile; the log records the profile
  on every decision (Q20). Not in the footer.
- Forwarding a child's ask to the parent's session is the next feature after
  this one, modelled on Claude Code (Q16).
