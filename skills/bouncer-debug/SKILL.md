---
name: bouncer-debug
description: Explain why the bouncer blocked, asked about, or let through a bash command, from its bouncer log and by replaying the command. Use when the user asks why a command was denied, why a dialog appeared (or didn't), why something ran without asking, why a session allow didn't hold, or whether the bouncer was running.
---

The bouncer judges every bash command the model runs. It appends one
JSON line to its **bouncer log** each time it does more than silently let a
command through, and one line each time a session starts. Read the log first;
replay the command only when the log has no record of it.

## Where the log is

Each Pi route keeps its own log, in its agent dir:

- `<agent dir>/bouncer/log.jsonl`: the current log, shared by every
  session of that route. The agent dir is `$PI_CODING_AGENT_DIR`, or
  `~/.pi/agent` when unset. `$PI_BOUNCER_LOG_DIR`, when set,
  replaces the whole directory (live checks use it).
- `log.1.jsonl.gz`, `log.2.jsonl.gz`, … beside it: older generations, newest
  first. The log rotates at a session start once it passes its size limit
  (5 MiB and five generations unless the route's bouncer config says
  otherwise), so one session's records are never split across files. With
  `log.maxAgeDays` set, generations older than that are deleted at session
  start.

Set a shell variable once and use it in every recipe below:

```bash
BOUNCER_LOG="${PI_BOUNCER_LOG_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bouncer}"
```

## The bouncer config

A rule's level can differ from the built-in one. At every session start the
bouncer reads the route's `<agent dir>/bouncer.json` and the project's
`<cwd>/.pi/extensions/bouncer/config.json` (the session's working
directory only; the project overrides the route entry by entry). A project
file never loosens the always-deny set, and when Pi did not trust the
project at session start it only makes rules stricter; each ignored entry is
a problem in the record's `files`, and the record's `config.projectTrusted`
says which trust state applied. A `<cwd>/.pi/bouncer.json` is never read;
it shows up as a problem asking to move it. `levels` maps a built-in rule to
`ask`, `deny` or `off` (`off` drops the rule, and the record's
`config.levels` shows it as `off`); the always-deny set cannot be `off`,
the `grep` steer rule is `deny` or `off`, and `unparseable`,
`inline-too-deep` and `parser-unavailable` always deny. Setting a level a
rule does not take is a config problem. An invalid part falls back to its built-in value. Edits apply
from the next session start, never mid-session. The route file alone may
also set `auto` (auto mode's `models`, `alwaysAsk`, `environment`,
`firstByProvider` and `jev`); a project file's `auto`, `jev` included, is
ignored with a warning, trusted or not. Don't read the files to
explain a past call: they may have changed since. The session record's
`config` says what applied.

## YOLO mode

While **YOLO mode** is on, the bouncer answers every ask with allow and opens
no dialog, with or without a UI. The user turns it on with `/yolo`, with the
dialog's "⚠️ Allow all (YOLO)" choice, or by starting `pi --yolo`, and off
with `/yolo` or `/yolo off`. It is process-wide and in memory only: it
survives session starts and `/reload` and ends when the process exits.

Even in YOLO mode the **always-deny set** (`privilege`, `power`,
`disk-format`, `dd-device`, `rm-root`) and the unreadable-command denies
still deny, with the usual reason and warning. The `grep` steer rule still
denies too, with its `rg` reason and no warning. The set is fixed in code:
YOLO mode ignores the bouncer config's `levels`, so a `privilege` lowered to
`ask` still denies and a rule raised to `deny` is allowed. A session allow
still answers its ask first.

## Auto mode

The bouncer has one process-wide **bouncer mode**: off, auto or YOLO; turning one
on leaves the other. While **auto mode** is on, every ask that no session
allow covers goes to a **judge**: the first model on the route's **judge
list** (`auto.models` in the route's bouncer config, `provider/id` entries)
that answers. `auto.firstByProvider` maps the session model's provider to
one of those entries, which is then asked first; the rest follow in list
order. One judge call covers the whole line. The user turns it on
with `/auto`, the dialog's "🤖 Auto mode" choice, or `pi --auto` (an error
together with `--yolo`), and off with `/auto` or `/auto off`; `/yolo` leaves
it for YOLO mode. It refuses to turn on when no list entry resolves in Pi's
model registry. Its lifetime is YOLO mode's.

- The judge answers `allow` (the line runs, quietly), `deny` (a hard deny;
  the model is told the judge's one-line reason in the usual hard-deny form,
  which never mentions a judge) or `ask` (the dialog opens with a
  `Judge: <reason>` line). With no UI a hand-off blocks.
- Denied before any judge call: rule-level denies (the effective policy's
  `deny`), the always-deny set whatever its level, the
  unreadable-command denies, and the `grep` steer rule, which also wins over
  an `auto.alwaysAsk` prefix and never counts toward the pause.
- Never judged: a command matching one of the route's `auto.alwaysAsk`
  prefixes gets the pseudo-rule `always-ask` and always opens the dialog.
- Each model has 10 s and the line 20 s; any failure (not in Pi's catalogue,
  no auth, quota, timeout, network, an unparseable reply) moves to the next
  entry. If none answers, the dialog opens marked "Auto: no judge
  available"; without a UI the call blocks.
- A usage-policy refusal (Pi reports stop reason `error` with raw stop
  reason `refusal`) is not a failure: it is a deny with the reason "It was
  refused as likely harmful.", the refusing model in `auto.model`, and the
  list stops there. It counts toward the pause like any judge deny.
- Three denies in a row, or 20 in a session, from a judge or Jev, **pause** auto mode: its
  calls go to the dialog (with a "🤖 Auto mode (resume)" choice) until the
  user allows one. Session starts reset the counts. Pausing and resuming
  write no record of their own; the call records' `paused` verdicts show it.
- A mode switch while a judge call is out drops the judge's verdict, and the
  new mode decides the call.
- **Jev**: when the route's `auto` has `jev`, the judge list is asked only
  after Jev, OpenCode Zen's `jev-1.13` classifier (called with the route's
  opencode-go key). Jev sees what the judge sees and answers five questions
  in one call: `safety` gives the safe probability, used only to allow, and
  four short questions (`effect`, `created`, `user_intent`,
  `risky_target`) give the deny score, used only to deny:
  `1 − min(max(P(effect = routine), created, P(user_intent = asked_for_this)),
  1 − max(P(effect = harmful), P(user_intent = asked_to_keep), risky_target))`.
  `auto.jev.allowAt` and `auto.jev.denyAt` are optional
  numbers above 0.5 and at most 1 (`denyAt` may be `null`); an absent
  `allowAt` is 0.75, an absent `denyAt` is `null` (Jev denies only when
  the route sets it), and an invalid `auto.jev` is a config problem that
  leaves Jev off. A safe
  probability at or above `allowAt` allows the line with no judge-list call,
  and `auto.model` is `opencode-go/jev-1.13`. A deny score at or
  above `denyAt`, unless `denyAt` is `null`, denies it the same way, in the
  ordinary hard-deny form with the fixed reason "It was rated as likely
  unsafe." (no judge named); it counts toward the pause like a judge deny,
  and a Jev allow ends a run of denies. Anything else, including a deny
  score below `denyAt`, both cutoffs reached, P(effect = other) of 0.5 or
  more, and a failure (no key, HTTP error, unreadable reply or one missing
  any of the five answers, no reply within 5 s, aborted turn), goes to the judge
  list with what is left of the line's 20 s. A Jev failure is reported once
  per session under `opencode-go/jev-1.13`. Everything denied or never
  judged above never reaches Jev either.
- The judge sees the command, each uncovered ask's rule and summary, the
  working directory, the git branch and dirty state, the git remotes (those
  added or changed since the session started flagged), the user's last
  message in full, up to 10 earlier user messages (each cut to 1,000
  characters, 4,000 in all, newest kept), the session history and the
  route's `auto.environment` facts. Never tool output, file contents, edit
  text, the agent's own messages or `AGENTS.md`.
- The session history is the bouncer's own record, taken at `tool_result` in
  every mode since the session started: each executed bash command with its
  working directory, and the absolute path of each `write` and `edit`.
  Blocked, refused and aborted calls are absent; a call that ran and failed
  is marked `failed`, a background start `started in background`. It keeps
  the newest 50 entries (each cut to 1,000 characters) and sends the newest
  within 8,000 characters. Every session start (`/new`, `/resume`, `/fork`,
  `/reload`) clears it; only auto mode reads it. The judge may allow
  deleting what the agent visibly created this session, unless the user
  asked to keep it.
- `/auto status` shows the mode, the pause, Jev (off, or on with its
  cutoffs and whether the opencode-go key resolves), each list entry and whether it
  resolves, the `firstByProvider` entries with this session's provider
  marked, each model's last failure this session, the `alwaysAsk`
  prefixes and how many environment facts there are, without calling a
  model.

## What a record holds

Every record has `v` (format version, `1`), `type`, `time` (ISO 8601),
`sessionId`, `sessionFile` (`null` for an in-memory session) and `cwd`.

- `type: "session"`: one per session start. `reason` is `startup`, `reload`,
  `new`, `resume` or `fork`; `parser` says whether the bash parser loaded.
  With `parser: false` the bouncer denied every bash call as
  `parser-unavailable`. `yolo` says whether YOLO mode was on as the session
  started (after `--yolo` was applied), and `auto` whether auto mode was
(after `--auto`). `config` is what the session ran
  under:
  - `files`: the route file, then the project file, each
    `{path, loaded, problems}`. A missing file is `loaded: false` with no
    problems; a broken one lists what was wrong.
  - `levels`: every rule with its effective level for the session.
  - `log`: the effective `rotateAboveMiB`, `generations` and `maxAgeDays`.
  - `auto`, only when the route sets it: the judge list `models`, the
    `alwaysAsk` prefixes, `environment` as a count of facts (their text
    is not logged), `firstByProvider` when it is set, and `jev` (its
    `allowAt` and `denyAt`, `null` for never) when Jev is on.
- `type: "call"`: one per bash call the bouncer intervened in.
  - `command`: the full command, never clipped.
  - `ui`: whether anyone could answer a dialog. Without a UI every match
    denies, with no dialog.
  - `outcome`: `allowed`, `blocked` or `stopped` (Deny and stop).
  - `reason`: the exact text the model was told; absent when allowed.
  - `matches`: every `{rule, level, source}` the bouncer found, in evaluation
    order. `level` is `ask` or `deny`; `source` is the part of the line that
    matched. A `deny` match ends the list: the bouncer stopped there. A
    `grep` match does not: the steer rule is held while the rest of the line
    is scanned, and a later real deny wins over it.
  - `asks`: what happened to each ask, in order: `{rule, source, answer}`,
    plus `userReason` when the user typed one. The list ends at the first
    deny, so later asks were never shown. Empty when no dialog ran (a hard
    deny, or no UI).
  - `yolo: true` and `withoutYolo`, only on a call YOLO mode decided.
    `withoutYolo` is what the effective policy alone would have done:
    `blocked` (a hard deny, or asks with no UI), `dialog` (a dialog would
    have opened) or `allowed` (session allows covered every ask). Under YOLO
    mode `matches` does not stop at a deny outside the always-deny set.
  - `auto` and `withoutAuto`, only on a call auto mode decided (`withoutAuto`
    alone when the call was denied or session-allowed before any judge).
    `withoutAuto` takes the same values as `withoutYolo`. `auto` holds:
    - `verdict`: `allow`, `deny` or `ask` (the judge's), `none` (no model
      answered), `paused` (auto mode was paused, so the dialog opened) or
      `always-ask` (an `alwaysAsk` prefix hit). The last two mean no judge
      was called.
    - `reason`, `model` (the `provider/id` that answered, or
      `opencode-go/jev-1.13` when Jev decided) and `ms`, when a judge
      answered.
    - `tried`: every `{model, error}` given up on before the answer, in
      list order. Empty when Jev decided; a Jev failure is in `jev`, not here.
    - `jev`, only when the route has `auto.jev` and Jev was asked: `answer`
      (`safe`, `unsafe`, or `unsure` when the judge list was asked next), `safe` (the
      safe probability), `unsafe` (the deny score), `confidence` (the
      `safety` answer's), the four answers behind the deny score (`effect`
      and `user_intent` as a probability per class, `created` and
      `risky_target` as the probability of true) and `ms`; or, when the call failed,
      `error` and `ms`. `verdict` and `model` still describe the decision
      that took effect.
    - `sent`: `{history, earlierMessages}`, how many session-history
      entries and earlier user messages the judge was sent, only when a
      judge was asked. Never their content.
    - `discarded: true` when the bouncer mode changed while the judge was out:
      the verdict was dropped, and the rest of the record (`outcome`, `asks`,
      and `yolo` if the new mode was YOLO) is what the new mode decided.
- `type: "yolo"`: one each time YOLO mode turned on or off. `on` is the new
  state; `how` is `command` (`/yolo`), `dialog` ("Allow all (YOLO)") or
  `flag` (`pi --yolo`, at the process's first session start). Asking for the
  state it is already in writes nothing.
- `type: "auto"`: the same for auto mode: `on`, and `how` is `command`
  (`/auto`), `dialog` ("🤖 Auto mode"), `flag` (`pi --auto`) or `config`
  (the route's `"startMode": "auto"`, at the process's first session start
  when neither `--auto` nor `--yolo` was given). Switching
  from one mode to the other writes the `off` record of the mode left, then
  the `on` record of the mode entered. A refused `/auto` writes nothing.

Answers: `allow-once`, `allow-session` (Allow for this session),
`session-allowed` (skipped: an earlier Allow for this session covered it),
`deny`, `deny-with-reason`, `deny-and-stop`, `escape` (dismissed the dialog),
`aborted` (the turn was aborted while the dialog was open), `allow-all` (the
user picked "⚠️ Allow all (YOLO)", which allowed the call and turned YOLO
mode on), `yolo` (YOLO mode allowed it with no dialog), `auto` (the judge
allowed it), `auto-deny` (the judge denied the line) and `allow-auto` (the
user picked "🤖 Auto mode", which allowed the call and the rest of its
line and turned auto mode on, or resumed it while paused). The rule
`always-ask` in `matches` and `asks` is not a built-in rule: it is an
`alwaysAsk` prefix hit.

A command that matched no rule is never logged: the session file already
holds it.

## Workflow

1. **Find the session id.** It's in `$PI_SESSION_ID` when set, and in the
   `id` field of the session file's first line:
   `head -1 <session file> | jq -r .id`. The session file's name also ends
   in `_<id>.jsonl`.
2. **Read that session's records**, current log first, then the rotated
   ones when the session is older:

   ```bash
   jq -c --arg id "$ID" 'select(.sessionId == $id)' "$BOUNCER_LOG/log.jsonl"
   zcat "$BOUNCER_LOG"/log.*.jsonl.gz | jq -c --arg id "$ID" 'select(.sessionId == $id)'
   ```

3. **Find the call** by its command, and read `outcome`, `matches`, `asks`
   and `reason`: they say which rule caught what, what the user answered,
   and what the model was told. A level that differs from the built-in one
   comes from the bouncer config: the latest `session` record before the call
   has it in `config.levels` and names the file in `config.files`.
   **Ran without asking?** `yolo: true` on the call means YOLO mode allowed
   it (answers `yolo`), and `withoutYolo` says what would have happened
   otherwise. The latest `yolo` record before the call, or the `session`
   record's `yolo`, says when and how YOLO mode came on. Answers `auto`
   mean the judge allowed it: `auto.model` and `auto.reason` say who and
   why, and `withoutAuto` what would have happened otherwise.
   **Why did the judge deny this?** On a call with `auto.verdict: "deny"`,
   `auto.reason` is the judge's reason (also in `reason`), `auto.model` the
   model that said it, and `auto.tried` the models that failed first. The
   judge saw only what the Auto mode section lists; replay the command
   (step 5) to confirm it reached the judge and was not a rule-level deny.
   To rebuild what the judge saw, read the session file up to the call:
   the user's last message and the `auto.sent.earlierMessages` user
   messages before it, and, since the latest session start, the agent's
   bash, `write` and `edit` tool calls whose results arrived (newest
   `auto.sent.history` of them, a result with `isError` marked failed).
   Assistant text and tool results never reached the judge.
   `discarded: true` means that verdict was not acted on. Calls with
   `auto.verdict` `none`, and the models in `tried`, point at a judge list
   that needs fixing (`/auto status`).
   **Did Jev decide?** `auto.model` `opencode-go/jev-1.13` means Jev decided
   the call: with `auto.verdict` `allow`, `auto.jev.safe` reached the route's
   `allowAt`; with `deny` (`auto.jev.answer` `unsafe`), `auto.jev.unsafe`,
   the deny score, reached its `denyAt` (both in the session record's
   `config.auto.jev`), and the four answers beside it show which veto or
   missing reason to allow drove it. Otherwise `auto.jev.answer` `unsure` with its
   `safe`, `unsafe` and `effect.other` shows why Jev deferred, and `auto.jev.error` that
   the call failed (for example `no opencode-go key`).
4. **No record for the command?** Check the session's `session` records.
   None at all means the bouncer wasn't loaded in that session. `parser: false`
   means every bash call was denied. A live bouncer with a working parser and
   no call record means the command matched no rule.
5. **Replay it** to see which rule, if any, would catch it now. The script
   sits two directories up from this skill, in the bouncer's own package. In a
   git checkout with no `dist/`, run `pnpm build` there once, or run
   `src/explain.ts` instead of `dist/src/explain.js`:

   ```bash
   node <this skill's directory>/../../dist/src/explain.js '<command>'
   jq -r .command record.json | node <this skill's directory>/../../dist/src/explain.js -
   node <this skill's directory>/../../dist/src/explain.js --json '<command>'
   node <this skill's directory>/../../dist/src/explain.js --agent-dir <agent dir> --cwd <session cwd> '<command>'
   node <this skill's directory>/../../dist/src/explain.js --untrusted '<command>'
   ```

   It prints every match with its rule, level and source, then what the bouncer
   would do "with a UI" (allow, ask, or deny with the rule), "without a UI"
   and "with YOLO" (allow, or deny with the rule that still stops it), and
   "with auto" (`judge`, `ask (always-ask)`, `allow` or deny with the rule
   that stops it before any judge; it never calls a model or reads git), then
   a `config:` line naming the bouncer config files it read and their
   problems, then a `trust:` line with the project trust state it used and
   where that came from. It applies the same config as the live bouncer: the route from
   `$PI_CODING_AGENT_DIR` (or `~/.pi/agent`) and the project from the current
   directory. To replay a session that ran elsewhere, pass `--agent-dir` and
   `--cwd` (the record's `cwd`). The project's trust state decides which
   project levels apply: `--trusted` or `--untrusted` sets it, and to match a
   past session pass the one its record's `config.projectTrusted` says.
   Without either it uses Pi's saved decision in the route's `trust.json`
   (a project with no saved decision counts as
   untrusted, though the session may have been trusted for that session
   only), and it exits with an error asking for a flag if it cannot load
   Pi's package. `--json` prints the matches in the log's `matches` shape, a
   `config` field shaped like the session record's and a `trust` field, so
   you can compare a replay against a record. It never opens a dialog and
   never runs the command. It ignores session allows, which live only in the
   running bouncer's memory, and it reads the config as it is now, not as the
   session saw it.

## More recipes

```bash
# Every block by one rule, across all generations.
{ zcat "$BOUNCER_LOG"/log.*.jsonl.gz 2>/dev/null; cat "$BOUNCER_LOG/log.jsonl"; } |
  jq -c 'select(.type == "call" and .outcome != "allowed" and any(.matches[]; .rule == "privilege"))'

# Every answer of one kind, with the typed reason.
jq -c 'select(.type == "call") | .asks[] | select(.answer == "deny-with-reason")' "$BOUNCER_LOG/log.jsonl"

# When YOLO mode turned on or off, and how.
jq -c 'select(.type == "yolo") | {time, on, how}' "$BOUNCER_LOG/log.jsonl"

# Calls YOLO mode waved through that would otherwise have stopped.
jq -c 'select(.type == "call" and .yolo and .withoutYolo != "allowed") | {command, withoutYolo}' "$BOUNCER_LOG/log.jsonl"

# Every judge verdict, with its model and reason.
jq -c 'select(.type == "call" and .auto) | {command, verdict: .auto.verdict, model: .auto.model, reason: .auto.reason, discarded: .auto.discarded}' "$BOUNCER_LOG/log.jsonl"

# Judge-list models that failed, and why.
jq -c 'select(.type == "call") | .auto.tried[]? ' "$BOUNCER_LOG/log.jsonl"

# What Jev said about each call it was asked about.
jq -c 'select(.type == "call" and .auto.jev) | {command, jev: .auto.jev, model: .auto.model}' "$BOUNCER_LOG/log.jsonl"

# When auto mode turned on or off, and how.
jq -c 'select(.type == "auto") | {time, on, how}' "$BOUNCER_LOG/log.jsonl"

# Commands that ran without a dialog because of a session allow.
jq -c 'select(.type == "call" and any(.asks[]; .answer == "session-allowed")) | .command' "$BOUNCER_LOG/log.jsonl"

# Plain-text search, gzipped generations included.
rg -z 'git push' "$BOUNCER_LOG"
```

The log is a debugging aid, not an audit trail: anything with access to the
user's home can append to it.
