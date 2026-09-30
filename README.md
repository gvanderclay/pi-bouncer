# bouncer

Guards the model's `bash` tool with a short, fixed list of rules. The npm
package is `pi-bouncer`.

Every command is parsed with `unbash` and checked wherever the danger hides —
chains, pipelines, `$(…)`, wrappers such as `env`/`timeout`/`xargs`,
`bash -c`/`eval`, paths and quoting. Recoverable-if-intended actions open a
dialog that names the rule and quotes the command: recursive `rm`,
`find -delete`/`-exec`, `fd -x`, `rg --pre`, work-losing git (`clean -f`,
`reset --hard`, `checkout --`, `restore`, `stash drop`), forced or deleting
pushes, downloads piped into a shell, package publishing, and `gh repo`
deletion. Catastrophic or unreadable actions are denied with no dialog and a
warning: `sudo`/`su`/`doas`, shutdown, disk formatting, `dd` to a device, a
recursive `rm` of `/`, a system directory, `~` or an important folder in it,
and commands that cannot be parsed. A deny anywhere on a line wins. Each
rule's level is built in and can be changed in the bouncer config.

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
| auto | `/auto`, `/auto on\|off\|status`, `pi --auto` | every ask no session allow covers goes to the first model of the bouncer config's judge list that answers; an allow runs quietly, a deny blocks with the judge's one-line reason, and a hand-off or no answer opens the dialog. Three judge denies in a row, or 20 in a session, pause it until you allow a call. It refuses to turn on when no list entry resolves |
| YOLO | `/yolo`, `/yolo on\|off`, `pi --yolo` | every ask is allowed with no dialog or judge. The always-deny set and unreadable commands still deny |

`--auto` with `--yolo` is an error. A dialog can also switch to either mode
after allowing the current line.

In auto mode each judge-list entry gets 10 s, and a line gets 20 s in total.
`auto.firstByProvider` names the entry to ask first for the session model's
provider. The judge sees the command, the flagged rules, the working
directory, the git branch and remotes, your last message and the route's
`auto.environment` facts. It never sees tool output. A model that refuses the
request under its provider's usage policy counts as a deny. Rule-level denies,
the always-deny set and unparseable commands are denied before any judge is
asked, and `auto.alwaysAsk` prefixes always open the dialog.

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
`!` commands are never gated.

## Configuration

At every session start the bouncer reads `<agent dir>/bouncer.json` for
the route, and `.pi/bouncer.json` in the session's working directory
overrides it entry by entry. Both are plain JSON. `levels` sets any built-in
rule to `ask` or `deny`; the route's file also carries `log` (the log's
rotation size, generations kept and age pruning) and `auto` (the judge list
`models`, `alwaysAsk` prefixes, `environment` facts and `firstByProvider`).
An invalid part falls back to its built-in value, and one warning lists every
problem. Without this file the built-in levels apply.

## Log

Every call the bouncer does more than let through, every mode switch and every
session start appends one JSON line to `<agent dir>/bouncer/log.jsonl`
(or `$PI_BOUNCER_LOG_DIR`). The log rotates into gzipped generations
within the config's limits, and a write failure never changes a decision. The
location never depends on the bouncer config.

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
