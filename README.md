# bouncer

Guards the model's `bash` tool with a short, fixed list of rules. The npm
package is `pi-bouncer`.

Every command is parsed with `unbash` and checked wherever the danger hides —
chains, pipelines, `$(…)`, wrappers such as `env`/`timeout`/`xargs`/
`setsid`/`flock`/`watch` (the shell strings `watch` and `flock -c` run are
parsed too), `bash -c`/`eval`, paths and quoting. Recoverable-if-intended
actions open a dialog that names the rule and quotes the command: recursive
`rm`, `find -delete`/`-exec`, `fd -x`, `rg --pre`, the template runners
`parallel`/`rush`/`rust-parallel`, a wrapper whose options hide where its
command starts, work-losing git (`clean -f`,
`reset --hard`, `checkout --`, `restore`, `stash drop`), forced or deleting
pushes, downloads piped into a shell, package publishing, and `gh repo`
deletion. Catastrophic or unreadable actions are denied with no dialog and a
warning: `sudo`/`su`/`doas`, shutdown, disk formatting, `dd` to a device, a
recursive `rm` of `/`, a system directory, `~` or an important folder in it,
and commands that cannot be parsed. A deny anywhere on a line wins. Each
rule's level is built in and can be changed in the bouncer config.

One steer rule, `grep`, blocks every `grep`, `egrep` or `fgrep` the scan
finds, and grep in the command slot of `find -exec`/`-execdir`/`-ok`/`-okdir`
and `fd -x`/`-X`, and tells the model to run the search with `rg` instead.
It denies in every mode, including YOLO, with no dialog, no judge call and no
warning, and every block is logged. Its level is fixed. A real deny on the same line wins
with its warning; the grep block wins over every ask. It is built in for now
and moves to a custom rule once the bouncer config supports them.

## Install

```bash
pi install <path to this directory>
```

Then install the parser once per machine. Without it the bouncer fails closed and
denies every `bash` call with this instruction:

```bash
cd <path to this directory> && pnpm install
```

Once it is published, install it by name instead:

```bash
pi install npm:pi-bouncer
```

The `pi` manifest loads `./index.ts` and `./skills`, and the tests under
`test/` are neither loaded by Pi nor included in the npm tarball.

## Requirements

- Pi, with `pi.events`, `pi.on`, `pi.registerCommand` and `pi.getFlag`.
- `@earendil-works/pi-coding-agent`, declared as a peer dependency and
  supplied by Pi.
- `unbash` (a regular dependency) and `pnpm install` in this directory.

## Modes

The mode is one process-wide setting, in memory only: it survives `/new`,
`/resume` and `/reload` and ends with the process. Turning auto mode on turns
YOLO mode off, and the other way round.

| Mode | Flags | What it does |
| --- | --- | --- |
| normal (off) | none | every ask opens the dialog |
| auto | `/auto`, `/auto on\|off\|status`, `pi --auto` | every ask no session allow covers goes to Jev first when the route sets `auto.jev`, then to the first model of the bouncer config's judge list that answers; an allow runs quietly, a deny blocks with the judge's one-line reason (or a fixed one when Jev denies), and a hand-off or no answer opens the dialog. Three denies in a row, or 20 in a session, Jev's included, pause it until you allow a call. It refuses to turn on when no list entry resolves |
| YOLO | `/yolo`, `/yolo on\|off`, `pi --yolo` | every ask is allowed with no dialog or judge. The always-deny set, unreadable commands and the `grep` steer rule still deny |

`--auto` with `--yolo` is an error. A dialog can also switch to either mode
after allowing the current line.

The route's `bouncer.json` can set `"startMode": "auto"` so every process
starts in auto mode without `--auto`; `"off"`, the default, starts in normal
mode. It applies at the process's first session start only, refuses as
`/auto` does when no judge-list entry resolves, and gives way to `--yolo` or
`--auto`. `"yolo"` is not accepted: YOLO mode only ever starts from
`pi --yolo` or `/yolo`.

The footer shows the mode: a bold red `🔥 YOLO`, or `🤖 AUTO`,
`🤖 AUTO (paused)` and, while a judge call is out, `🤖 judging…`. The model is
never told either mode is on: a YOLO-allowed call just runs, and an auto-mode
deny is sent in the same hard-deny form as any other deny, naming neither auto
mode nor a judge (the judge's one-line reason is the deny's reason).

In auto mode each judge-list entry gets 10 s, and a line gets 20 s in total.
`auto.firstByProvider` names the entry to ask first for the session model's
provider. The judge sees the command, the flagged rules, the working
directory, the git branch and remotes, your last message in full, up to 10
earlier messages of yours (each cut to 1,000 characters, 4,000 in all), the
session history and the route's `auto.environment` facts. It never sees tool
output, file contents, edit text or the agent's own messages. Literal closing
tags inside any of these blocks are escaped.

The session history is the bouncer's own record of what the agent ran: every
bash command Pi executed, with its working directory, and the absolute path of
every `write` and `edit`. It is recorded at `tool_result`, so blocked, refused
and aborted calls never appear; a call that ran and failed is marked failed,
and a background start is marked as one. It keeps the newest 50 entries, each
cut to 1,000 characters, and the judge gets the newest within 8,000
characters. It is recorded in every mode but read only in auto mode, and
cleared at every session start (`/new`, `/resume`, `/fork`, `/reload`). With it
the judge can allow deleting what the agent visibly created this session,
unless you asked to keep it, but not anything that existed before the session,
glob or age deletes in shared directories such as `/tmp`, a shared directory
itself, or a variable target whose value it cannot see. A model that refuses the
request under its provider's usage policy counts as a deny. Rule-level denies,
the always-deny set, unparseable commands and the `grep` steer rule are denied
before any judge is asked, and `auto.alwaysAsk` prefixes always open the
dialog unless the line holds a grep. A grep block never counts toward the
pause.

With `auto.jev` in the route's `bouncer.json`, auto mode asks Jev first:
OpenCode Zen's `jev-1.13` classifier, reached at a fixed SystemOne URL with
the opencode-go key Pi holds for the route. Jev sees exactly what the judge
sees, under the same budgets, and answers five questions in one call. Two
numbers come out of them. The `safety` question, built from the judge's own
criteria, gives a safe probability, used only to allow. Four short questions
(what kind of change the command makes, whether the agent created its
target, what the user asked for, and whether it deletes a risky target)
give a deny score, combined in code and used only to deny: the strongest of
the reasons to refuse (harmful, asked to keep, risky target) caps the
strongest reason to allow (routine, created, asked for). A safe probability
at or above `allowAt` runs the line quietly with no judge-list call. A deny
score at or above `denyAt`, when `denyAt` is not `null`, blocks it with no
judge-list call, in the ordinary hard-deny form with a fixed reason that
names no judge; it counts toward the pause like a judge deny, and a Jev
allow ends a run of denies. Either is recorded with the model
`opencode-go/jev-1.13`. Anything else (below both cutoffs, both reached, a
change Jev calls `other` at 0.5 or more, no key, an HTTP error, a reply
missing any of the five answers or no reply within 5 s) goes to the judge
list as usual. Jev's 5 s come out of the line's 20 s, and
aborting the turn aborts it. A failure is reported once per session, like a
judge-list model's, and `/auto status` shows whether Jev is on, its cutoffs
and whether the key resolves. Every Jev answer is in the call's log record.
Jev never sees anything the judge list would not: rule-level denies, the
always-deny set, unparseable commands, the `grep` steer rule,
`auto.alwaysAsk` hits, a paused auto mode and lines session allows cover are
decided before it is asked. Jev cannot turn auto mode on by itself:
`auto.models` stays required.

## Dialog

An ask names the rule and quotes the command. The choices are Allow once;
Allow for this session (only that exact command, in that directory, for that
rule, in memory until the next session start, `/new`, `/resume`, `/fork` or
`/reload`); Deny; Deny with reason (your text goes to the model); Deny and stop
(also aborts the turn); Auto mode and Allow all (YOLO), each of which allows
the rest of the line and turns that mode on (Auto shows only when the judge
list resolves). Escape or aborting the turn denies, and a line with several
dangers asks once for each ("1 of N"). Without a UI every ask denies. A deny
anywhere on a line wins, and a deny tells the model not to work around it.
The always-deny set is `sudo`/`su`/`doas`, shutdown, disk formatting, `dd` to
a device and `rm-root` (a recursive `rm` of `/`, a system directory, `~` or an
important folder in it such as `~/Documents`, `~/workspace` or `~/.ssh`;
relative paths resolve against the session's working directory). YOLO and
auto mode never allow it, nor unparseable commands, whatever the config says.
A line with a grep and no real deny gets the `grep` steer block, with no
dialog and no warning, however many asks it holds.
`!` commands are never gated.

## Configuration

At every session start the bouncer reads `<agent dir>/bouncer.json` for
the route, and `.pi/extensions/bouncer/config.json` in the session's
working directory overrides it entry by entry. Both are plain JSON. The
project file sits under `.pi/extensions`, so Pi asks you to trust a project
that ships one, and the bouncer reads that trust once at session start
(`/trust` applies after a restart or `/reload`). An untrusted project's file
may only make a rule stricter, and no project file, trusted or not, may
loosen the always-deny set; only the route's file can. Each ignored entry is
named in the session-start warning. The old `.pi/bouncer.json` is no longer
read: the warning tells you to move it. `levels` sets any built-in
rule to `ask` or `deny`, except the unreadable-command denies and the `grep`
steer rule, whose level is fixed; the route's file also carries `log` (the
log's rotation size, generations kept and age pruning), `auto` (the judge list
`models`, `alwaysAsk` prefixes, `environment` facts, `firstByProvider` and
`jev`) and `startMode` (`off` or `auto`, see Modes).
`auto.jev` is an object that turns Jev on (see Modes). Its optional `allowAt`
and `denyAt` are numbers above 0.5 and at most 1; `denyAt` may also be
`null`. An absent `allowAt` defaults to 0.75, set from the Jev bench and
held-out run of 2026-10-01, and an absent `denyAt` defaults to `null`, so
`"jev": {}` lets Jev allow at a safe probability of 0.75 or more and never
deny. `allowAt` applies to the safe probability and `denyAt` to the deny
score. Jev denies only when the route sets `denyAt`; with `denyAt` `null` a
high deny score goes to the judge list. An invalid `auto.jev`
is a config problem and leaves Jev off; a project file's `auto` is ignored.
An invalid part falls back to its built-in value, and one warning lists every
problem. Without this file the built-in levels apply.

```json
{
  "levels": { "privilege": "ask" },
  "log": { "rotateAboveMiB": 5, "generations": 5, "maxAgeDays": 90 }
}
```

The `log` values shown are the defaults: rotate above 5 MiB, keep 5 gzipped
generations, prune anything older than 90 days. The scratch route's file holds
its judge list and asks Sonnet first on `anthropic` (`firstByProvider`).

## Log

One JSON line is appended to `<agent dir>/bouncer/log.jsonl` (or
`$PI_BOUNCER_LOG_DIR`) for each of these: a hard deny, a no-UI deny, each dialog
answer, a session-allow hit, a call YOLO mode allowed, a call auto mode decided,
every mode switch and every session start. Calls the bouncer lets through
untouched are not logged. The log rotates into gzipped generations within the
config's limits, and a write failure never changes a decision. The location
never depends on the bouncer config, so the `log` limits cannot move it.

## Commands and skills

| Command | What it does |
| --- | --- |
| `/auto [on\|off\|status]` | toggles auto mode, or reports why it cannot turn on |
| `/yolo [on\|off]` | toggles YOLO mode |

Two skills are bundled and load with the package:

| Skill | What it does |
| --- | --- |
| `auto-judge-list` | Researches current models, benchmarks them with live judge calls after you agree, and writes only the judge-list changes you accept |
| `bouncer-debug` | Explains why the bouncer blocked, asked about or let through a command, from the log and by replaying the command under the same config |

## Hooks

Hooks consumed: `session:launch`. A launcher emits it as `{ args, env }`
just before it starts a child Pi process; the bouncer appends `--auto` or
`--yolo` to `args` when that mode is on, and nothing when it is off. The
listener is synchronous and only appends: `args` and `env` are otherwise the
emitter's, and there is no veto. The bouncer provides no hooks and imports no
other extension.
