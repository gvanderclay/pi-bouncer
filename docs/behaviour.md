# How the bouncer decides

This page holds the detail the README leaves out: how a command is read,
which decision wins, and exactly what each mode and auto mode's judges do.
Words such as "rule level" and "always-deny set" are defined in
[the glossary](glossary.md).

## Reading a command

Every `bash` command is parsed with `unbash` and checked wherever the danger
can hide: chains, pipelines, `$(…)`, wrappers such as `env`, `timeout`,
`xargs`, `setsid`, `flock` and `watch` (the shell strings `watch` and
`flock -c` run are parsed too), `bash -c` and `eval`, paths, and quoting.
A command that cannot be parsed is denied (`unparseable`), as is one nested
too deep (`inline-too-deep`). When the parser itself cannot load, every
`bash` call is denied (`parser-unavailable`) with an instruction to reinstall
the package.

`rm-root` resolves relative paths against the session's working directory
and expands `~` and `$HOME`. It reads nothing from the filesystem and
follows no symlink.

## Which decision wins

One line can match several rules. A deny anywhere on the line wins over
everything, and the model is told not to work around it. A steer rule's
match wins over every ask: the line gets the steer block, with no dialog and
no warning, however many asks it holds. Otherwise each ask is decided in
turn, and a denied ask stops the line.

## The dialog

An ask names the rule and quotes the command, for example:

```text
Bouncer: recursive rm deletes whole directory trees (rule: recursive-rm)
rm -rf build
```

The choices are:

- Allow once.
- Allow for this session: only that exact command, in that directory, for
  that rule, held in memory until the next session start (`/new`,
  `/resume`, `/fork` or `/reload`).
- Deny.
- Deny with reason: your text goes to the model.
- Deny and stop: also aborts the turn.
- Auto mode, and Allow all (YOLO): each allows the rest of the line and turns
  that mode on. Auto mode is offered only when the judge list resolves.

Escape, or aborting the turn, denies. A line with several dangers asks once
for each ("1 of N"). Without a UI (print, JSON or RPC mode with no dialogs),
every ask denies.

## Modes

The mode is one process-wide setting, held in memory only: it survives
`/new`, `/resume` and `/reload`, and ends with the process. Turning auto mode
on turns YOLO mode off, and the other way round. `--auto` together with
`--yolo` is an error.

The footer shows the mode: a bold red `🔥 YOLO`, or `🤖 AUTO`,
`🤖 AUTO (paused)` and, while a judge call is out, `🤖 judging…`. The model is
never told that either mode is on. A call YOLO mode allows just runs, and an
auto-mode deny reaches the model in the same form as any other deny, naming
neither auto mode nor a judge.

YOLO mode allows every ask with no dialog or judge, and every rule set to
deny as well. The always-deny set, unreadable commands and steer rules still
deny.

A session's profile may set the mode it starts in. A flag always wins, and
the flag a parent's launch listener gives a child carries the parent's mode:

| Parent's mode (flag the child gets) | Profile `mode` | Child starts in |
| --- | --- | --- |
| YOLO (`--yolo`) | any | YOLO |
| auto (`--auto`) | any | auto |
| off (no flag) | `"auto"` | auto, when a judge-list entry resolves; otherwise off with the usual refusal notice |
| off (no flag) | `"off"` | off, even with `startMode: "auto"` |
| off (no flag) | absent | `startMode`, as before |

## Auto mode

In auto mode, every ask that no session allow covers goes to Jev first when
`auto.jev` is set, then to the judge list, the first entry that answers
deciding. An allow runs quietly; a deny blocks with the judge's one-line
reason; a hand-off or no answer opens the dialog. Auto mode refuses to turn
on when no judge-list entry resolves.

Some lines are decided before any judge is asked: rule-level denies, the
always-deny set, unparseable commands and steer rules are denied, and
`auto.alwaysAsk` prefixes open the dialog unless a steer rule blocks the
line. A model that refuses the request under its provider's usage policy
counts as a deny.

### Budgets and pause

Each judge-list entry gets 10 s, and a line gets 20 s in total. Three denies
in a row, or 20 in a session (Jev's included), pause auto mode until you
allow a call. A steer block never counts toward the pause.

### What the judge sees

The judge sees the command, the flagged rules, the working directory, the
git branch and remotes, your last message in full, up to 10 earlier messages
of yours (each cut to 1,000 characters, 4,000 in all), the session history,
and the `auto.environment` facts. It never sees tool output, file contents,
edit text or the agent's own messages. Literal closing tags inside any of
these are escaped. All of this is sent to the providers of the models in the
judge list.

The session history is the bouncer's own record of what the agent ran: every
bash command Pi executed, with its working directory, and the absolute path
of every `write` and `edit`. It is recorded when a tool returns, so blocked,
refused and aborted calls never appear; a call that ran and failed is marked
failed, and a background start is marked as one. It keeps the newest 50
entries, each cut to 1,000 characters, and the judge gets the newest within
8,000 characters. It is recorded in every mode but read only in auto mode,
and cleared at every session start.

With the history, the judge can allow deleting what the agent visibly
created this session, unless you asked to keep it. It does not allow deleting
anything that existed before the session, glob or age deletes in shared
directories such as `/tmp`, a shared directory itself, or a target held in a
variable whose value it cannot see.

### Jev

Jev is TypeSafe's classifier, always called through Pi's classifier support
with no retries. It sees exactly what the judge sees, under the same budgets,
and answers five questions in one call. Two numbers come out of them:

- The `safety` question, built from the judge's own criteria, gives a safe
  probability, used only to allow.
- Four short questions (what kind of change the command makes, whether the
  agent created its target, what the user asked for, and whether it deletes
  a risky target) give a deny score, combined in code and used only to deny.
  The strongest reason to refuse (harmful, asked to keep, risky target) caps
  the strongest reason to allow (routine, created, asked for).

A safe probability at or above `allowAt` runs the line quietly with no
judge-list call. A deny score at or above `denyAt`, when `denyAt` is not
`null`, blocks it with no judge-list call and a fixed reason that names no
judge; it counts toward the pause like a judge deny, and a Jev allow ends a
run of denies. Anything else goes to the judge list as usual: below both
cutoffs, both reached, a change Jev calls `other` at 0.5 or more, no key, an
HTTP error, a reply missing any of the five answers, or no reply within 5 s.
Jev's 5 s come out of the line's 20 s, and aborting the turn aborts it.

A Jev failure is reported once per session, like a judge-list model's.
`/auto status` shows whether Jev is on, its cutoffs, its model and whether
its key resolves, and every Jev answer is in the call's log record. Jev
cannot turn auto mode on by itself: `auto.models` stays required. Its
default cutoffs were measured through OpenCode Zen only; another provider's
`jev-1.13` should behave the same, but that is unverified, and the
`auto-judge-list` skill's bench can re-measure it.

## The log

One JSON line is appended to `<agent dir>/bouncer/log.jsonl` (or
`$PI_BOUNCER_LOG_DIR/log.jsonl`) for each hard deny, no-UI deny, dialog
answer, session-allow hit, call YOLO mode allowed, call auto mode decided,
mode switch and session start. Calls the bouncer lets through untouched are
not logged. The session record's `config` has a `profile` when the session has
an agent name (its `state`, `agent`, the variable it came from, and the
profile `name`), and each call record of a session running a profile has
`agent` and `profile`. The log rotates into gzipped generations within the `log`
limits, and a write failure never changes a decision.
