# Design notes

These notes record the evidence behind three of the bouncer's defaults: the
cutoffs Jev decides at, what a project's config may change, and the `grep`
steer rule. They are distilled from the original design notes, written
while the bouncer lived in its owner's dotfiles, and the code cites them where
a default would otherwise look arbitrary. Terms are those of `glossary.md`.
Dates are when the measurements were made (2026-10-01 for the Jev runs).

## Jev cutoffs

Jev answers five questions about a call in one request. Four short questions
(`effect`, `created`, `user_intent`, `risky_target`) are combined in code into
a deny score. Since 2026-10-03 Jev allows from 1 minus that score (see
[Allowing from the deny score](#allowing-from-the-deny-score) below); before,
it allowed from the safe probability of a fifth question, `safety`, which
`"allowFrom": "safety"` still selects. The measurements in the rest of this
section are of that older `safety` allow. The combination takes the strongest veto and
the strongest reason to think the call routine: the veto is the largest of the
probability that the effect is harmful, the probability that the user asked to
keep the target, and `risky_target`; the basis is the largest of the
probability that the effect is routine, `created`, and the probability that the
user asked for this. The deny score is one minus the smaller of the basis and
one minus the veto. Taking maxima rather than adding up small signals keeps
wrong denies from growing with every veto added.

`allowAt` is the allow score at or above which Jev allows the call.
`denyAt` is the deny score at or above which Jev denies it, or `null` for
never. Both must be above 0.5 and at most 1. A call that reaches neither
cutoff, or both, goes to the judge list, so a cutoff only decides how many
calls Jev settles on its own; everything else costs one judge-list call.

The cutoffs were measured through OpenCode Zen's `jev-1.13` only. Another
provider serving the same model (OpenRouter's `typesafe/jev-1.13`) should
answer alike, but `typesafe/jev-latest` may be a newer model; re-measure with
`bench.ts jev --model <provider/id>` before trusting the defaults there.

The cutoffs were measured with the bench in `skills/auto-judge-list/`:
`bench.ts` is the entry point, `jev-bench.ts` runs Jev's part, and
`heldout-cases.ts` holds the held-out set. The bench has 37 cases, each with
the verdicts that count as correct: 10 expect allow and 27 must not be
allowed. The held-out set has 123 cases, 63 expecting allow and 60 that must
not be allowed (28 labelled deny and 32 labelled ask). The held-out cases are
kept apart from the bench and are never used to pick a cutoff; the
report only checks the chosen pair against them. Each case is asked three
times, so the report also shows the spread between samples (up to 0.06 on a
single case in the final run). The run behind the defaults made 480 calls
(160 cases times 3 samples) with no errors and no rate limit, and took about
three minutes. Because zero errors in n cases only bounds the true error rate
near 3/n, the report prints a 95% upper bound next to every count.

Before the deny score existed, the `safety` question alone was benchmarked on
the 37 bench cases. At its recommended `allowAt` of 0.50 it allowed 8 of them
with no wrong allows, but it scored some routine
work (`git clean -X`, a force push to a feature branch) as unsafe, so any
`denyAt` wrongly denied safe work. Its best deny cutoff, 0.96, cleared the last
wrong deny by one hundredth. That is why the four deny questions were added.

With the deny score, the bench's highest deny score on a case that must not be
denied is 0.39 (`git clean -X`), and the lowest on a deny-first case is 0.90
(deleting a GitHub repository). The method for `denyAt` was the midpoint of
that gap, at least the bottom plus 0.1 plus the largest sample spread; that
gives 0.65. At 0.65 the bench has no wrong denies (0 of 10, upper bound 25.9%)
and denies 23 of 37 cases. The held-out set, however, has 2 wrong denies in 63
allow-expected cases (upper bound 9.7%): one scored 0.65 to 0.70 and the other
0.95, above the bench's whole gap. A hard deny stops the model with no dialog,
so the default is `denyAt` `null`: 0 of 63 wrong denies (upper bound 4.6%).
Jev then never denies unless the user config sets `denyAt`, and the judge list
or the user decides those calls.

For `allowAt`, a wrong allow runs the command quietly, while a call below the
cutoff costs one judge-list call, so the cutoff leans high. At 0.51 the bench
has 0 of 27 wrong allows (upper bound 10.5%) and allows 8 of 37, but the
held-out set has 1 of 60: a Vercel deploy that should ask, with safe
probability 0.62 to 0.68, and 49 of 123 allowed. The lowest cutoff with zero
held-out wrong allows is 0.69, which allows 4 of 37 bench cases and 40 of 123
held-out cases; it clears that deploy case by one hundredth while samples
spread by up to 0.06, and it was read off the held-out set, so its zero there
is no longer an independent check. At 0.75 both sets have zero wrong allows
(held-out upper bound 4.9%), with 3 of 37 bench cases and 36 of 123 held-out
cases allowed. So `allowAt` is 0.75, which clears the deploy case by more than
the per-case spread. The price is fewer calls settled by Jev: 36 against 49 of
the 123 held-out cases. No question was reworded and no case relabelled to
improve these numbers.

`denyAt` `null` still stands, and is one line in the user config's
`auto.jev` (`"denyAt": 0.65`) to change.

### Allowing from the deny score

TypeSafe's own guidance (summarised with sources in
`docs/research/jev-prompt-writing.md`) is to ask Jev narrow questions and
combine them in code, not one broad question; `safety` was the judge's whole
prompt with its options defined as "your verdict would be allow". So on
2026-10-03 the allow side was measured from 1 minus the deny score, with every
question's wording unchanged:

- Run 1, 480 calls, the bench and `heldout-cases.ts`: the bench alone picked
  `allowAt` 0.85, which held with no wrong allow on `heldout-cases.ts` and
  allowed 44 of its 123 cases, against 36 for `safety` at 0.75. (`safety`'s
  own bench-picked cutoff, 0.50, lets the Vercel deploy through.) The closest
  case that must not be allowed was the bench's `rm-tmp` at 0.84, and one
  case's samples spread by up to 0.12, so the default is 0.90 for margin.
- Run 2, 360 calls, `heldout-cases-3.ts`: 120 fresh cases, written blind by a
  session that had not seen Jev's questions. At the fixed cutoffs, 1 minus
  the deny score at 0.90 had no wrong allow in 60 (95% upper bound 4.9%) and
  allowed 34 of 120; `safety` at 0.75 also had none and allowed 32. The
  closest must-not-allow case scored 0.83.
- Run 3, 471 calls: a rewording of `effect` that counted `/tmp` deletions as
  shared moved the bench's `rm-tmp` from 0.84 to below 0.45, but it also
  dropped feature-branch force pushes below 0.90 and allowed 33 of the fresh
  120. It was not kept.

Both `heldout-cases.ts` and `heldout-cases-3.ts` have now informed a choice
(the 0.90 margin and the rejected rewording), so the next round of wording
needs a fresh held-out file. The near misses are all deletions of something
in `/tmp` or another shared place that already existed: the place to improve
is the wording for that, not the cutoff.

The code's summary in `src/auto-config.ts` agrees: `allowAt` 0.9 from the
deny score and `denyAt` `null`. `"allowFrom": "safety", "allowAt": 0.75`
restores the old allow.

**Caveat.** Every number here was measured through OpenCode Zen's SystemOne
endpoint, which is the only way the bouncer reaches Jev. A different path to
the same model, or a newer model version than `jev-1.13`, may be calibrated
differently. Re-measure with
`bench.ts jev` (see `skills/auto-judge-list/SKILL.md`) before trusting the
defaults elsewhere, and do not tune questions or cutoffs on the held-out set;
write fresh cases for each round.

## Project trust

A project can ship its own bouncer config at
`.pi/extensions/bouncer/config.json`, which overrides the user config's rule
levels entry by entry. Anything cloned into a repository is untrusted input, so
the rules are these.

- **Where the file lives.** The path is under `.pi/extensions` because Pi's
  list of project paths that need trust is fixed, and an extension cannot add
  to it. Pi's trust prompt appears for a folder holding that file, and a bare
  `.pi` directory, or the earlier path `.pi/bouncer.json`, would have read as
  trusted and never prompted. A file at the old path is not read; the bouncer
  reports a problem that names the new path. Only the session's working
  directory is checked, never a parent.
- **Trust is read once**, at session start, from Pi (`isProjectTrusted()` in
  `src/index.ts`). A `/trust` change applies at the next session start or
  `/reload`, so the effective policy stays settled for the session. The session
  record keeps whether the project was trusted.
- **Untrusted project.** Its entries may only make a rule stricter. An entry
  that would loosen a rule that is at deny after the user config is applied is
  ignored, and the session-start warning names it and says the project is not
  trusted.
- **Trusted project.** Its entries apply, except that none may set a rule in
  the always-deny set below deny. That is ignored with a warning, trusted or
  not. Trust is meant to let a user relax a rule such as a force push in a
  repository they control, and nothing more.
- **The user config** keeps full power over rule levels, because the user owns
  it; only the unreadable-command denies and the steer rules have fixed levels.
- **Keys only the user config sets.** A project file cannot set `log`, `auto`
  or `startMode`. That keeps a repository from turning on auto mode, changing
  Jev's cutoffs, or moving where requests go.

The code agrees with these rules (`src/project-config.ts`, `refusal()` and
`projectLevels()`, applied in `src/config.ts`). Two details are worth knowing.
The comparison for "loosen" is against the level after the user config, so an
untrusted project can restate a level without effect and no warning is made.
And the always-deny check comes first, so an untrusted project that tries to
loosen such a rule sees the always-deny message, not the trust one. The
original notes also planned replay flags for the `bouncer-debug` skill's
`explain.ts` (`--trusted` and `--untrusted`); that belongs to the skill, not to
this rule.

What is defended: a repository lowering any rule without the user's trust, and
lowering an always-deny rule even with it. What is not: a trusted project can
loosen rules outside the always-deny set, which is the point of trust, and
Pi saves a trust decision for a parent folder for its subfolders, so a clone
under a trusted parent is trusted. That is Pi's behaviour, not the bouncer's.
A repository's other files can still steer the model, which this rule cannot
help.

## The grep steer rule

The owner's agents kept reaching for `grep` when searching, although their
guidance said to use `rg`. `grep` is not dangerous, so no rule matched and the
call ran. The steer rule exists to stop every `grep`, `egrep` and `fgrep` the
scan finds, before it runs, and to tell the model to run the same search with
`rg`. That needed a new kind of rule, because the ordinary deny could not do
the job: its message tells the model not to retry and to hand the decision to
the user, which contradicts "use `rg`"; YOLO mode lets every rule outside the
always-deny set run; and each hard deny shows the user a warning, which is noise
for a tool preference that is not a safety event. So a steer rule denies in
every mode with no dialog, judge call or warning, does not count toward auto
mode's pause, and is written to the bouncer log so its frequency can be
counted. Its message says grep is not allowed, that nothing ran, and to run the
search with `rg`, with a one-line hint that `rg` is recursive and uses regex by
default (`-F` for a fixed string, `-n` for line numbers). Its level is deny or
off. A
real deny on the same line wins over it, and it wins over every ask, so the
model retries with `rg` and any ask comes back on the retry.

It blocks every grep, stdin filters included, because `rg` filters stdin the
same way and a partial rule would leave a gap. It does not cover `zgrep` and
its variants or `git grep`. Rewriting the command into an `rg` equivalent was
rejected, since grep's flags do not map reliably.

The scan sees `/usr/bin/grep`, `\grep`, `command grep`, `env grep`, `xargs
grep`, `bash -c 'grep x'` and `eval grep x` as an inner `grep`, but it does not
peel the commands in `find`'s and `fd`'s exec slots: `find . -exec grep x {} \;`
yields only `find`. So the rule reads those slots itself: the word after find's
`-exec`, `-execdir`, `-ok` or `-okdir`, and the command given to fd's `-x`,
`-X`, `--exec` or `--exec-batch` (also as a short cluster ending in `x`, and for
`fdfind`). Peeling them in the scan would change what every rule sees, so
custom rules read them instead (`hiddenArgvs` in `src/rules/hidden-exec.ts`).
A wrapper inside the slot, such as `find . -exec env grep`, is not covered.

Steering is a personal preference, and it breaks searching for anyone without
ripgrep, so the package ships no grep rule (`docs/plan.md`, decision D-1). The
rule is a custom steer rule, `examples/prefer-rg.json`, which the owner keeps
in their user config. The grep tests load that file, which also shows custom
rules can express what used to be a built-in rule.
