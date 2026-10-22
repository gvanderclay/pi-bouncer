# Review of the agent-made system prompt note

A review of the text the bouncer adds to the system prompt, written to the
rules of the `writing-for-agents` skill, and of the agent-made exemption it
describes. Nothing here is implemented yet; each change waits for approval.
The companion report on outside tools is `docs/research/safe-recursive-delete.md`.

## What is injected

- `AGENT_MADE_NOTE` (`src/agent-made.ts:32-33`) is the whole injection: one
  paragraph of about 150 words telling the agent how a recursive rm of a
  folder it made gets through without an ask.
- `noteAgentMade` (`src/index.ts:108-115`) adds it on `before_agent_start` as
  the `bouncer` prompt section, which Pi wraps in a `<bouncer>` tag. It is added
  on every run where bash is active, unless the bouncer config sets
  `"trustAgentMade": false`.
- `AGENT_MADE_HINT` (`src/gate.ts:134`) repeats the whole note in the block
  reason when no one can answer the ask, followed by "If this delete fits,
  run rm again that way."
- `src/agent-made.test.ts:932-934` pins the phrases `separate calls`,
  `mktemp -d` and `literal path`, and line 935 pins that the hint contains the
  note.

## What works

- A prompt section is the right place, not a guideline: a custom system
  prompt drops Pi's guidelines (comment at `src/index.ts:108`).
- The note is added only when it can apply: bash active and the exemption on.
- The `<bouncer>` tag labels it, so the model can tell it from other
  instructions.
- It tells the agent what it cannot see or guess: the folder must come from an
  earlier call, and the rm must be the only tool call in its message (the
  lone-call check, `src/index.ts:231-233`).
- The text is the same in every bouncer mode, so the system prompt prefix
  stays stable for prompt caching.

## Evidence from the bouncer log

`~/.pi/agent/bouncer/log.jsonl`, 2026-10-12 to 2026-10-22, no rotated files,
one agent dir. Each recursive rm that missed the exemption records why in
`agentMade[].reason`. Counted with
`jq -r 'select(.agentMade) | .agentMade[] | .reason' log.jsonl | sort | uniq -c`:

| Reason | Count | Typical command |
|---|---|---|
| `compound-command` | 70 | `rm -rf /tmp/t20-rr4 /tmp/t20-rr4-target; ls -d …; git -C /tmp/t20 status …` |
| `expansion` | 56 | `rm -rf /tmp/t20-rr2 && cp -r /tmp/t20 /tmp/t20-rr2 && … eval "$(… mise env)" …` |
| `sibling-tool-calls` | 44 | `rm -rf /tmp/ccb-cap.Sva7`, sent beside other tool calls |
| `untracked-or-preexisting` | 37 | `rm -rf /tmp/t23-rv-a` |
| `older-contents` | 10 | Unpacked package tarballs in `mktemp -d` folders (`…/package/src/…`), one disc image in `/tmp` |
| `tree-limit` | 1 | A build output tree under `~/workspace/wibo_test` |

The counts are per rm: 219 rms in 209 log entries, one with no reason
recorded. Of the 209 entries, 205 ended `allowed`, meaning someone answered
the ask, and four were blocked.

What it shows:

- About 170 of the 219 recorded misses (`compound-command`, `expansion`,
  `sibling-tool-calls`) are the agent breaking the delete step of the note's
  recipe: the rm shares its line, the line has a `$` anywhere, or other tool
  calls run beside it.
- Many `untracked-or-preexisting` misses come from one habit, resetting a
  scratch copy: `rm -rf /tmp/t23-rv-b; cp -r /tmp/t23 /tmp/t23-rv-b && cd …`.
  The `cp -r` shares its line, so the copy is never recorded, and the later
  rm of it finds nothing tracked. This is inferred from the commands, not
  traced case by case.
- Old-dated contents and the tree limit are rare: 11 misses together. The
  old-dated ones are archive extractions, not package installs; there are no
  pnpm cases.
- Within a session the habits repeat. With a user present the agent is never
  told why its rm needed an ask, so nothing corrects it (finding 5).

## Findings

### 1. Common cases fail without the note saying why (low; was medium)

The bouncer log shows these cases are rare (11 of 219 misses), so this
finding drops below finding 2.

`walkNewer` (`src/agent-made-check.ts`) rejects any entry whose modified time
or birth time is older than the folder (with `CLOCK_SLACK_MS`, 2 s, of
slack), and gives up after `WALK_LIMIT` (10,000) entries
(`src/agent-made.ts:36-39`). The note names only moved-in files and
date-preserving copies. These common cases also fail:

- A pnpm install on macOS. pnpm 11 imports by cloning first, then
  hardlinking, then copying (`safe-recursive-delete.md`, section 4). Checked
  here with pnpm 10.33.0 on APFS: `node_modules/unbash/package.json` is a
  clone with one link and the store's dates (Sep 27), older than the
  `node_modules` folder (Oct 13).
- `tar x` and `unzip`, which keep the archive's dates.
- Any real `node_modules`: this repo's has about 85,000 files, over the cap.

An npm install is not one of them for dates. npm packs archives with a fixed
1985 date, but pacote extracts with `noMtime: true`. Checked here: after
`npm install is-number` (npm 11.10.1) in a fresh `mktemp -d` folder, the
files have the install's dates and one link. npm installs fail only on the
tree limit.

The date check cannot be relaxed by timestamps alone. A move from another
disk is a copy plus a delete, so the only copy of the data arrives with a new
inode, a new birth time and an old modified time. An unpacked archive or an
install looks exactly the same on disk.

Options considered:

- **Raise the tree limit or make it a time limit.** Needed whatever else is
  chosen. Measure the walk on a real `node_modules` before picking the number.
- **Hardlink counting.** A regular file whose link count is higher than its
  occurrences in the deleted tree has another name outside it, so deleting
  the tree loses nothing. Trusts only the filesystem, but covers less than
  first thought: pnpm clones rather than hardlinks wherever the filesystem
  supports it (APFS, and btrfs or XFS with reflinks), so it helps only pnpm
  on filesystems without clones, such as ext4. It does not cover tar or
  unzip. No longer the first step; worth doing only if the bouncer log shows
  Linux pnpm failures. Its exploits are covered below.
- **Name allowlist** (`node_modules`, `.venv`, `target`, `__pycache__`).
  Simple and broad, but a name proves nothing: `mv ~/notes
  /tmp/agent-dir/node_modules/` would pass, and a prompt-injected agent can
  use the rule on purpose. Requiring the named folder to be born after the
  agent-made folder narrows it, but files moved in later still pass. Not
  recommended; if wanted, opt-in through config only.
- **Tracking the command that filled the folder.** An install, `tar x`,
  `unzip` or `git clone` into an agent-made folder would mark its output as
  copies whose originals still exist. Covers the most cases with the least
  trust in names, but adds a new piece of tracking with lasting cost.
  Deferred until the bouncer log shows `older-contents` failures from npm or
  archives often enough to justify it.
- **The trash.** When `trashCommand` is set, the block already suggests it
  (`src/gate.ts:136`). Every delete stays undoable, at the cost of one retry.
  The research ranks reversible removal as the best broad answer for archive
  trees and huge dependency trees. A same-user trash protects against
  mistakes, not against an agent that also empties the trash.
- **Isolated workspaces** (copy-on-write clones, OverlayFS, containers, as
  OpenHands does). Strongest protection for the user's original data, but a
  change to how the agent runs, far beyond this exemption.

No surveyed coding agent proves a delete is safe; they rely on sandbox
boundaries, approvals and checkpoints. No file metadata, marker
(`.modules.yaml`, `.package-lock.json`) or xattr says a tree can be
regenerated in a way the agent cannot forge.

Recommendation, after the research, the two checks above and the bouncer
log:

1. Rely on the trash suggestion for old-dated trees. The log's cases are
   archive extractions, which only the trash or command tracking would
   cover. Name the trash in the note's old-dates line when a trash command
   exists.
2. Raise the tree limit or make it a time limit, at low priority: it fixes
   npm installs, but the log has one tree-limit miss.
3. Drop hardlink counting for now: the log has no pnpm cases, and it would
   not cover the archive cases it does have. Revisit command tracking only
   if archive extractions grow.

The note's wording on old dates should wait for this decision.

#### Exploits of the hardlink check

- **Deleting the outside link on the same line (real exploit).** The check
  runs before the line does. `rm -rf /tmp/a /tmp/b`, with each agent-made
  folder holding a link to the same moved-in file, passes if each tree is
  counted alone; so does `rm /tmp/other/y && rm -rf /tmp/a`, because
  `HARMLESS` (`src/agent-made.ts`) lets a plain rm share the line. Fix: count
  inode occurrences across every operand of every rm on the line, or use the
  hardlink proof only when the line is one rm invocation. Both cases need a
  test.
- **A background job removing the link between check and delete.** The date
  check already has this race (a background job could move old files in), so
  this is not new. Out of scope.
- **Hiding data rather than losing it.** `mv ~/thesis /tmp/a/`, then
  `ln /tmp/a/thesis ~/.cache/zz`, then `rm -rf /tmp/a` passes; the thesis
  survives where the user would not look. Nothing is lost, and the harmful
  step is the mv, which the hardlink check does not change.
- **Implementation details.** Count regular files only: a directory's link
  count includes its subdirectories and `.`. Key occurrences on device plus
  inode. A filesystem reporting too few links only causes an ask; one
  reporting too many could pass wrongly, but none is known.

With the line-wide count and regular files only, the check is believed sound.
The research adds that identity must use device and inode at full precision
(Node's bigint stats), and that the proof should be limited to local
filesystems: FUSE, SMB and OverlayFS can report identities or link counts
that do not hold. A clone (one link, shared blocks) is never proof of
another copy. The diff should get a review focused on bypasses before it
merges.

### 2. The note is hard to follow (high; was medium)

The bouncer log shows the agent breaking the recipe in about 170 of 219
misses, so this is the main problem. One paragraph joins the conditions with
semicolons, so it reads as a list of conditions to check rather than a recipe
to follow. Ordered steps, each ending
on something checkable, would be clearer and shorter. Draft, keeping the old
dates line as it is until finding 1 is settled:

```
A recursive rm of a folder you made this session, or of something inside it, runs without asking the user when you:
1. Make the folder with a literal `mkdir -p /full/path`, or with `mktemp -d` or `cp -r <dir> <new path>` alone in the call (for mktemp, read the path it prints).
2. Keep anything older than the folder out of it: moved-in files and date-preserving copies keep their old dates.
3. Delete it with `rm -rf /full/path`, a literal path with no $VARIABLES, ~, wildcards or .. segments, as the only command in the call and the only tool call in its message.
Make, use and delete the folder in separate calls.
```

The draft keeps the phrases the tests pin. Shipping it costs one prompt cache
miss per session when the new text first loads.

The log's failures sharpen step 3. A `$` anywhere on the line fails the
check (`removalSafety`), not only in the path, so "no $VARIABLES" next to the
path undersells it; "the only command in the call" already covers it, and the
step could say so plainly ("nothing else in the call, not even a `cd`"). The
scratch-copy habit also argues for a sentence on recreating a folder: delete
it in one call, then `cp -r` it alone in the next.

Whether the rewrite changes behaviour is unknown until sessions run with it.
The bouncer log is the measure: compare the share of `compound-command`,
`expansion`, `sibling-tool-calls` and `untracked-or-preexisting` misses
before and after.

### 3. The relative-path sentence costs more than it gives (low)

In Pi each bash call starts in the session's working directory, and a `cd`
does not carry over, so "the working directory has not changed" rarely
applies. The sentence also leaves out the real limit: a relative path counts
only when its command is the only one on the line (`mkdirTargets` and
`targetOf`, which otherwise reject it as `relative-cwd-ambiguous`). Telling
the agent always to use a full path removes the sentence and the failure.

### 4. The doc comment is not true (low)

`src/agent-made.ts:27-31` says "Each condition is one the code checks". The
note is stricter than the code in three places:

- It says `rm -rf`; `isRecursiveRm` accepts any of `-r`, `-R` or
  `--recursive`, and `-f` is not needed.
- It says "only command on its line"; `HARMLESS` also allows `cd`, `echo`,
  `printf`, `true`, `ls`, `pwd` and other rms on the line.
- It forbids `..` segments; only relative paths reject them.

Being stricter does the agent no harm, so the comment should say the note is
a recipe at least as strict as the checks in `creationTargets`, `checkRms`
and the lone-call check.

### 5. The agent is never told which condition failed (medium; was low)

`AGENT_MADE_HINT` puts the whole note into the block reason, which stays in
the conversation, though the note is already in the system prompt whenever the
hint can appear (both depend on `trustAgentMade`). `agentMadeFor`
(`src/agent-made-check.ts`) already knows the first failing `AgentMadeReason`
and, for some, the path. Mapping each of the 11 reasons to one sentence
("Not exempt: `/tmp/x/foo` is older than the folder.") tells the agent what to
fix. This needs the diagnostics passed to `unanswered` (`src/gate.ts:156`)
and deliberate updates to the tests that pin the current hint.

With a user present the agent gets no reason at all: the user is asked, and
the agent never learns why its rm needed an ask. The log shows the cost: the
same habits repeat through a session, and someone answered over 200 asks in
ten days. A one-line reason added to the result of an rm that needed an ask
("This rm needed an ask: it shared its line with other commands.") would
correct the agent mid-session. It is paid per event, and only on calls
that already asked. Not designed yet; weigh it with the block-reason change.

### 6. Leaving the note out in YOLO mode (withdrawn)

In YOLO mode a recursive rm never asks, so the note buys nothing there.
Dropping it per mode would change the system prompt on every mode switch and
cost a full prompt cache miss each time, more than the roughly 200 tokens it
saves per turn. The note stays the same in every bouncer mode.

## Planned changes

Change 1 shipped in the pull request that added this review; the line
numbers above describe the code before it. The others wait for approval.

1. Rewrite the note as ordered steps, with the sharper delete step and the
   recreate sentence (findings 2 and 3), and correct the doc comment
   (finding 4), in `src/agent-made.ts`. One small pull request. This targets
   most of the logged misses.
2. Tell the agent which condition failed (finding 5): in the block reason,
   and possibly in the result of an rm that needed an ask. Its own pull
   request, because it changes how a decision is passed through the gate.
3. After 1 and 2 have run for a while, recount the bouncer log. Then decide
   on the tree limit and the note's old-dates line (finding 1). Hardlink
   counting is dropped for now.

Each pull request gets a `CHANGELOG.md` entry under `## [Unreleased]`.

## Not done

- No session was run with the old and new text. A real check would run tasks
  such as an npm install into a temp folder and a relative `mkdir`, and
  compare how often the bouncer asks.
- The tree-limit walk was not timed on a real `node_modules`.
- The bouncer log covers ten days of one agent dir. Other agent dirs and
  older periods were not read, and asks answered by a user cannot be told
  apart from those answered in auto mode by the counts above.
