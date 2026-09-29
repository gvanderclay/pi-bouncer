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
