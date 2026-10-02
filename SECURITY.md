# Security

The bouncer is a guard rail against accidents, not a sandbox. This page says
which problems count as security bugs and how to report them.

## Reporting a bypass

Report privately through GitHub:
[open a security advisory](https://github.com/gvanderclay/pi-bouncer/security/advisories/new).
Do not open a public issue for a bypass. Include the exact command, your
config files if you have any, and what `/bouncer explain <command>` prints
for it.

## In scope

- A command that a rule should catch, but that runs without a dialog or
  deny because of how it is written: quoting, wrappers, chains,
  substitutions, `bash -c`, `eval`, path tricks or anything else the parser
  or rules miss. A bypass of the always-deny set, or of the deny for commands
  that cannot be parsed, matters most.
- A project config file that loosens a rule when the project is untrusted, or
  that loosens the always-deny set at all.
- YOLO or auto mode allowing a command from the always-deny set, a command
  that cannot be parsed, or a steer rule's match.
- The bouncer allowing a command after it crashes or fails to load, instead of
  denying it.

## Out of scope

- A judge model or Jev being talked into allowing a command in auto mode.
  Auto mode trusts the models you choose, and a model's answer is not a
  security boundary.
- Commands the bouncer has no rule for. Asking for a new rule is welcome as a
  regular issue.
- Anything outside the `bash` tool: Pi's `write` and `edit` tools, `!`
  commands, and Windows `powershell` are not gated.
- Running commands you allowed in a dialog, or anything allowed in YOLO mode
  that is not listed in scope above.
