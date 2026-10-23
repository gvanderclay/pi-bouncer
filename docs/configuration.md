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

- An untrusted project may only make things stricter: raise a level (each
  direction of a path group separately), add `protect` paths, and add ask or
  deny custom rules. It may not lower a level, set a path direction to
  `"allow"`, add a path rule that allows, or add a steer rule, because steer
  text is sent to the model. Its path rules are raise-only: they never take
  part in last-match-wins, so its `ask` rule cannot turn an earlier deny into
  an ask; it only makes the result stricter.
- A trusted project may also lower levels, turn rules off, and add path
  rules that allow; its path rules follow the user's in last-match-wins.
- No project file, trusted or not, may loosen the always-deny set, or set
  `log`, `auto`, `mcp` or `startMode`; only the user config can. The one exception
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
`power`, `privilege`, `path-bouncer`) accepts `ask` or `deny` but never `off`,
and YOLO and auto mode deny it whatever its level. The unreadable-command
denies (`parser-unavailable`, `unparseable`, `inline-too-deep`) cannot be set.
`/bouncer rules` lists every rule name.

```json
{ "levels": { "git-push-force": "deny", "opaque-exec": "off" } }
```

### Path groups

The `path-` rules are path groups. They decide Pi's file tools (`read`,
`write`, `edit`, `grep`, `find` and `ls`) by the path a call touches, with
one level for reading and searching and another for writing and editing.
Both take `"allow"`, `"ask"`, `"deny"` or `"off"`.

A plain level sets both directions. An object sets the directions it names
and leaves the other at the group's built-in level, so `{ "read": "allow" }`
on `path-env` allows reading a `.env` and still asks before writing one. The
empty object, an unknown key and an unknown group name are all problems, and
the group keeps its built-in levels.

```json
{
  "levels": {
    "path-git": "ask",
    "path-env": { "read": "allow" },
    "path-ssh": { "read": "deny", "write": "ask" }
  }
}
```

`path-git` as `"ask"` makes a read of `.git/config` ask, because a plain
level sets both directions. `path-ssh`'s `"read": "deny"` keeps `~/.ssh`
closed while `"write": "ask"` lets the dialog decide a write.

| Group | Matches | Built-in read | Built-in write |
| --- | --- | --- | --- |
| `path-bouncer` | `<agent dir>/bouncer.json`, any `.pi/extensions/bouncer/config.json`, the folder the bouncer was loaded from, `<agent dir>/settings.json`, any `.pi/settings.json` | allow | deny |
| `path-system` | `/etc`, `/usr`, `/bin`, `/sbin`, `/opt`, `/System`, `/Library`, `/Applications`, `/boot`, `/lib`, `/lib64`, `/srv`, `/dev`, `/proc`, `/sys`, `/snap`, `/nix`, `/private/etc` and everything in them | allow | ask |
| `path-git` | any `.git` folder | allow | ask |
| `path-shell-rc` | `.zshrc`, `.zshenv`, `.zprofile`, `.bashrc`, `.bash_profile`, `.bash_login`, `.profile`, `~/.config/fish/config.fish` | allow | ask |
| `path-keys` | `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*` anywhere on disk, except `*.pub` | deny | deny |
| `path-ssh` | `~/.ssh` | deny | deny |
| `path-gnupg` | `~/.gnupg` | deny | deny |
| `path-aws` | `~/.aws` | deny | deny |
| `path-gcloud` | `~/.config/gcloud` | deny | deny |
| `path-azure` | `~/.azure` | deny | deny |
| `path-kube` | `~/.kube` | deny | deny |
| `path-docker` | `~/.docker/config.json` | deny | deny |
| `path-pi-auth` | `<agent dir>/auth.json` | deny | deny |
| `path-env` | `.env*` at any depth, except `.env.example`, `.env.sample` and `.env.template` | deny | ask |
| `path-npmrc` | `.npmrc` at any depth | deny | ask |
| `path-pypirc` | `.pypirc` at any depth | deny | ask |
| `path-netrc` | `.netrc` at any depth | deny | ask |
| `path-git-credentials` | `.git-credentials` at any depth | deny | ask |

The groups run broad to narrow and the last match wins, so
`~/.ssh/id_ed25519` is decided by `path-ssh` rather than by `path-keys`.
`path-bouncer` is checked first, outside that order, and only for writes: it
takes `ask` or `deny` for writing, never `off`, and has no read level, since
reads stay allowed. Under `pi -e <checkout>` its code folder is that checkout,
so a session running a checkout cannot write the checkout's source unless
`path-bouncer` is `ask`.

A project file may only raise a direction: an untrusted project's `"allow"`,
or an entry that would leave any direction looser than the level the session
already had, is a problem and the whole entry is refused, so the group keeps
the levels it had. A direction the project leaves out is checked too, since
the entry replaces the session's and an omitted direction falls back to the
group's built-in level. A trusted project may set any
level, except on `path-bouncer`, which no project file may loosen. A
profile's `levels` take path groups the same way, with the same checks when
the profile is in a project file, and its object replaces the whole entry for
that group. `/bouncer rules` shows one level per group: the stricter of its
two directions.

## `protect`

`protect` adds paths to `rm-root` and `trash-root`, so a recursive `rm` of
them, or moving them to the trash, is denied.
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
in the session (with `mkdir`, `mktemp -d` or a recursive `cp`) run without an
ask; [How the bouncer decides](behaviour.md#folders-the-agent-made) says
exactly which folders count. `false` asks for every recursive `rm`, as
before. Either the user config or a project file can set `false`, and then
neither can turn it back on.

```json
{ "trustAgentMade": false }
```

## `trashCommand`

When no one can answer a dialog, a refused recursive `rm` suggests moving the
target to the trash. The bouncer suggests the first of `trash` (built into
macOS), `trash-put` ([trash-cli](https://github.com/andreafrancia/trash-cli))
and `gio trash` it finds on `PATH` at session start, and none if it finds
none. `trashCommand` names the program to suggest instead: one name or path,
with no spaces. `trash-root` also denies it moving a protected folder. Only
the user config may set it.

```json
{ "trashCommand": "/opt/bin/mytrash" }
```

## `rules`

`rules` is a list of custom rules. A rule has `command` (a bash rule) or
`paths` (a path rule, see [Path rules](#path-rules)), never both. Each one
has:

- `name`: lowercase, not the name of a built-in rule, and not starting with
  `path-`, which is kept for path groups.
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

### Path rules

A rule with `paths` in place of `command` decides Pi's file tools, as the
[path groups](#path-groups) do. `paths` is a list of gitignore-style globs:
`*` and `?` within one folder name, `**` across folders, and no `!`. A
pattern starting with `/` is absolute, one starting with `~/` is in your home
folder, one with no `/` is a file name at any depth (`**` alone matches every
path), and any other is relative to the working directory. A pattern that
does not compile is a problem, and the rule is dropped.

`level` takes `"allow"`, `"ask"` (the default), `"deny"` or `"off"`, or an
object with `read` and/or `write`; a direction the object leaves out is off,
so the rule never decides it. With `instead` the rule is a steer: its level
is `"deny"` or `"off"`, and a match denies in every mode with that text.
`args` is for bash rules only.

The built-in groups come first, then the user config's path rules, then the
project file's, then the profile's, each file in list order, and the last
rule that matches decides. So a later rule makes an exception to an earlier
one. A delegate that may write only to its docs folder:

```json
{
  "profiles": {
    "docs": {
      "rules": [
        {
          "name": "no-writes",
          "paths": ["**"],
          "level": { "write": "deny" },
          "summary": "this agent writes only to docs"
        },
        {
          "name": "docs-only",
          "paths": ["/home/me/project/docs/**"],
          "level": { "write": "allow" },
          "summary": "the docs folder"
        }
      ]
    }
  },
  "agents": { "writer": "docs" }
}
```

An `allow` overrides the built-in groups inside its folder too: a rule
allowing `**/.git/hooks/**` lets a hook be written without the `path-git`
ask, and an `allow` for `~/**` would open `~/.ssh`. Add a later rule to
restore a group inside it. Two things no rule overrides: `path-bouncer`,
which is checked before every other path rule, and a search (`grep`, `find`,
`ls`) of a folder that holds a protected path, which the strictest rule
inside it decides. A path rule written through a symlinked folder also
matches the same files by their real path.

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

- `levels` replace the normal level rule by rule, including a path group's
  directions: an object replaces the whole entry for that group. A profile in
  the user config may loosen as well as tighten, but the always-deny set can be
  `ask` and never `off`, and YOLO and auto mode deny it whatever its level.
- A `rules` entry named like a normal custom rule replaces it in place, so a
  profile can change its level or turn it off. Any other entry is added after
  the normal custom rules. Bash steer rules still go last.
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
only be raised, direction by direction, it may not set a path direction to
`"allow"` or add a path rule that allows, its path rules are raise-only, it
may not add steer rules, and its `mode` may be only `"off"`. A
trusted project may also lower levels and set `"off"` or `"auto"`. Every problem in either file is reported at session start and by
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

## `mcp`

MCP tool calls, named `mcp__<server>__<tool>` by Pi, are gated apart from
bash: a call to a tool on `mcp.allow` runs, and any other MCP call opens the
dialog with the tool name and its arguments (cut to 200 characters). Allow
for this session covers that tool whatever its arguments. Calls a codemode
script makes are gated the same way; the `codemode` call itself is not. Only
the user config may set `mcp`.

- `judge`: `false` makes auto mode open the dialog for an MCP call not on
  `allow` instead of asking the judge. Default `true`.
- `allow`: tool names, each starting with `mcp__`. `*` matches any
  characters, so `mcp__github__*` allows a whole server. Pi writes every
  character other than letters, digits and `_` as `_` in a tool name, and an
  entry is read the same way: `mcp__dev-radius__*` matches
  `mcp__dev_radius__deploy`. When two of a server's tools collide, Pi adds a
  hash suffix; end the entry with `*` to cover it.

With no UI (print, JSON or RPC mode with no dialogs) a call not on the list
is blocked. YOLO mode allows it. In auto mode the judge list rules on it as
on a bash ask, with Jev skipped: an allow runs it quietly, a deny blocks it,
and a hand-off or no answer opens the dialog. Paused auto mode and session
allows work as for bash, and MCP denies count toward the pause. The judge
gets the tool name, the server's description of the tool (cut to 2,000
characters) and the whole arguments, so these go to the providers of the
judge-list models; set `"judge": false` to keep them away. A call too big
for every judge model opens the dialog. Put chatty read-only servers on
`allow` so they are not judged at all. A server's tool annotations, such as
`readOnlyHint`, are its own unverified claims: they never allow a call and
are not shown to the judge.

```json
{ "mcp": { "allow": ["mcp__docs__*", "mcp__github__search_code"] } }
```

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

- `allowAt` (default 0.9): Jev allows a call when its allow score is at or
  above this. A number above 0.5 and at most 1.
- `allowFrom` (default `"deny-score"`): the allow score is 1 minus the deny
  score. `"safety"` makes it the probability from Jev's `safety` question
  instead. `"allowFrom": "safety", "allowAt": 0.75` is the old default.
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
