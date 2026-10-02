# Glossary

The words the bouncer's code, messages, tests and docs use, and the words they
avoid. Moved from the owner's dotfiles, where "route" meant a Pi agent dir.
Here the **agent dir** is Pi's own config directory (`~/.pi/agent` unless
`PI_CODING_AGENT_DIR` says otherwise), and the **user config** is the
bouncer config file in it.

**Bouncer**:
The Pi extension that judges every bash command the model runs: it allows it,
asks the user, or denies it.
_Avoid_: permission gate, permission system, guard

**Rule level**:
What the bouncer does when a rule matches: **ask** (the user decides in a
dialog) or **deny** (a **hard deny**, with no dialog). A config may also set
**off**, which leaves the rule out of the effective policy. The built-in
policy assigns it, not the rule; the bouncer config may change it for any rule
except the unreadable-command denies, and may not turn the always-deny set
off. A steer rule is deny or off.
_Avoid_: severity, mode

**Built-in rule**:
A rule that ships with the bouncer and recognises one kind of dangerous
command by reading its parsed invocations.
_Avoid_: default rule, catalog rule

**Steer rule**:
A rule that blocks a command the model should replace with another, and tells
the model what to run instead. It denies in every bouncer mode, with no
dialog, judge call or warning. A real deny on the same line wins over it; it
wins over every ask. Steer rules are custom rules with an `instead` text;
none is built in. The `examples/prefer-rg.json` recipe makes `grep` one, sending
the model to `rg`.
_Avoid_: soft deny, redirect, nudge

**Custom rule**:
A rule the user defines under `rules` in the bouncer config: a program name
plus arguments that must all appear in order, with a rule level, or with an
`instead` text that makes it a steer rule.
_Avoid_: user rule, pattern, extra rule

**Built-in policy**:
Every built-in rule and unreadable-command deny, in evaluation
order, each at the rule level the bouncer ships with.
_Avoid_: catalog, defaults

**Effective policy**:
The rules a session's bouncer enforces, in evaluation order, each at its rule
level: the built-in policy with the bouncer config and the session's profile
applied, then the custom rules, with custom steer rules last; settled at
session start. A rule set to
off is not in it. The unreadable-command denies are always in it, at deny.
_Avoid_: session policy, rulebook, levels

**Profile**:
A named group of rule changes under `profiles` in the bouncer config. It
starts from the session's normal rules and changes only what it names: rule
levels, custom rules, `protect` paths and the start mode.
_Avoid_: permission set, role, preset

**Agent name**:
The name a launcher gives the session it starts, read from `PI_BOUNCER_AGENT`
or a launcher's own variable. The `agents` map turns it into a profile.
_Avoid_: role, subagent type

**Normal rules**:
The effective policy the user config and the project file give with no
profile: what a profile starts from, and what a session with no agent name,
an unmapped agent or a broken profile runs.
_Avoid_: base rules, default rules

**Unreadable-command deny**:
A hard deny for a command the bouncer could not read (unparseable, nested too
deep, or no parser). Its level is fixed; no config can make it ask.
_Avoid_: scan failure, parse deny

**YOLO mode**:
A process-wide switch that makes the bouncer answer every ask with allow, with
or without a UI, except for the always-deny set, the unreadable-command denies
and the steer rules. It is turned on by `/yolo`, the "Allow all (YOLO)" dialog
choice or `pi --yolo`, and lasts until turned off or until the process exits.
It is kept only in memory and survives session starts and `/reload`.
_Avoid_: skip permissions; auto mode is a different bouncer mode

**Bouncer mode**:
The bouncer's process-wide setting: off (normal), **auto mode** or **YOLO
mode**. Turning one mode on leaves the other.
_Avoid_: permission mode, level

**Auto mode**:
The bouncer mode in which a judge rules on every ask that no session allow
covers. Rule-level denies, the always-deny set, the unreadable-command denies
and the steer rules stay denied. It is turned on by `/auto`, the "🤖 Auto
mode" dialog choice or `pi --auto`, only when an entry of the judge list
resolves, and has YOLO mode's lifetime.
_Avoid_: auto-approve, classifier mode

**Judge**:
The model that rules on an auto-mode call: it answers allow, deny with a
reason, or hand to the user. It sees the command, the uncovered asks, a few
facts, the user's latest message and up to 10 earlier ones, and the session
history: the bouncer's own record of the bash commands the agent ran and the
paths it wrote or edited this session. It never sees tool output, file
contents or the agent's own messages.
_Avoid_: reviewer, classifier

**Judge list**:
The priority list `auto.models` of `provider/id` entries in the user config.
The judge is the first entry that answers; there is no default list in code.
The user config may name, per provider of the session's model, one entry of
the list to ask first (`auto.firstByProvider`); the rest follow in list order.
_Avoid_: model list, fallback list

**Jev**:
The classifier (TypeSafe's `jev-1.13`, reached through OpenCode Zen) auto mode
asks before the judge list when the user config has `auto.jev`. It sees what
the judge sees and answers five questions in one call, which give two numbers:
a safe probability from its `safety` question, used only to allow, and a deny
score combined in code from four short questions, used only to deny. It
decides only above its cutoffs: a safe probability at or above `allowAt`
allows the call; a deny score at or above `denyAt`, unless `denyAt` is `null`,
denies it in the ordinary hard-deny form with a reason that names no judge,
and the deny counts toward auto mode's pause like a judge's; anything else,
including both cutoffs reached, or a failed call, goes to the judge list. It
is not an entry of the judge list and cannot turn auto mode on.
_Avoid_: classifier mode, reviewer, first judge

**Auto-mode ruling**:
How auto mode answers one line's uncovered asks: Jev first when the user
config has `auto.jev`, then the judge list in judge order, all within the
line's one 20 s budget. Its answer is allow, deny, hand to the user, or no
answer, together with what Jev said and every judge-list entry given up on.
_Avoid_: judge pipeline, Jev-then-judge

**Always-deny set**:
The built-in rules YOLO mode still denies: `privilege`, `power`,
`disk-format`, `dd-device` and `rm-root`. Which rules it holds is fixed in
code, so no config can shrink or grow it, and YOLO and auto mode deny them
whatever the bouncer config's levels say. In normal mode only the user config
can lower one's level: a project config entry that tries is ignored with a
warning, whether or not the project is trusted.
_Avoid_: deny list, hard list

**Bouncer config**:
The user-editable settings for rule levels, custom rules and bouncer log
limits: the user config (`bouncer.json` in the agent dir), optionally
overridden entry by entry by one file in the project
(`.pi/extensions/bouncer/config.json`), except log limits, auto mode and the
start mode, which only the user config sets. The project file loosens a rule
only when Pi trusted the project at session start, and never the always-deny
set. A project file at the old path `.pi/bouncer.json` is not read; the
bouncer reports it as a problem that names the new path. A missing or
invalid part falls back to the built-in policy, and the
bouncer log never depends on it.
_Avoid_: settings, policy file

**Session allow**:
A user's "Allow for this session" answer, remembered in memory for the exact
command, working directory, rule and matched invocation until the next
session start.
_Avoid_: always allow, whitelist, trust

**Bouncer log**:
The agent dir's own append-only record of every command its bouncer did not
simply let through: hard denies, no-UI denies, each dialog answer, and
session-allow hits. A command that matched no rule is never in it; the
session file already holds it.
_Avoid_: audit log, detailed log, history
