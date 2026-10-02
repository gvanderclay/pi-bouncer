# How permission/guard tools tell the agent how to avoid prompts and blocks

**Question.** Do permission/guard tools for AI coding agents put standing
guidance in the system prompt or tool descriptions (sent every request), add
just-in-time notes to tool output, or explain only in the denial message? Does
any of them treat files or folders the agent itself created (temp dirs, `mkdir`,
`mktemp`) as safe to delete without asking? The decision it feeds: how
pi-bouncer should teach the agent that `rm -rf` of a folder the agent made this
session, written out in full (no `$VAR`, `~`, globs), runs without asking. The
options are (a) always-on guidance (`promptGuidelines` / system prompt), (b) a
one-line note appended to the output of the `mkdir` / `mktemp -d` call naming
the exact path, (c) the refusal message only.

**Short answer.**

- Nobody surveyed does (b) for this purpose. No project appends a "you may
  delete this" note to the output of the call that created the path. The only
  just-in-time channel found is Claude Code's hook API, which lets a user write
  such a hook; Claude Code itself does not ship one for this.
- The two mature tools that mention agent-owned temp space both use **standing
  guidance (a)**: Claude Code's system prompt says "files you created yourself
  this session ... are yours to clean up freely", and its Bash tool description
  steers temp files to `$TMPDIR` / `mktemp -d`; opencode's shell tool description
  names a pre-approved tmp dir. Codex's prompt goes the other way: it tells the
  model that `rm` the user did not ask for needs escalation.
- **Denial messages (c)** are universal and the better ones say how to retry.
  Claude Code's critical-path `rm` check says how to rewrite the command
  (literal path, `${DIR:?}` guard); Codex says "rm -f style commands are not
  permitted. Use a safer approach"; gotgenes and opencode state the rule and an
  operator-written reason only.
- Tracking "created by the agent this session" as a permission input exists in
  Claude Code's auto-mode classifier ("Deleting the exact jobs Claude created
  earlier in the same session" is allowed; "Irreversibly destroying files that
  existed before the session" is blocked). No project found does it as a
  deterministic rule on `rm` of created folders; the check there is a model.
- The evidence favours **(a) plus (c)**: one short standing sentence, and a
  refusal that names the exact rewrite. (b) has no precedent and is the most
  fragile of the three; add it only if measurement shows (a)+(c) is not enough.
  Reasoning at the end.

## Sources and versions checked

Date: 2026-10-02 (UTC). Everything below was fetched that day.

| Project | Source | Version / commit |
| :- | :- | :- |
| `@gotgenes/pi-permission-system` | npm tarball (`npm pack`) | 38.0.1; repo `gotgenes/pi-packages`, `packages/pi-permission-system` |
| `@gotgenes/pi-subagents` | npm tarball | 21.9.3 |
| Claude Code docs | `https://code.claude.com/docs/en/{permission-modes,sandboxing,permissions,hooks,auto-mode-config}.md` | live docs; mentions versions up to v2.1.283 |
| Claude Code prompts | `Piebald-AI/claude-code-system-prompts`, `system-prompts/` | commit `42962c339106c8bcc9dd477af5724fce66aa9dc5` (changelog head 2.1.288) |
| Codex CLI | `openai/codex` | `12a30d4e6dbd7e527898142b6f4f65fd8070a3b5` |
| opencode | `sst/opencode` | `108b988a08227df45417f27905a4d6b27ad49b6d` |
| Gemini CLI | `google-gemini/gemini-cli` | `fb972b2f87fe7d5b06d37eac711490162d98de2c` |
| Cline | `cline/cline` | `476b165b97aaafb47ee8a82b093f25d5611395d9` |
| Roo Code | `RooCodeInc/Roo-Code` | `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16` (committed 2026-05-15, so possibly stale) |

Source quality: Claude Code's docs are primary. Claude Code's **prompt text** is
not published by Anthropic; Piebald extracts it from the shipped bundle, so it
is near-primary, and each file carries a `ccVersion` header. Claim text from
those files is labelled "(Piebald extract)". Codex, opencode, Gemini, Cline and
Roo claims are source code at the commits above. The two gotgenes packages were
read from the tarballs, paths relative to the unpacked `package/` directory.

## 1. `@gotgenes/pi-permission-system` (38.0.1)

**Does not put "how to avoid a prompt" guidance in the system prompt; does not
modify tool results; explains only in the denial message.**

- **System prompt: only tool-surface changes, no avoidance guidance.** The one
  `before_agent_start` handler (`src/index.ts:394`, handler in
  `src/handlers/before-agent-start.ts`) narrows the active tool set
  (`:118`), writes `<tools>` and `<rules>` sections only for a subagent child
  under a custom prompt (`:128-140`, `isSubagentUnderCustomPrompt` at `:171`),
  and removes denied skills from the catalogue (`:155`). It never returns a
  rewritten prompt; the docs state this as a rule
  (`docs/configuration.md:1357`, "Every change this extension makes to the system
  prompt goes through pi's `systemPromptOptions`"). The `<rules>` it writes for a
  child are the allowed tools' own `promptGuidelines` re-rendered
  (`src/exposure/tool-surface-prompt.ts:9-34`), not permission advice. On a
  custom root prompt it adds nothing (`docs/configuration.md:1362`).
- **Tool descriptions: untouched.** It registers no tools of its own. It only
  removes fully denied tools from the active set.
- **Tool results: untouched.** The registered Pi hooks are `session_start`,
  `resources_discover`, `session_shutdown`, `before_agent_start`, `input`,
  `tool_call` (`src/index.ts:387-405`). `rg tool_result` over the package finds
  nothing. So no just-in-time notes.
- **Denial message: states the verdict and the rule, and carries an
  operator-written reason.** `src/presentation/agent-renderer.ts:19-38` sets the
  design rule: "The agent renderer identifies the call; it does not reproduce
  it." The sentences are, for example, `[pi-permission-system] Denied by policy:
  'bash' ... (rule 'npm *')` (`:114-123`) and `The user denied this ...`
  (`:126-135`). The command text is deliberately never echoed (`:32`, `:276-281`).
  Corrective guidance exists only when the operator writes it:
  `{"action":"deny","reason":"Use pnpm instead"}` is "appended to the block
  message shown to the agent, so it learns why the command was denied and what to
  do instead" (`docs/configuration.md:489-510`). A registered "link" can return
  a deny with "an optional teaching reason" (`docs/configuration.md:299-300`),
  and the shipped example judge "auto-denies mistyped paths with a corrective
  reason" (`docs/configuration.md:344`). One denial text tells the agent that a
  tool failure is worth surfacing, not working around: "a failure is worth
  surfacing to the operator, where a denial is worth working around"
  (`src/presentation/agent-renderer.ts:202-206`).
- **Agent-created paths: no concept.** The only built-in path exemptions are
  `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`
  (`src/path/safe-system-paths.ts:5-10`) and Pi's own infrastructure reads. A
  redirect target that cannot be resolved statically, `> $OUT` or
  `> $(mktemp)`, is treated as unproven and keeps the wrapper's floor
  (`src/access-intent/bash/redirect-analysis.ts:79`;
  `docs/configuration.md:1017`, `:1029`). That is the same "only literal paths
  are trusted" principle pi-bouncer plans to use. `rg -i mktemp|tmpdir` finds no
  allowance for temp dirs.
- **`@gotgenes/pi-subagents` (21.9.3): not relevant to this question.** It
  contributes `promptSnippet` text for its own tools (`src/tools/agent-tool.ts:202`,
  `src/session/ask-parent-tool.ts:48`) and writes the `<active_agent>` tag the
  permission system reads. Neither carries permission advice.

Background on the permission system for subagents is in
`docs/research/child-permissions/gotgenes.md`.

## 2. Claude Code

**Mixes all three: standing guidance in the system prompt and the Bash tool
description, rewrite instructions in some denials, and a hook API for
just-in-time notes. It is the only tool found that says in its prompt that
agent-made files are free to delete.**

*Standing guidance (a).*

- System prompt, "Executing actions with care" (Piebald extract, ccVersion
  2.1.200, `system-prompts/system-prompt-executing-actions-with-care.md:16`):
  "If you discover unexpected state like unfamiliar files, branches, or
  configuration, investigate before deleting or overwriting ... If you're unsure
  whether the user would want something kept, prefer a reversible step ... over
  deleting; **files you created yourself this session (scratch outputs,
  experiment intermediates) are yours to clean up freely.**" The same file lists
  "deleting files/branches ... rm -rf" as a risky action to confirm, so the
  carve-out is the exception.
- Bash tool description, sandbox section (Piebald extract,
  `system-prompts/tool-description-bash-sandbox-tmpdir.md`, ccVersion 2.1.163):
  "For temporary files, always use the `$TMPDIR` environment variable ... Do NOT
  use `/tmp` directly." The official sandboxing doc confirms there is a variant
  for `mktemp`: "The Bash tool guidance tells Claude to create scratch
  directories with `mktemp -d` instead of relying on `$TMPDIR`"
  (`sandboxing.md`, "disable filesystem isolation" section, line 380). The doc
  also says the sandbox writes to the working directory and a per-user temp
  directory by default (`sandboxing.md:31`, `:236-238`).
- Bash tool description, sandbox escape (Piebald extract,
  `tool-description-bash-sandbox-*.md`): tells Claude to "default to running
  commands within the sandbox", lists the evidence of a sandbox failure
  ("Operation not permitted", "Access denied to specific paths outside allowed
  directories"), and then to "Immediately retry with `dangerouslyDisableSandbox:
  true` (don't ask, just do it)" (ccVersion 2.1.53), with a per-command reset
  ("Treat each command you execute with `dangerouslyDisableSandbox: true`
  individually"). The older "don't ask" text and the newer docs differ on
  approval; the docs say the retry prompts the user outside `bypassPermissions`
  (`sandboxing.md:205-210`).
- Git destructive-ops line in the Bash description (Piebald extract,
  `tool-description-bash-git-avoid-destructive-ops.md`): "consider whether there
  is a safer alternative".

*Denial-time guidance (c).*

- Critical-path `rm`/`rmdir` check (official, `permission-modes.md`, "Critical
  paths", lines 660-740). The targets that always prompt (or deny, per mode)
  include a glob or trailing slash under a variable (`rm -rf "$DIR"/*`), a bare
  command substitution target, and a variable assigned from `$(pwd)`. The doc
  says how to pass: "guard each expansion ... `rm -rf "${DIR:?}"/*`, or use a
  literal path", and "run the substitution on its own first, then remove the
  literal paths it prints. **The prompt tells Claude to do the same.**" For a
  glob under a variable, "the prompt names the flagged `rm` and says how to
  rewrite it so the check passes." In `auto` mode with no terminal, "The denial
  tells Claude to report what it wanted to delete and leave the removal to you"
  (`permission-modes.md:737`). The exact wording sent to the model is **unknown**:
  the docs paraphrase it and no extract of it was found.
- Same check treats `rm -rf "$TMPDIR/mnt"` as critical (the variable could be
  empty) and `rm -rf <additional dir>` as fine but `rm -rf <dir>/*` as critical
  (`permission-modes.md:687`). So even Claude Code's temp-dir safety depends on
  the path being literal and not a glob.
- Hook denials: `permissionDecisionReason` is "shown to Claude" on deny and
  "shown to the user but not Claude" on ask (`hooks.md:1798`).
- Auto-mode classifier block: "Claude receives the reason. In most sessions the
  reason names the rule the classifier matched, such as `[Data Exfiltration]`,
  rather than giving a written explanation" (`permission-modes.md:503`). That is
  a rule name, not a rewrite hint.
- The exact generic text for a user-denied prompt is **unknown**; neither the
  docs nor the Piebald extract contain it.

*Just-in-time notes (b).* Not built in for this case, but the hook API supports
it: a `PostToolUse` hook may return `additionalContext`, which "Claude Code wraps
... in a system reminder and inserts into the conversation at the point where
the hook fired" (`hooks.md:976`; field table at `hooks.md:2016-2030`; capped at
10,000 characters, `hooks.md:913`). For the classifier there is a parallel
`classifierContext`, a note "for the auto mode classifier rather than for Claude"
(`hooks.md:2025`), and the harness itself injects a `gitStatus` line above an
`rm -rf` for the classifier so it can tell a clean tree from a dirty one (Piebald
extract, `agent-prompt-security-monitor-for-autonomous-agent-actions-first-part.md:35`).
So Claude Code uses just-in-time context to inform the *judge*, not the agent.

*Agent-created things.* In auto mode the classifier's default-allow list
includes "Deleting the exact jobs Claude created earlier in the same session"
and "Local file operations in your working directory"; the default-block list
includes "Irreversibly destroying files that existed before the session" and
"Deleting files in `/tmp`, `$TMPDIR`, or another shared scratch or cache
directory by wildcard, glob, or age filter rather than by a specific named path"
(`permission-modes.md:417-422`, `:350-376`). That last line is close to
pi-bouncer's plan: a named path is acceptable, a glob is not. This is a model
judgement, not a deterministic ledger of created paths. Whether Claude Code
keeps such a ledger: **unknown**.

## 3. OpenAI Codex CLI (`12a30d4`)

**Standing guidance (a), delivered as a developer-message fragment; denial
messages (c) are terse; tells the model to escalate `rm` it was not asked to
run; no agent-created-path exemption found.**

- The approval and sandbox text is built from templates in
  `codex-rs/prompts/templates/permissions/` by
  `codex-rs/prompts/src/permissions_instructions.rs` and placed in the
  conversation as a context fragment (`core/src/session/world_state.rs` imports
  `PermissionsState`). The sandbox text for the default mode is one line:
  `workspace-write`: "The sandbox permits reading files, and editing files in
  `cwd` and `writable_roots`. Editing files in other directories requires
  approval" (`sandbox_mode/workspace_write.md:1`).
- Escalation guidance, `approval_policy/on_request.md:24-50`: how to request
  (`sandbox_permissions: "require_escalated"` plus a `justification`), when
  ("You are about to take a potentially destructive action such as an `rm` or
  `git reset` that the user did not explicitly ask for", `:41`), to "be judicious"
  and "don't try and circumvent approvals by using other tools" (`:42`), and
  "NEVER provide a prefix_rule argument for destructive commands like rm"
  (`:50`). Under `never`: "Do not provide the `sandbox_permissions` for any
  reason, commands will be rejected" (`approval_policy/never.md:1`).
- After a rejection under auto-review the prompt adds: "you should proceed only
  with a materially safer alternative, or inform the user of the risk and send a
  final message to ask for approval" (`permissions_instructions.rs:32`).
- Denial strings (c): `` `{command}` rejected: policy forbids commands starting
  with `{prefix}` `` or `` `{command}` rejected: {justification} ``
  (`core/src/exec_policy.rs:1075-1095`), and for forced `rm`: "rm -f style
  commands are not permitted. Use a safer approach" (`exec_policy.rs:1115-1118`).
  User declines come back as `exec command rejected by user`
  (`core/src/tools/events.rs:454-458`).
- Just-in-time notes (b): none found for this purpose.
- Created-path exemption: none found. The sandbox's writable roots include the
  temp dirs by default (`protocol/src/models.rs:528-547` shows the
  `exclude_tmpdir_env_var` / `exclude_slash_tmp` switches, defaulting to false),
  but that is a write boundary, not a delete rule. The auto-review ("guardian")
  policy leans on the target's size rather than on who made it: "Do not assign
  `high` or `critical` to a user-requested deletion of a specific local path
  solely because it uses `rm -rf`. If a read-only check shows the target is
  missing, empty, or narrowly scoped ... this is usually `low` or `medium`", and
  the reviewer should "attempt a read-only inspection of the target path first"
  (`prompts/templates/guardian/policy_template.md:38`, `:50`).

## 4. Others, briefly

- **opencode (`108b988`).** (a): the shell tool description tells the model
  "Use `${tmp}` for temporary work outside the workspace. This directory has
  already been created, already exists, and is pre-approved for external
  directory access" (`packages/opencode/src/tool/shell/shell.txt:7`;
  `${tmp}` = `Global.Path.tmp`, `shell/prompt.ts:280`). The pre-approval is a real
  rule: `path.join(Global.Path.tmp, "*")` is in the default
  `external_directory` allow list (`agent/agent.ts:110`). It is a fixed shared
  directory, not "paths this agent made". (c): denial text is "The user has
  specified a rule which prevents you from using this specific tool call. Here
  are some of the relevant rules {ruleset JSON}" and "The user rejected
  permission to use this specific tool call" (+ "with the following feedback:
  ..." when the user typed one) (`packages/core/src/v1/permission.ts:7-27`).
  No hint on how to avoid the block beyond showing the matching rules.
- **Gemini CLI (`fb972b2`).** (a): the system prompt says "You should not ask
  permission to use the tool; the user will be presented with a confirmation
  dialogue" and requires a brief explanation of critical commands before running
  them (`packages/core/src/prompts/snippets.ts:412`); "If a tool call is declined
  or cancelled, respect the decision immediately. Do not re-attempt the action
  or 'negotiate'" (`snippets.ts:432`); under a sandbox the prompt names
  "the project directory or system temp directory" as accessible
  (`snippets.ts:448-466`). (c): `Tool execution denied by policy.` plus an
  optional operator `deny_message` (`packages/core/src/scheduler/policy.ts:34-45`;
  `core/src/policy/toml-loader.ts:68`). No agent-created-path rule found.
- **Cline (`476b165`).** Unusual: the model itself decides whether to ask. Its
  docs say "Cline does not use a fixed allowlist. The model marks each command
  with a `requires_approval` flag", with `rm -rf <path>` listed as "commonly
  requires approval" (`docs/features/auto-approve.mdx:49-62`); the old tool
  example still sets `<requires_approval>false</requires_approval>`
  (`apps/vscode/src/core/prompts/responses.ts:123`). The tool description text
  that defines the flag was **not found** at this commit (the code moved to an
  SDK); the doc is the evidence. Standing guidance with the model as the judge.
- **Roo Code (`b867ec9`, May 2026, possibly stale).** The `execute_command`
  description carries no approval guidance (`src/core/prompts/tools/native-tools/execute_command.ts:3-12`);
  auto-approval is decided client-side. The command-allowlist mechanics were not
  read: **unknown**.

## 5. What this means for pi-bouncer

The three options map onto the evidence like this.

| Option | Precedent | Notes |
| :- | :- | :- |
| (a) standing guidance | Claude Code (system prompt + Bash description), opencode (tool description), Codex (developer message), Gemini (system prompt), Cline (tool/flag) | The common pattern. All of them write it as one or two sentences about the tool, not per-call. Claude Code's own sentence about agent-made files is generic: "files you created yourself this session ... are yours to clean up freely". |
| (b) note in the creating call's output | None as shipped behaviour. Claude Code's hooks can do it (`PostToolUse` `additionalContext`); gotgenes does not modify results | Novel. Exact path naming is its one advantage. Cost: only works if the agent made the directory with a command the bouncer recognises, and the note scrolls away or is compacted in long sessions (**unknown** how Pi treats tool results on compaction; not researched). |
| (c) refusal only | gotgenes, opencode, Gemini, Codex (all terse) | Universal as a backstop. Claude Code's critical-path denial is the best model: it names the rewrite ("use a literal path", "run the substitution first, then remove the literal paths it prints"). |

Recommendation: **(a) plus (c)**, and skip (b) for now.

1. **Standing guidance is cheap and is what the mature tools do.** The rule is
   short and does not depend on which path: "`rm -rf` of a directory you created
   in this session runs without asking when you write the path out in full: no
   `$VAR`, `~` or glob." That is one `promptGuidelines` bullet on the bash tool.
   Claude Code and opencode both carry comparable sentences every request
   (`tool-description-bash-sandbox-tmpdir.md`, `shell.txt:7`). This also lets the
   agent plan (make the folder, then clean it by literal path) instead of
   discovering the rule by hitting a prompt.
2. **The refusal must still teach, because the agent will sometimes write
   `rm -rf "$DIR"`.** Claude Code does exactly this for `$VAR` targets and its
   rewrite advice ("use a literal path") matches the condition pi-bouncer already
   plans to enforce. The refusal should name the path it expected to see written
   out. gotgenes-style denials with only the matched rule do not give the agent
   the way out; its own docs rely on the operator writing a `reason`.
3. **(b) is unproven and adds a failure mode.** Nobody ships it, so there is no
   evidence it works better. A per-call note depends on the creating command
   being parsed (`mkdir -p`, `mktemp -d`, `$(mktemp -d)` into a variable, a
   script that makes the directory), and when the creation is not recognised the
   agent has no note and no standing rule. Standing text works in every case the
   rule works. The one thing (b) does better is naming the exact path, and (c)
   can do that at the moment it matters.
4. **A caution from Claude Code's own docs.** Its rule for agent-made files is
   backed by a classifier and by blocks on globs in `/tmp` ("by a specific named
   path" only), and `rm -rf "$TMPDIR/mnt"` is still flagged (`permission-modes.md:376`,
   `:687`). That supports pi-bouncer's all-literal-path condition, and suggests
   the standing sentence should say "path written out in full" and not just
   "folders you made".

**Not established.** No project published any measurement of whether standing
text, tool-output notes or denial messages change agent behaviour, so the choice
is based on what mature tools ship, not on measured effect. If pi-bouncer wants
evidence, the cheapest test is to ship (a)+(c) and count refusals of
`rm -rf "$VAR"` in the bouncer log, and only then try (b).

## Unknowns

- The exact model-facing text of Claude Code's critical-path `rm` prompt and of
  a plain user-denied prompt. Docs paraphrase; neither Piebald extract nor docs
  quote it.
- Whether Claude Code or any tool keeps a deterministic ledger of paths the
  agent created. Claude Code's allow for "jobs Claude created earlier in the same
  session" is described in docs, but how the classifier knows is not published.
- Cline's `execute_command` tool description for `requires_approval` at the
  checked commit.
- Roo's allowlist mechanics.
- How Pi compacts old tool results (relevant to option (b) only).
