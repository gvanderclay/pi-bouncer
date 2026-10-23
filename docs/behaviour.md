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

## Folders the agent made

A recursive `rm` runs without an ask, in every mode and with or without a
UI, when everything it deletes is a folder the agent made earlier in the same
session, or something inside one. A folder counts as made by the agent when:

- a `mkdir` that finished without error created it, and nothing was at that
  path just before the command ran (for `mkdir -p`, the highest folder that
  was missing counts);
- a command that was only `mktemp -d` printed its path;
- or a command that was only `cp -r src dest` (also `-R`, `--recursive`,
  `gcp`, and `--`) finished without error, `src` is a real directory (not a
  symlink, with or without a trailing `/` or `/.`), and nothing, not even a
  dangling symlink, was at `dest` just before it ran. Copying into a folder
  that already existed never makes what was in it eligible. Other `cp`
  options, several sources, chains and a `cp` followed or masked by anything
  (`cp -r a b || true`, `! cp -r a b`) count for nothing.

Paths may be written in full from `/`, or, when the command is on its own
line, relative to the working directory the call ran in (`scratch`,
`./scratch`, `nested/dir`, quoted names with spaces, `-- ./-x`). A relative
path is resolved against that call's working directory before the command
runs; a `..` segment is never accepted, because resolving a symlink and then
`..` can differ from what the filesystem does.

Even then, the `rm` still asks unless all of these hold:

- it is plain `rm`, not run through a wrapper such as `xargs`, `timeout` or
  `bash -c`, and has no `NAME=value` prefix;
- nothing else on the line could add to the folder: every other command is
  `rm`, `cd`, `echo`, `printf`, `true`, `ls` or `pwd`, and the line has no
  `$` or backtick at all (an expansion can run a hidden command), so
  `mv x /tmp/made/ && rm -rf /tmp/made` asks;
- it is the only tool call in the agent's message, because Pi checks every
  call in a message before running any of them;
- every path is a literal, with no variable, `~`, wildcard, brace or escape;
- a relative path needs more: the `rm` must be the whole line (no `cd`,
  assignment, wrapper, substitution, redirect, pipe, `&`, `!`, second
  command or control flow), and the call's working directory must be known;
- every path, with symlinks followed, lies inside the folder, so
  `rm -rf /tmp/x/link/` of a link out of it asks;
- nothing inside is dated before the folder was made, so a file moved in
  from elsewhere makes it ask again (moving keeps a file's dates). Unpacking
  an archive or copying with dates kept (`cp -p`, `rsync -a`) asks for the
  same reason, and so does a tree of more than 10,000 items, counted across
  all the paths of one `rm`.

At the start of each run with the `bash` tool on, the bouncer adds a short
`<bouncer>` section to the system prompt that tells the agent how: make the
folder in one call, work in others, and delete it with a direct literal `rm`
as the only tool call in a later message.

`rm-root` and every other rule still apply. The bouncer forgets a folder
once it is deleted or replaced, and forgets them all at every session start.

When the exemption does not apply to a recursive `rm`, the call's log record
carries an `agentMade` list, one entry per recursive `rm`, each with its
`source`, `eligible` and its `targets` (`operand`, the resolved `path`, and
`eligible`). Each failed target or call has a `reason`: `disabled`,
`sibling-tool-calls`, `expansion`, `wrapper`, `compound-command`,
`relative-cwd-ambiguous`, `nonliteral-path`, `untracked-or-preexisting`,
`older-contents`, `tree-limit` or `filesystem-failure`; `at` names the item
behind the last three. `untracked-or-preexisting` means the bouncer has no
record that this session made the folder: it may have existed, been made
another way, failed to be made, or been forgotten at a session start. It
explains only the exemption: the dialog, a session allow, a judge or YOLO
mode may still have allowed the command. A call whose cleanup was exempt
leaves no record at all, and a record without `agentMade` means unknown, not
eligible.

The check cannot tell who put a file in the folder, only when. Any file
created or changed after the folder was made, whoever made it, can be
deleted without an ask, including one you or another program put in the
folder, or one made since then elsewhere and moved in. So can files a
background command is still moving in when the `rm` runs. A `mkdir` that
failed on a line that still succeeded (`mkdir /tmp/x; true`) counts as having
made the folder, and on a filesystem that reuses inode numbers and records
no creation time, a folder deleted and remade between two of the agent's
commands can still count. The check is a guard rail, not a sandbox, and a
race between the check and the `rm` is not covered.

When an ask on a recursive `rm` blocks because no one can answer, the reason
repeats the `<bouncer>` section and tells the agent to retry if the delete
fits it, and, when a trash program is found (see
[`trashCommand`](configuration.md#trashcommand)), to move anything else, or a
folder whose retry is blocked too, to the trash, where the deletion can be
undone.
`trash-root` denies moving `/`, a system directory, your home directory or a
protected folder to the trash. `"trustAgentMade": false` turns off the
agent-made folders, their system prompt section and the retry advice, and
restores ordinary recursive-`rm` handling, but not the trash advice (see
[configuration](configuration.md#trustagentmade)). `/bouncer` commands
and `bouncer-debug` replays do not know which folders the agent made.

## Which decision wins

One line can match several rules. A deny anywhere on the line wins over
everything, and the model is told not to work around it. A steer rule's
match wins over every ask: the line gets the steer block, with no dialog and
no warning, however many asks it holds. Otherwise each ask is decided in
turn, and a denied ask stops the line.

## File tools

Pi's `read`, `write`, `edit`, `grep`, `find` and `ls` tools are gated by
path rules, the same way bash commands are gated by command rules: the policy
holds both, and a path rule is set in `levels` and shown by `/bouncer` like
any other. `grep`, `find` and `ls` count as reading what they search.

A file access has a **direction**: `read` reads, and `write` and `edit` write.
A path rule has a level for each direction, so the same `.env` file can be
denied to read and asked about to write. The built-in **path groups** ship
these levels, in evaluation order; the last one that matches decides, so they
run from the broad folder groups to the narrow secret ones:

| group | covers | read | write |
| --- | --- | --- | --- |
| `path-system` | `/etc`, `/usr`, `/bin`, `/sbin`, `/opt`, `/System`, `/Library`, `/Applications`, `/boot`, `/lib`, `/lib64`, `/srv`, `/dev`, `/proc`, `/sys`, `/snap`, `/nix` and `/private/etc` | allow | ask |
| `path-git` | `**/.git/**` | allow | ask |
| `path-shell-rc` | `.zshrc`, `.zshenv`, `.zprofile`, `.bashrc`, `.bash_profile`, `.bash_login`, `.profile`, `~/.config/fish/config.fish` | allow | ask |
| `path-keys` | `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*` (not `*.pub`), at any depth | deny | deny |
| `path-ssh` | `~/.ssh/**` | deny | deny |
| `path-gnupg` | `~/.gnupg/**` | deny | deny |
| `path-aws` | `~/.aws/**` | deny | deny |
| `path-gcloud` | `~/.config/gcloud/**` | deny | deny |
| `path-azure` | `~/.azure/**` | deny | deny |
| `path-kube` | `~/.kube/**` | deny | deny |
| `path-docker` | `~/.docker/config.json` | deny | deny |
| `path-pi-auth` | `<agent dir>/auth.json` | deny | deny |
| `path-env` | `.env*`, except `.env.example`, `.env.sample` and `.env.template` | deny | ask |
| `path-npmrc` | `.npmrc` | deny | ask |
| `path-pypirc` | `.pypirc` | deny | ask |
| `path-netrc` | `.netrc` | deny | ask |
| `path-git-credentials` | `.git-credentials` | deny | ask |

`path-bouncer` stands outside that order and is checked first, for writes
only, so no later path rule decides a path it covers:

| group | covers | read | write |
| --- | --- | --- | --- |
| `path-bouncer` ✱ | `<agent dir>/bouncer.json`, `**/.pi/extensions/bouncer/config.json`, the folder the bouncer was loaded from, `<agent dir>/settings.json`, `**/.pi/settings.json` | allow | deny |

When the agent dir's `bouncer.json`, `settings.json` or `auth.json`, or the
session project's `.pi/settings.json` or `.pi/extensions/bouncer/config.json`,
is a symlink, the file it points to is covered too, as Pi and the bouncer read
that file.

✱ `path-bouncer` is in the always-deny set: its write level is `ask` or
`deny`, never `off`, and YOLO and auto mode deny the write whatever its
level, with no judge asked. A `levels` line sets only its write level; reads
stay allowed, so the bouncer's config can still be read for debugging. The
folder the bouncer was loaded from is the checkout itself under
`pi -e <checkout>`, so a session running a checkout cannot write that
checkout's source: develop the bouncer from a session that loads another
copy, or set `"levels": {"path-bouncer": "ask"}`.

A pattern with no slash, such as `*.pem` or `.npmrc`, matches that name in
any folder. `~` anchors at home and a leading `/` at the root. A leading
`**/` matches in any folder on disk, so `path-git` catches a `.git` folder
outside the session's working directory too. `path-system` has its own list
of folders; it leaves out `/Users`, `/home`, `/var`, `/tmp` and
`/private/var`, so ordinary work in the home folder and in a temporary
folder never asks.

A path is checked in every spelling: as the agent typed it, made absolute
(`@` stripped, `~` expanded), and with symlinks resolved, plus the extra
names Pi's `read` tries on macOS when the typed name does not exist. Among
the path rules that match one spelling, the last in the effective policy
decides; across the spellings of one path, the strictest result wins, so a
symlink into `~/.ssh` is caught even when the link's own spelling is innocent.
The agent dir of the running session is the one matched for `path-pi-auth`
and `path-bouncer`.

A deny blocks the call and tells the model the rule, its summary and the
path. An ask opens the dialog, and with no UI it is blocked with a reason
saying no one could answer it. In auto mode the judge list decides an ask
first (see "Auto mode"). YOLO mode lets a path ask or deny through, as
it does for bash, except a `path-bouncer` write. Session allows, `levels` and profiles work for path rules
as they do for command rules.

### Search scope

`grep`, `find` and `ls` reveal what they search, not only the folder they
name, so they are decided as a read of that folder: `path-ssh` denies
`grep token ~` and `ls ~/.ssh`, and a home folder holds enough secret folders
that `find /` is denied too. An omitted `path` is the session's working
directory.

A path rule also fires when its pattern is anchored (`~` or `/`) and its
fixed leading folders lie inside the search path, so searching a home folder
reaches `~/.ssh`, and searching `/` reaches every absolute pattern. Patterns
with no slash, which match at any depth, are tested only against the search
path itself, so a `grep` with no path in a project that holds a `.env` stays
quiet. The rules that match the search path itself follow last-match-wins as
usual; the rules found inside it combine with that result by strictest first,
so no `allow`, built in or the user's, unblocks a search of a folder that
holds a secret group. The deny names the search path: "The read of `~` did
not run." A `.env` that isn't gitignored can still appear in a `grep` result;
Pi's own tools skip gitignored files, which is what keeps an ordinary project
search quiet.

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

A file call's dialog names the tool and the path in place of the command
line, and shows the change below it. When the typed path led somewhere else,
such as through a symlink, the real target follows an arrow:

```text
Bouncer: a .git folder holds the repository's config, hooks and history (rule: path-git)
write link/config → /work/real/.git/config
new file
core = true
```

An `edit` shows each piece of old and new text as `-` and `+` lines, and a
`write` to an existing file shows the lines that change. The detail is cut to
2,000 characters. For a file call, "Allow for this session" covers that exact
real path in that direction and nothing else: allowing a write to
`.git/config` does not allow a write to `.git/hooks/pre-commit`.

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

A judge-list entry whose context window cannot fit the request is skipped
without being sent anything; the estimate is the system prompt plus the
input, at four characters per token, plus the 2,000-token reply cap and a
4,096-token margin. When no entry fits, the dialog says the command, an
MCP call's arguments, or a file call's change are too large for the judge
instead of "no judge available".

An MCP call not on `mcp.allow` is judged like an ask, without Jev, unless
`mcp.judge` is `false`; its judge denies share the pause with bash.

A file call that a path rule asks about is judged the same way, without Jev,
and its judge denies share the pause too. A judge allow runs that one call; it
never adds a session allow. A `path-bouncer` write is denied before any judge
is asked, as is any path rule set to `deny`.

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
and the `auto.environment` facts. It never sees tool output, the contents of
files the agent reads, or the agent's own messages; a write or edit's own
change is the one exception, below. Literal closing tags inside any of
these are escaped. All of this is sent to the providers of the models in the
judge list.

For an MCP call the judge sees the tool name, the server's description of the
tool (cut to 2,000 characters), the whole arguments as JSON and the same
context in place of the command. The description and arguments go to the
providers of the judge-list models.

For a file call the judge sees, in place of the command, the tool, the
direction, the real path after symlinks, and the change: the whole content of
a `write`, or each old and new text of an `edit`. A `read`, `grep`, `find` or
`ls` has no change. When the path is in any secret group (`path-keys`,
`path-ssh`, `path-gnupg`, `path-aws`, `path-gcloud`, `path-azure`,
`path-kube`, `path-docker`, `path-pi-auth`, `path-env`, `path-npmrc`,
`path-pypirc`, `path-netrc` or `path-git-credentials`), whichever group
decided the call and whatever their levels, the change is left out and the
judge is told it was redacted, so a write to `.env` or to `.git/.env` sends
no content. The change goes to the providers of the judge-list models.

The session history is the bouncer's own record of what the agent ran: every
bash command Pi executed, with its working directory, the absolute path
of every `write` and `edit`, and the name of every MCP tool called, never its
arguments or result. It is recorded when a tool returns, so blocked,
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

- Four short questions (what kind of change the command makes, whether the
  agent created its target, what the user asked for, and whether it deletes
  a risky target) give a deny score, combined in code. The strongest reason
  to refuse (harmful, asked to keep, risky target) caps the strongest reason
  to allow (routine, created, asked for).
- The allow score is 1 minus the deny score. With `"allowFrom": "safety"` it
  is instead the safe probability from the `safety` question, built from the
  judge's own criteria.

An allow score at or above `allowAt` runs the line quietly with no
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
