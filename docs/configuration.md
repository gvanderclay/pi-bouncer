# Configuration

The bouncer works with no config file. This page lists every key the config
files accept. Words such as "agent dir" and "steer rule" are defined in
[the glossary](glossary.md).

## Files and precedence

At every session start the bouncer reads two files, both plain JSON:

- The user config, `<agent dir>/bouncer.json`. The agent dir is Pi's config
  directory: `~/.pi/agent`, or `$PI_CODING_AGENT_DIR` when set.
- The project file, `.pi/extensions/bouncer/config.json` in the session's
  working directory. It overrides the user config entry by entry.

Because the project file sits under `.pi/extensions`, Pi asks you to trust a
project that ships one. The bouncer reads that trust once per session start,
so `/trust` applies after a restart or `/reload`. What a project file may do:

- An untrusted project may only make things stricter: raise a level, add
  `protect` paths, and add ask or deny custom rules. It may not lower a level
  or add a steer rule, because steer text is sent to the model.
- A trusted project may also lower levels and turn rules off.
- No project file, trusted or not, may loosen the always-deny set, or set
  `log`, `auto` or `startMode`; only the user config can. The one exception
  is a profile's `mode`: a trusted project's profile may set `"off"` or
  `"auto"`, an untrusted one only `"off"`.
- A project rule may not reuse the name of a user rule.
- A project file's `profiles` and `agents` follow the same rules. An
  untrusted project's profile only tightens, and its `agents` entry applies
  only to an agent the user config does not map, naming a profile the user
  config does not define. A trusted project's `agents` entry overrides the
  user's. See [`profiles`](#profiles) and [`agents`](#agents).

An entry the bouncer refuses or cannot read falls back to its built-in value.
One warning at session start lists every problem, and `/bouncer check`
re-reads both files and lists them again without applying anything. The old
project path `.pi/bouncer.json` is no longer read; the warning says to move
it.

## `$schema`

Either file may set `"$schema"` to the JSON Schema, for completion and checks
in your editor. `/bouncer init` writes it for you.

```json
{
  "$schema": "https://raw.githubusercontent.com/gvanderclay/pi-bouncer/main/schema/bouncer.schema.json"
}
```

## `levels`

`levels` maps a built-in rule name to `"ask"`, `"deny"` or `"off"`. `off`
removes the rule. The always-deny set (`rm-root`, `disk-format`, `dd-device`,
`power`, `privilege`) accepts `ask` or `deny` but never `off`, and YOLO and
auto mode deny it whatever its level. The unreadable-command denies
(`parser-unavailable`, `unparseable`, `inline-too-deep`) cannot be set.
`/bouncer rules` lists every rule name.

```json
{ "levels": { "git-push-force": "deny", "opaque-exec": "off" } }
```

## `protect`

`protect` adds paths to `rm-root`, so a recursive `rm` of them is denied.
`home` names folders below your home directory (relative, no `~`); `paths`
are absolute, and anything directly inside one is protected too. It only
adds: the built-in paths always stay, so an untrusted project's `protect`
applies as well.

```json
{ "protect": { "home": ["code"], "paths": ["/srv/data"] } }
```

This denies a recursive `rm` of `~/code`, of `/srv/data`, and of anything
directly in `/srv/data`.

## `trustAgentMade`

`true`, the default, lets a recursive `rm` of a folder the agent made earlier
in the session run without an ask; [How the bouncer decides](behaviour.md#folders-the-agent-made)
says exactly which folders count. `false` asks for every recursive `rm`, as
before. Either the user config or a project file can set `false`, and then
neither can turn it back on.

```json
{ "trustAgentMade": false }
```

## `rules`

`rules` is a list of custom rules. Each one has:

- `name`: lowercase, and not the name of a built-in rule.
- `command`: a program name, or a list of them. `/usr/bin/kubectl` matches
  `kubectl`.
- `args` (optional): arguments that must all follow the command, in order,
  with anything between them.
- `summary`: what the command does, shown in the dialog and the log.
- `level` (optional): `"ask"` (the default), `"deny"` or `"off"`.
- `instead` (optional): text that makes it a steer rule. The bouncer denies
  the command in every mode and sends this text to the model. A steer rule's
  level is `"deny"` or `"off"`.

```json
{
  "rules": [
    {
      "name": "kubectl-delete",
      "command": "kubectl",
      "args": ["delete"],
      "level": "deny",
      "summary": "deletes cluster resources"
    }
  ]
}
```

This denies `kubectl -n prod delete pod x`, and also finds it behind
wrappers, in chains, inside `sh -c`, and in the commands `find -exec` and
`fd -x` run. Custom rules behave like built-in ones in every mode: YOLO allows
an ask or deny custom rule, and auto mode sends its asks to the judge.
[`examples/prefer-rg.json`](../examples/prefer-rg.json) is a steer rule that
sends the model from `grep` to `rg`.

## `log`

`log` sets the log's limits; only the user config may set it. `rotateAboveMiB`
(default 5) is the size at which the log rotates, `generations` (default 5) is
how many gzipped generations to keep, and `maxAgeDays` (no default) deletes
generations older than that many days. The log's location never depends on
the config; see [Log](../README.md#log-and-debugging).

```json
{ "log": { "rotateAboveMiB": 5, "generations": 5, "maxAgeDays": 90 } }
```

## `startMode`

`"auto"` starts every Pi process in auto mode without `--auto`. `"off"`, the
default, starts in normal mode. It applies at the process's first session
start only, refuses as `/auto` does when no judge-list entry resolves, and
gives way to `--yolo` or `--auto`. `"yolo"` is not accepted: YOLO mode starts
only from `pi --yolo` or `/yolo`. Only the user config may set it. A
session's [profile](#profiles) with a `mode` replaces it.

## `profiles`

A profile is a named group of rule changes. It starts from the session's
normal rules (the user config and the project file with no profile) and
changes only what it names. Its keys are `levels`, `rules` and `protect`,
checked exactly like the top-level keys of the same name, and `mode`, which
is `"off"` or `"auto"`. A profile name is lowercase letters, digits and
dashes. `"yolo"` is not accepted as a `mode`.

```json
{
  "profiles": {
    "readonly": {
      "levels": { "recursive-rm": "deny", "publish": "deny" },
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
  }
}
```

How a profile applies:

- `levels` replace the normal level rule by rule. A profile in the user
  config may loosen as well as tighten, but the always-deny set can be `ask`
  and never `off`, and YOLO and auto mode deny it whatever its level.
- A `rules` entry named like a normal custom rule replaces it in place, so a
  profile can change its level or turn it off. Any other entry is added after
  the normal custom rules. Steer rules still go last.
- `protect` adds to the normal paths.
- `mode` replaces `startMode`, but only when the session has no `--auto` or
  `--yolo`. A session whose parent runs in YOLO or auto mode gets that flag
  from the bouncer's launch listener and so starts in that mode. A launcher
  that does not emit `session:launch` passes no flag, so its child starts in
  its profile's `mode` whatever its parent's mode is. The same listener sets
  the child's agent name (`PI_BOUNCER_AGENT`): the child's own agent when it
  has a working profile, else the parent's when the parent runs a profile. A
  blank existing `PI_BOUNCER_AGENT` counts as unset. With `"auto"` and no
  resolvable judge-list entry the session stays off with the usual notice.

A project file may define profiles too, and its definition of a name is laid
over the user config's. An untrusted project can only tighten: its levels may
only be raised, it may not add steer rules, and its `mode` may be only
`"off"`. A trusted project may also lower levels and set `"off"` or
`"auto"`. Every problem in either file is reported at session start and by
`/bouncer check`, whether or not the session uses the profile.

A profile is **broken** when neither file defines it or the user config's
definition has any problem. A broken profile is ignored whole: the session
runs the normal rules and the warning names the profile. A project
definition with a problem is dropped whole, so a project cannot switch off a
user's profile by writing a broken one.

## `agents`

`agents` maps an agent name to a profile name. The agent name is read once, at
session start, from the first of these environment variables that is set and
not blank: `PI_BOUNCER_AGENT`, `PI_SUBAGENT_AGENT`
(HazAT/pi-interactive-subagents), `PI_DADDY_DEFINITION` (pi-daddy). With no
agent name the session runs the normal rules, as it always has.

```json
{ "agents": { "scout": "readonly", "builder": "worker" } }
```

An entry naming a profile neither file defines is a problem. An agent with no
entry is unmapped and runs the normal rules. The project file's entry
overrides the user config's for a trusted project; an untrusted project's
entry stands only for an agent the user config does not map, to a profile the
user config does not define, so the profile is wholly the project's and only
tightens.

`PI_BOUNCER_AGENT=orchestrator pi` starts a top-level session in the
`orchestrator` agent's profile. `/bouncer status` shows the profile, and the
log records it. A profile is chosen by the agent name only; the
`bouncer-escape` rule keeps the model from setting or clearing these
variables in bash.

Known limit: an inherited `PI_BOUNCER_AGENT` outranks a launcher's own
variable. When a parent started with `PI_BOUNCER_AGENT=orchestrator` launches
a child through a launcher that copies its environment and sets
`PI_SUBAGENT_AGENT=scout`, the child still reads `orchestrator`, because
`PI_BOUNCER_AGENT` comes first. A later subagent library compatibility pass
(issue #8) is to fix this.

## `auto`

`auto` configures auto mode; only the user config may set it. Without it, auto
mode cannot turn on. [How auto mode decides](behaviour.md#auto-mode) explains
what the judge sees.

- `models` (required): the judge list, as Pi `provider/id` model names, in
  the order to ask them. Entries without credentials in Pi are skipped. The
  `auto-judge-list` skill can pick them for you.
- `firstByProvider`: maps a provider to a judge-list entry to ask first when
  the session's model is from that provider. The entry must be in `models`.
- `alwaysAsk`: command prefixes, such as `"git push"`, that always open the
  dialog in auto mode instead of going to the judge.
- `environment`: short facts about your machine given to the judge, such as
  `"macOS, Homebrew in /opt/homebrew"`.
- `jev`: an object that turns on Jev, a classifier asked before the judge
  list. See below.

```json
{
  "auto": {
    "models": ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-5-5"],
    "firstByProvider": { "anthropic": "anthropic/claude-haiku-4-5" },
    "alwaysAsk": ["git push"]
  }
}
```

### `auto.jev`

`"jev": {}` turns Jev on with its defaults. Its keys are:

- `allowAt` (default 0.75): Jev allows a call when its safe probability is
  at or above this. A number above 0.5 and at most 1.
- `denyAt` (default `null`): Jev denies a call when its deny score is at or
  above this. The same range, or `null` for never.
- `model`: the Pi classifier model as `provider/id`, called with Pi's own
  credentials. For example `openrouter/typesafe/jev-1.13`
  (`OPENROUTER_API_KEY`) or `typesafe/jev-latest` (`TYPESAFE_API_KEY`). Without
  it, Jev is OpenCode Zen's `jev-1.13`, called with the `opencode-go` key Pi
  holds. A provider Pi does not know can be added with a Pi extension that
  registers a classifier model.

The defaults were measured through OpenCode Zen only;
[the design notes](design-notes.md#jev-cutoffs) give the evidence. An invalid
`auto.jev` is a config problem and leaves Jev off.
