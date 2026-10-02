# pi-bouncer

Guards Pi's bash tool: asks before destructive commands, blocks catastrophic
ones, with an optional model-judged auto mode.

Every command the model runs through `bash` is parsed and checked, including
inside chains, `$(…)`, wrappers such as `env` or `xargs`, and `bash -c`.
Recoverable mistakes, such as `rm -rf build` or `git reset --hard`, open a
dialog. Catastrophic ones, such as `sudo`, `rm -rf ~` or formatting a disk,
are denied outright.

The bouncer is a guard rail against accidents, not a sandbox. A determined or
prompt-injected model can find commands it does not recognise, and Pi's
`write` and `edit` tools are not gated. For real isolation, run Pi in a
container or virtual machine, as
[Pi's security guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)
describes.

## Install

Install the package from npm:

```bash
pi install npm:pi-bouncer
```

To follow the latest commit instead, install it from GitHub:

```bash
pi install git:github.com/gvanderclay/pi-bouncer
```

Pi installs the bash parser, `unbash`, with the package. A local checkout is
not installed for you, so run `npm install` in it once; without the parser,
the bouncer denies every `bash` call and says so.

## Quick start

Start Pi. With no config file, the first session shows "Bouncer is on: it
asks before destructive bash commands. /bouncer shows rules and config." The
built-in rules apply, and an ask opens a dialog such as:

```text
Bouncer: recursive rm deletes whole directory trees (rule: recursive-rm)
rm -rf build
```

You can allow it once or for the session, deny it (optionally with a reason
for the model), or deny and stop the turn. `/bouncer` shows the mode, the
config files, every rule's level and the log path, and
`/bouncer explain <command>` shows what the bouncer would do with a command
without running it. `/bouncer init` writes an empty config file to
`~/.pi/agent/bouncer.json`.

To let a model decide asks for you, add a judge list to that file and run
`/auto`:

```json
{
  "auto": { "models": ["anthropic/claude-haiku-4-5"] }
}
```

Any model Pi has credentials for works. Read [Auto mode](#auto-mode) first:
it sends your commands and messages to that model's provider.

## Modes

| Mode | Turn it on | What happens to an ask |
| --- | --- | --- |
| normal | the default | a dialog opens |
| auto | `/auto`, `pi --auto`, or `"startMode": "auto"` | a judge model allows it, denies it, or hands it to the dialog |
| YOLO | `/yolo` or `pi --yolo` | it is allowed |

Auto mode never overrides a deny. YOLO mode allows rules set to deny as well,
but neither mode ever allows the always-deny set (marked below), a command
that cannot be parsed, or a steer rule. The mode lasts until the Pi process
ends, and the footer shows auto or YOLO while it is on.

## Rules

Each rule has a level: `ask` opens the dialog, `deny` blocks with no dialog.

| Rule | Level | Catches |
| --- | --- | --- |
| `rm-root` ✱ | deny | recursive `rm` of `/`, a system directory, `~`, or a folder such as `~/Documents` or `~/.ssh` |
| `privilege` ✱ | deny | `sudo`, `su`, `doas` |
| `power` ✱ | deny | shutdown and reboot |
| `disk-format` ✱ | deny | formatting, erasing or repartitioning a disk |
| `dd-device` ✱ | deny | `dd` writing to a `/dev` path |
| `recursive-rm` | ask | any other recursive `rm` |
| `find-delete` | ask | `find -delete` |
| `find-exec` | ask | `find -exec`, `-execdir`, `-ok`, `-okdir` |
| `fd-exec` | ask | `fd -x`, `fd -X` |
| `rg-pre` | ask | `rg --pre` |
| `opaque-exec` | ask | `parallel`, `rush`, `rust-parallel` |
| `git-clean` | ask | `git clean -f` |
| `git-reset-hard` | ask | `git reset --hard` |
| `git-checkout-discard` | ask | `git checkout -- <path>`, `git checkout .`, `git checkout -f` |
| `git-restore-worktree` | ask | `git restore` of the working tree |
| `git-stash-destroy` | ask | `git stash drop`, `git stash clear` |
| `git-push-force` | ask | force and mirror pushes |
| `git-push-delete` | ask | pushes that delete or prune remote branches and tags |
| `remote-script` | ask | a download piped into a shell, such as `curl … \| sh` |
| `publish` | ask | publishing a package, such as `npm publish` |
| `gh-delete` | ask | deleting a GitHub repository or release |
| `bouncer-escape` | deny | `pi --yolo`, or setting or clearing an agent variable |

✱ The always-deny set: its level can be `ask` or `deny` but never `off`.
Every other rule can also be `off`. Commands that cannot be parsed are
always denied. A deny anywhere on a line wins over every ask.

## Configuration

The user config is `~/.pi/agent/bouncer.json` (Pi's agent dir, or
`$PI_CODING_AGENT_DIR`). A project can add `.pi/extensions/bouncer/config.json`,
which Pi asks you to trust; an untrusted project may only make rules
stricter. This config raises a level, turns a rule off, protects one more
folder from `rm -rf`, and adds a rule of your own:

```json
{
  "$schema": "https://raw.githubusercontent.com/gvanderclay/pi-bouncer/main/schema/bouncer.schema.json",
  "levels": { "git-push-force": "deny", "opaque-exec": "off" },
  "protect": { "home": ["code"] },
  "rules": [
    {
      "name": "kubectl-delete",
      "command": "kubectl",
      "args": ["delete"],
      "summary": "deletes cluster resources"
    }
  ]
}
```

A custom rule with an `instead` text is a steer rule: it blocks a command in
every mode and tells the model what to run instead.
[`examples/prefer-rg.json`](examples/prefer-rg.json) sends the model from
`grep` to `rg`. [The configuration reference](docs/configuration.md) lists
every key, and [`examples/`](examples/) has a minimal config, auto mode with
Anthropic or OpenRouter, and a project file.

## Auto mode

Auto mode needs a judge list, `auto.models`, in the user config. Each ask
goes to the first model in the list that answers; it allows or denies the
command, or hands it to the dialog. Each judged ask costs a model call, or
more when an entry fails to answer.
Three denies in a row, or 20 in a session, pause auto mode until you allow a
call. The `auto-judge-list` skill researches and benchmarks models and
writes the list for you.

Privacy: for each ask, auto mode sends the judge's provider the command, the
working directory, the git branch and remotes, your recent messages, and the
list of commands and file writes the agent made this session. It never sends
tool output or file contents.

Optionally, `"jev": {}` under `auto` asks Jev, TypeSafe's command
classifier, before the judge list. A confident "safe" answer runs the command
without a judge call. By default Jev runs through OpenCode Zen with Pi's
`opencode-go` key; `auto.jev.model` can pick another provider, such as
`openrouter/typesafe/jev-1.13`.

[How the bouncer decides](docs/behaviour.md) covers the judge's exact input,
time limits, Jev's cutoffs and the dialog in full.

## Commands and skills

| Command | What it does |
| --- | --- |
| `/bouncer [status]` | shows the mode, config files and problems, project trust, rule levels, the log path and auto mode |
| `/bouncer rules` | lists every rule with its level and what it catches |
| `/bouncer explain <command>` | shows what the bouncer would do with a command, without running it |
| `/bouncer init` | writes an empty user config with `$schema`, if none exists |
| `/bouncer check` | re-reads both config files and lists their problems |
| `/auto [on\|off\|status]` | toggles auto mode, or says why it cannot turn on |
| `/yolo [on\|off]` | toggles YOLO mode |

The package also loads two skills. `auto-judge-list` builds or refreshes the
judge list, and `bouncer-debug` explains why a command was blocked, asked
about or let through.

## Log and debugging

The bouncer appends one JSON line to `~/.pi/agent/bouncer/log.jsonl` (or
`$PI_BOUNCER_LOG_DIR/log.jsonl`) for every deny, dialog answer, auto-mode
decision, mode switch and session start. Commands it lets through untouched
are not logged. Ask the agent why something was blocked and the
`bouncer-debug` skill reads the log and replays the command.

## Integrations

A launcher extension can emit the `session:launch` event as `{ args, env }`
just before it starts a child Pi process. The bouncer appends `--auto` or
`--yolo` to `args` when that mode is on, so the child starts in the same
mode. It changes nothing else and cannot veto the launch.

## Compatibility and limitations

- Pi 1.0 or later, on Node 22.19 or later. On a Pi without project trust the
  bouncer warns and treats every project as untrusted.
- macOS and Linux. Only the `bash` tool is gated: Windows `powershell`,
  `!` commands you type, and Pi's `write` and `edit` tools are not.
- Without a UI (print, JSON or RPC mode with no dialogs), every ask denies.
- A usage-policy refusal counts as a judge deny only for providers that
  report it, such as Anthropic.

## More

[The glossary](docs/glossary.md) defines the words the bouncer uses, and
[the design notes](docs/design-notes.md) record the evidence behind its
defaults. [CHANGELOG.md](CHANGELOG.md) lists changes, and
[SECURITY.md](SECURITY.md) says how to report a bypass.

## License

[MIT](LICENSE)
