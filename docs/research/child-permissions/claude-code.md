# How Claude Code handles permissions for subagents and in general

**Question.** For pi-bouncer's per-child permission sets: how does Claude Code
(Anthropic) scope, merge, and enforce permissions generally and for subagents —
where rules are written and which source wins, whether project files may loosen,
how a child's identity is established, parent/child mode interaction, prompt
routing, auto-mode treatment of subagents, invalid config, and the friction
users report?

**Short answer.** Claude Code runs one session-wide permission engine, not a
per-agent one. `allow`/`ask`/`deny` rules come from settings files (managed >
CLI > project-local > shared project > user; lists merge, deny wins across all
scopes) and apply to the main loop *and* to every subagent's tool calls. A
subagent's only permission-specific knob is its frontmatter `permissionMode`,
and its effect is one-directional and parent-gated: if the parent is in
`bypassPermissions`, `acceptEdits`, or `auto`, the parent's mode wins and the
child's value is ignored; otherwise the child runs in its declared mode
(including a *looser* one than the parent) but may never declare
`bypassPermissions`. Tool allow/deny lists (`tools`, `disallowedTools`) are how
you truly restrict a child. Project files can grant (loosen) through
`permissions.allow`/`additionalDirectories`, but only after the interactive
workspace-trust dialog, and `auto`/`bypassPermissions` `defaultMode` never take
effect from project or local files. Auto mode adds a classifier that evaluates a
subagent's spawn task, each of its tool calls, and its final report; it ignores
the child's `permissionMode`. In practice (GitHub issues) child permission
enforcement has had repeated gaps — subagents not seeing allow rules,
`disallowedTools` not propagating to nested agents, teammates ignoring
`bypassPermissions` — which is the strongest caution for pi-bouncer: match the
documented model, but expect the model's own implementation to be imperfect.

**Date and versions checked.** 2026-10-02 (UTC). Claude Code documentation from
`code.claude.com/docs` fetched as `.md` on that date; the pages self-describe
behaviour up to Claude Code v2.1.287 and cite per-feature version gates
(v2.1.147–v2.1.287) inline. GitHub issues are cited by number and date. No
pinned Claude Code source commit was inspected (closed source); only first-party
docs plus the issue tracker.

**How to read the citations.** Docs are living pages with no versioned URL, so a
citation is the page URL plus the section, plus a `local:line` reference into the
copy fetched on 2026-10-02 (kept for this task under `/tmp/cc/`). Version-gated
behaviour is quoted from the page itself. Issue claims are secondary
(experience reports) and are labelled as such.

---

## 1. Settings scopes, precedence, trust

### Scopes and precedence

- Settings live in four file scopes plus managed: **managed settings**
  (`managed-settings.json`, MDM, claude.ai console), **command line**
  (`claude --settings`), **project local** (`.claude/settings.local.json`),
  **shared project** (`.claude/settings.json`), **user**
  (`~/.claude/settings.json`). Highest wins for a scalar key:
  managed > command line > project local > shared project > user.
  (https://code.claude.com/docs/en/settings, "Settings precedence";
  `settings.md:130`–`settings.md:200`, `settings.md:672`–`settings.md:700`.)
- Permission rules follow that same precedence, and **managed settings beat
  everything**: no other level, "including command line arguments", can override
  a managed permission rule. If a tool is denied at any level, no other level can
  allow it (a managed deny is not overridden by `--allowedTools`; a user-level
  deny blocks a project-level allow).
  (https://code.claude.com/docs/en/permissions, "Managed settings" and "Settings
  precedence"; `permissions.md:659`–`permissions.md:692`.)
- **Lists merge rather than override.** Setting `permissions.allow` in several
  files combines the lists; each file can add without removing another file's
  entries. The documented exceptions are model-list keys (`fallbackModel`,
  `modelPicker`, `availableModels`, `modelSettings`), not permission arrays.
  (https://code.claude.com/docs/en/settings, "Lists merge instead of overriding";
  `settings.md:706`–`settings.md:725`.)
- **Evaluation order is deny, then ask, then allow**, first match wins regardless
  of specificity. A broad deny beats a narrow allow; a matching ask prompts even
  when a more specific allow matches. A bare tool-name deny removes the tool from
  Claude's context entirely; a scoped deny (`Bash(rm *)`) blocks matching calls.
  (https://code.claude.com/docs/en/permissions, "Manage permissions";
  `permissions.md:85`–`permissions.md:110`.)
- **Deny wins across scopes**, and the reverse too: user deny blocks project
  allow, project deny blocks user allow.
  (https://code.claude.com/docs/en/permissions, "Settings precedence";
  `permissions.md:672`–`permissions.md:692`.)
- A manager lock exists: `allowManagedPermissionRulesOnly: true` makes managed
  settings the only source of permission rules and ignores user/project/local/
  `--settings` `allow`/`ask`/`deny`, plus `--allowedTools`, and hides prompt
  always-allow choices. `--disallowedTools` and current-session deny/ask still
  apply (they only restrict).
  (https://code.claude.com/docs/en/settings-reference,
  "`allowManagedPermissionRulesOnly`"; `settings-reference.md:1380`–`settings-reference.md:1410`.)

### Can project settings loosen?

- Yes, within limits and only after trust. `permissions.allow` rules and
  `permissions.additionalDirectories` in a project's `.claude/settings.json` take
  effect **only after you accept the workspace trust dialog** for that folder;
  the dialog lists the rules/directories the folder would grant. `deny` and `ask`
  rules are not gated, because they only restrict.
  (https://code.claude.com/docs/en/permissions, "Project allow rules and
  workspace trust"; `permissions.md:679`–`permissions.md:706`.)
- Trust is keyed to the **git repository root** (whole repo, minus nested repos);
  outside a repo, to the starting directory; started in `~` it is session-only
  and not written to disk. Trust shows in interactive sessions only; `claude -p`
  and SDK sessions never show it, and a parent folder's trust does not count for
  project allow rules.
  (https://code.claude.com/docs/en/permissions, "Project allow rules and
  workspace trust"; `permissions.md:679`–`permissions.md:711`.)
- `.claude/settings.local.json` normally applies its allow rules without the
  trust step, but when the file is tracked in git or `.claude` is a symlink,
  Claude Code treats it as repository-supplied and holds its rules until trust.
  (https://code.claude.com/docs/en/permissions, "When your local settings file
  needs trust"; `permissions.md:693`–`permissions.md:706`.)
- **`permissions.defaultMode` `auto` and `bypassPermissions` do not take effect
  from project or local files** (user, `--settings`, or managed only). For
  conversations the VS Code extension starts, only user/managed/`--settings`
  values are read. Before v2.1.257 `bypassPermissions` took effect from any file.
  (https://code.claude.com/docs/en/settings-reference,
  "`permissions.defaultMode`"; `settings-reference.md:1665`–`settings-reference.md:1690`.)
- In agent-view dispatch there is an extra one-way rule: a project/local
  `defaultMode` that is *more permissive* than the session you dispatched from is
  refused and the next source decides. Permissiveness order is plan, then
  Manual/`dontAsk`, then `acceptEdits`/auto, then `bypassPermissions`.
  (https://code.claude.com/docs/en/agent-view, "Permission mode";
  `agent-view.md:663`–`agent-view.md:690`.)
- A repository cannot turn some restrictions off: `useAutoModeDuringPlan: false`,
  `blockReadsOutsideWorkingDirectories: true`, `skipDangerousModePermissionPrompt`
  and similar security keys honour the stricter value from a lower scope
  (https://code.claude.com/docs/en/settings, "Exceptions to managed settings
  precedence"; `settings.md:756`–`settings.md:790`).
- A `!` (gitignore-negation) deny pattern carves out only rules from the *same*
  settings source; it cannot cancel a deny from managed settings or another file.
  (https://code.claude.com/docs/en/permissions, "Read and Edit";
  `permissions.md:456`–`permissions.md:470`.)

### Where the trust dialog is described

- "Trust verification" is listed among the built-in safeguards: the dialog
  appears in interactive sessions for untrusted folders; a `-p` session shows it
  never; starting directly in the home directory holds trust for the session
  only. (https://code.claude.com/docs/en/security, "Additional safeguards";
  `security.md:104`–`security.md:112`.)

---

## 2. Subagent definition fields, scopes/priority, plugin restrictions

### Definition and fields

- Subagents are Markdown files with YAML frontmatter. Only `name` and
  `description` are required. Permission-relevant fields:
  `tools`, `disallowedTools`, `permissionMode`, `hooks`, `mcpServers`,
  `maxTurns`, `background`, `omitClaudeMd`, `isolation`.
  (https://code.claude.com/docs/en/sub-agents, "Frontmatter reference";
  `sub-agents.md:296`–`sub-agents.md:330`.)
- `tools` is an allowlist; `disallowedTools` a denylist; if both are set,
  `disallowedTools` is applied first and `tools` resolves against what remains.
  A `disallowedTools` entry **with a specifier still removes the whole tool**, not
  just the matching commands; to block specific commands while keeping the tool,
  use a `permissions.deny` rule such as `Bash(git push *)`, which applies to the
  main conversation *and* to subagents.
  (https://code.claude.com/docs/en/sub-agents, "Available tools";
  `sub-agents.md:470`–`sub-agents.md:495`.)
- MCP server-level patterns are accepted in both lists (`mcp__<server>` or
  `mcp__<server>__*`; `mcp__*` removes all MCP tools in `disallowedTools`).
  (https://code.claude.com/docs/en/sub-agents, "Available tools";
  `sub-agents.md:466`–`sub-agents.md:495`.)
- A background subagent gets a **smaller built-in tool set** than a foreground
  one (MCP tools are kept; only a fixed list of built-ins is kept). A conversation
  fork skips both filters.
  (https://code.claude.com/docs/en/sub-agents, "Available tools";
  `sub-agents.md:413`–`sub-agents.md:445`.)
- Subagents inject CLAUDE.md hierarchy by default; `omitClaudeMd: true` drops
  user/project/local memory (managed policy still loads, except for managed
  subagents). (https://code.claude.com/docs/en/sub-agents, "Frontmatter
  reference" and "What loads at startup"; `sub-agents.md:316`,
  `sub-agents.md:1040`–`sub-agents.md:1070`.)

### Scopes and priority

- Scope priority, highest first: **1 managed settings**, **2 `--agents` CLI flag**,
  **3 `.claude/agents/`** (project), **4 `~/.claude/agents/`** (user),
  **5 plugin `agents/`** (lowest). Same-name definitions resolve by priority.
  (https://code.claude.com/docs/en/sub-agents, "Choose the subagent scope";
  `sub-agents.md:161`–`sub-agents.md:170`.)
- Project subagents are discovered by walking up from cwd to the repo root;
  the definition **closest to the working directory** wins. Directories added with
  `--add-dir`/`/add-dir` also contribute their `.claude/agents/`.
  (https://code.claude.com/docs/en/sub-agents, "Choose the subagent scope";
  `sub-agents.md:170`–`sub-agents.md:180`.)
- Plugin agent subfolders become part of the scoped identifier
  (`my-plugin:review:security`), unlike project/user subfolders.
  (https://code.claude.com/docs/en/sub-agents, "Choose the subagent scope";
  `sub-agents.md:182`.)

### Plugin restrictions

- **Plugin subagents ignore `permissionMode`, `hooks`, `mcpServers`, and
  `initialPrompt`** ("for security reasons"). The workaround is to copy the file
  into `.claude/agents/` or `~/.claude/agents/`, or add `permissions.allow` rules
  that (note) apply to the whole session, not just the plugin subagent.
  (https://code.claude.com/docs/en/sub-agents, "Choose the subagent scope";
  `sub-agents.md:239`–`sub-agents.md:243`; frontmatter table
  `sub-agents.md:307`–`sub-agents.md:320`.)
- Plugin `agents/` frontmatter supports `name, description, model, effort,
  maxTurns, tools, disallowedTools, skills, memory, background, omitClaudeMd,
  isolation, color, experimental.cacheTtl`; `permissionMode, hooks, mcpServers,
  initialPrompt` are ignored.
  (https://code.claude.com/docs/en/plugins/components, "Frontmatter fields in
  plugin agents"; `plugins_components.md:735`–`plugins_components.md:742`.)
- A plugin's root `settings.json` **only honours `agent` and `subagentStatusLine`
  — every other key is dropped**, so a plugin cannot inject permission rules
  through default settings. Plugin defaults are the lowest settings layer.
  (https://code.claude.com/docs/en/plugins/components, "Default settings";
  `plugins_components.md:899`–`plugins_components.md:920`.)
- Plugin hooks and plugin MCP servers run as full user-privilege processes outside
  the sandbox; permission rules cover Claude's *tool calls* to them, not the
  plugin's own code. (https://code.claude.com/docs/en/plugins/security,
  "Understand what a plugin can do"; `plugins_security.md:26`–`plugins_security.md:40`.)
- Hook precedence: `PreToolUse`/`PermissionRequest` decisions **cannot override
  deny or ask rules**; a hook `allow` still loses to a matching deny and still
  prompts on a matching ask. Only a *mod* (JS plugin) can approve past some
  rules, and on Team/Enterprise/managed machines deny rules hold over the mod by
  default. (https://code.claude.com/docs/en/permissions, "Extend permissions with
  hooks"; `permissions.md:556`–`permissions.md:590`.)

---

## 3. Inheritance, "more permissions than parent", mode interaction, auto mode

### Do subagents inherit parent rules?

- The sub-agents page states built-in subagents "each inherit the parent
  conversation's permission rules"; most run a restricted tool set.
  (https://code.claude.com/docs/en/sub-agents, "Built-in subagents";
  `sub-agents.md:31`.) The same page says a `permissions.deny` Bash rule "applies
  to the main conversation and to subagents" (`sub-agents.md:479`).
- Settings-file hooks run inside subagents for their tool calls, with
  `agent_id`/`agent_type` in the hook input, so a project/plugin hook applies to
  child tool calls too. (https://code.claude.com/docs/en/hooks, "Hook locations";
  `hooks.md:269`; common fields `hooks.md:739`–`hooks.md:740`.)
- Subagent frontmatter hooks need **workspace trust for the folder that contains
  the agent file**; a parent folder's trust and a `-p`/SDK session's automatic
  hooks trust do not count. Untrusted → the subagent still runs but its
  frontmatter hooks are skipped. Inline MCP servers in a project agent file follow
  the same stricter trust rule.
  (https://code.claude.com/docs/en/sub-agents, "Hooks in subagent frontmatter" and
  "Trust required for inline MCP servers"; `sub-agents.md:738`–`sub-agents.md:744`,
  `sub-agents.md:543`–`sub-agents.md:552`.)

### Can a subagent get MORE permissions than the parent?

- Yes, when the parent is in `default` (Manual), `dontAsk`, or `plan`: the
  subagent runs in the `permissionMode` you set, and that mode can be *looser*
  than the parent's (e.g. parent `plan`/`dontAsk` → child `acceptEdits`/`auto`).
  (https://code.claude.com/docs/en/sub-agents, "Permission modes";
  `sub-agents.md:564`–`sub-agents.md:582`; SDK wording
  https://code.claude.com/docs/en/agent-sdk/permissions, "Available modes";
  `sdk-permissions.md` permission-mode warning.)
- The ceiling is explicit: a child **may never claim `bypassPermissions`**. When
  the parent is `default`, `dontAsk`, or `plan`, a subagent declaring
  `bypassPermissions` "keeps the main conversation's mode instead" (v2.1.267+).
  (https://code.claude.com/docs/en/sub-agents, "Permission modes";
  `sub-agents.md:571`.)
- **`permissionMode` is ignored when the parent is `bypassPermissions`,
  `acceptEdits`, or auto** — the child runs in the parent's mode. So under those
  three parent modes a child definition cannot tighten itself with
  `permissionMode` either; `tools`/`disallowedTools` (and settings deny/ask rules)
  are the restriction levers that survive.
  (https://code.claude.com/docs/en/sub-agents, "Permission modes";
  `sub-agents.md:570`–`sub-agents.md:571`.)
- `permissions.disableBypassPermissionsMode: "disable"` (any scope) makes Claude
  Code ignore an agent definition's `permissionMode: bypassPermissions`, so the
  subagent runs with the parent mode. It also rejects the
  `--dangerously-skip-permissions` flag.
  (https://code.claude.com/docs/en/settings-reference,
  "`permissions.disableBypassPermissionsMode`"; `settings-reference.md:1691`–`settings-reference.md:1703`.)

### Auto mode's classifier over subagents

- The classifier checks subagent work at **three points**: (1) the delegated task
  description is evaluated before the subagent starts, so a dangerous-looking task
  is blocked at spawn; (2) every subagent action goes through the same decision
  order as the parent, "with the same block and allow rules. Any `permissionMode`
  in the subagent's frontmatter is ignored"; (3) when the subagent finishes, the
  classifier reviews its work and final report before the parent reads it —
  a flagged work/report is still delivered but prepended with a security warning,
  and if the classifier is unavailable the report arrives with a verify note.
  (https://code.claude.com/docs/en/permission-modes, "How auto mode handles
  subagents"; `permission-modes.md:517`–`permission-modes.md:528`.)
- Auto mode also reviews each message Claude sends to another agent via
  `SendMessage`, and treats a relayed approval claim as untrusted input.
  (https://code.claude.com/docs/en/permission-modes, "Eliminate permission prompts
  with auto mode"; `permission-modes.md:9` and `agent-teams.md:294`–`agent-teams.md:298`.)
- Auto-mode decision order for any action: (1) allow/ask/deny rules resolve
  immediately, with exceptions (protected-path writes and per-command allowed
  domains route to the classifier; content-scoped ask rules prompt; critical-path
  `rm` never allow-approved); (2) read-only actions and working-directory edits
  auto-approve; (3) everything else → classifier; (4) block reasons name the
  rule.
  (https://code.claude.com/docs/en/permission-modes, "How the classifier
  evaluates actions"; `permission-modes.md:483`–`permission-modes.md:520`.)
- On entering auto mode, broad allow rules that grant arbitrary code execution are
  dropped: blanket `Bash(*)`, wildcarded interpreters (`Bash(python*)`),
  package-manager run commands, `Agent` allow rules, `Monitor` allow rules. Narrow
  rules like `Bash(npm test)` stay. Dropped rules are restored on leaving auto
  mode. (https://code.claude.com/docs/en/permission-modes, "How the classifier
  evaluates actions"; `permission-modes.md:513`–`permission-modes.md:518`.)
- The classifier runs on Claude Sonnet 5 by default rather than the session model,
  with documented fallbacks; on Enterprise/API/cloud accounts classifier calls
  count toward token usage.
  (https://code.claude.com/docs/en/permission-modes, "Cost and latency";
  `permission-modes.md:536`–`permission-modes.md:548`.)
- Auto mode is the **built-in starting mode** for interactive terminal and VS Code
  sessions from v2.1.283 (earlier: only Pro/Max/Team). Administrators remove it
  with `disableAutoMode: "disable"`.
  (https://code.claude.com/docs/en/permission-modes, "Choose a permission mode"
  and "Which mode a session starts in"; `permission-modes.md:13`,
  `permission-modes.md:70`–`permission-modes.md:95`.)

### Subagent output scanning (identity / injection defence)

- Before the parent reads a subagent's report, Claude Code scans it: it inserts a
  backslash into text imitating Claude Code's own output (`<system-reminder>`,
  `Human:`/`Assistant:`), and prepends a
  `[harness: subagent output matched instruction-shaped pattern(s): …]` marker
  line when the report imitates a tag or "mentions permission settings such as
  `bypassPermissions` or `--dangerously-skip-permissions`". The scan changes
  nothing else; the docs stress a tool call the report leads the parent to make
  still goes through permission checks. Requires v2.1.210+.
  (https://code.claude.com/docs/en/sub-agents, "Subagent output scanning";
  `sub-agents.md:936`–`sub-agents.md:952`.)
- Messages from the launching agent are treated as task direction, but **no agent
  message counts as your approval for a pending permission prompt, and no agent
  message can change a subagent's permission settings, CLAUDE.md, or
  configuration**.
  (https://code.claude.com/docs/en/sub-agents, "Resume subagents";
  `sub-agents.md:1110`–`sub-agents.md:1114`.)

---

## 4. How subagent permission prompts reach the human

- **Foreground subagents** block the main conversation; "permission prompts are
  passed through to you as they come up." **Background subagents** run
  concurrently and "surface the prompt in your main session and name the subagent
  that is asking"; approve to continue, Esc to deny that one tool call.
  (https://code.claude.com/docs/en/sub-agents, "Run subagents in foreground or
  background"; `sub-agents.md:888`–`sub-agents.md:890`.)
- A background prompt answered with a session-lasting choice applies the answer to
  the **whole session**, including the main conversation.
  (https://code.claude.com/docs/en/sub-agents, same section; `sub-agents.md:902`.)
- Background subagents had auto-denied prompts before v2.1.186; the docs now
  describe routing. A user filed the stale-doc report as
  https://github.com/anthropics/claude-code/issues/70143 (2026-06-22, closed
  inactive).
- In non-interactive sessions a subagent prompt that can't be shown still fires
  `PermissionRequest` hooks, and **if no hook returns a decision Claude Code
  denies the tool call**. (https://code.claude.com/docs/en/hooks,
  "PermissionRequest"; `hooks.md:1874`–`hooks.md:1883`.)
- Other human-facing routes for a prompt: `--permission-prompt-tool` (MCP host),
  the Agent SDK `canUseTool` callback, `--permission-prompts none` (deny instead
  of waiting), and channel "permission relay" that forwards
  `notifications/claude/channel/permission_request` to a chat app and accepts an
  allow/deny verdict (v2.1.234+).
  (https://code.claude.com/docs/en/headless, "Turn off permission prompts in
  unattended runs"; `headless.md:294`–`headless.md:298`;
  https://code.claude.com/docs/en/channels-reference, "Relay permission prompts";
  `channels-reference.md:440`–`channels-reference.md:500`.)
- In practice: issue https://github.com/anthropics/claude-code/issues/23983
  (2026-02-07, open) reports `PermissionRequest` hooks not firing for subagent
  prompts in Agent Teams (falling back to terminal prompts);
  https://github.com/anthropics/claude-code/issues/82418 (2026-07-29, open) the
  same for teammates;
  https://github.com/anthropics/claude-code/issues/82150 (2026-07-29, open) that
  for background subagents the `PermissionRequest` hook is awaited *before* the
  local dialog is built, unlike the main session where they race.
  All are secondary (user reports).

---

## 5. Nested `claude`, `--dangerously-skip-permissions`, env vars, escalation

- No documentation was found describing a dedicated guard that inspects a Bash
  command for a nested `claude` invocation or for `--dangerously-skip-permissions`
  and refuses it. The relevant protections that *do* exist:
  - Auto mode's classifier blocklist includes "Launching an autonomous agent loop
    that runs without human approval or a sandbox, such as one started with
    `--dangerously-skip-permissions` or `--no-sandbox`", including third-party
    agent/eval harnesses started with `--yes-always`.
    (https://code.claude.com/docs/en/permission-modes, "What the classifier blocks
    by default"; `permission-modes.md:374`.)
  - `--restricted` (v2.1.248+) removes command/code-running built-ins and
    WebFetch, confines file tools to working directories, loads only managed
    settings and `--settings`, and **refuses `bypassPermissions`**; a restricted
    session also refuses to create cloud sessions.
    (https://code.claude.com/docs/en/cli-reference, `--restricted`;
    `cli-reference.md:123`.)
  - `permissions.disableBypassPermissionsMode: "disable"` rejects
    `--dangerously-skip-permissions` and ignores a child's bypass declaration.
    (`settings-reference.md:1691`–`settings-reference.md:1703`.)
  - Entering `bypassPermissions` requires an interactive disclaimer once
    (`skipDangerousModePermissionPrompt` written to `~/.claude/settings.json`);
    `-p` shows no dialog, `--bg` is refused until accepted interactively; on
    Linux/macOS it refuses to start as root/sudo outside a recognized sandbox.
    (https://code.claude.com/docs/en/permission-modes, "Skip all checks with
    bypassPermissions mode"; `permission-modes.md:588`–`permission-modes.md:604`.)
- **Nested-session detection exists but is not a permission guard.**
  `CLAUDE_CODE_CHILD_SESSION=1` is set in subprocesses spawned by the Bash,
  PowerShell, and Monitor tools, hook commands, and status-line commands; an
  interactive `claude` started this way is excluded from `--resume`, `--continue`,
  history, and `claude agents` — transcript persistence only. Non-interactive
  `claude -p` still persists; `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` overrides.
  (https://code.claude.com/docs/en/env-vars, `CLAUDE_CODE_CHILD_SESSION`;
  `env-vars.md:223`.) `CLAUDECODE=1` is the broader "spawned by Claude Code"
  marker (`env-vars.md:190`).
- **No environment variable was found that sets or grants a permission mode.**
  `CLAUDE_CODE_ENABLE_AUTO_MODE` is a no-op kept for compatibility (it only
  mattered v2.1.158–v2.1.206) (`env-vars.md:277`); permission-related variables
  found are subtractive/tuning only (`CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT`,
  `CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT`,
  `CLAUDE_CODE_DISABLE_POWERSHELL_CMD_RM_DENY`,
  `CLAUDE_CODE_AUTO_MODE_SERVER`, `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS`).
  `CLAUDE_CODE_SAFE_MODE` disables customizations but "permissions work normally"
  (https://code.claude.com/docs/en/cli-reference, `--safe-mode`;
  `cli-reference.md:125`).
- Escalation via a *child* is addressed by: the child's `bypassPermissions`
  ceiling, the parent-mode override, deny/ask rules applying to subagents, the
  auto-mode spawn review, and the rule that no agent message carries user
  authority. In practice the opposite and sideways failures are reported:
  `bypassPermissions` not propagating to subagents
  (https://github.com/anthropics/claude-code/issues/83421, 2026-08-02, open),
  an agent definition's `disallowedTools` not inherited by subagents spawned via
  the Agent tool (https://github.com/anthropics/claude-code/issues/78063,
  2026-07-16, open), a named agent silently holding tools its `tools` allowlist
  excludes (https://github.com/anthropics/claude-code/issues/81852, 2026-07-28,
  open), and model-level self-authorization
  (https://github.com/anthropics/claude-code/issues/96208, 2026-09-23, open;
  https://github.com/anthropics/claude-code/issues/88837, 2026-08-22, open).
  All secondary.
- **unknown:** whether a documented, enforced guard denies a nested `claude`
  launched from the Bash tool specifically (as opposed to being judged by the
  auto-mode classifier); and whether `--dangerously-skip-permissions` used inside
  a session on a child process is detected anywhere outside auto mode.

---

## 6. Invalid settings handling

- **Interactive, user/project/local file:** invalid JSON or a schema-rejected
  value → a "Settings Error" dialog at session start with fix/exit/continue
  without the broken settings. Individual bad entries (malformed permission rule,
  unknown hook event) → "Settings Warning": those values are skipped and the rest
  of the file stays in effect.
  (https://code.claude.com/docs/en/settings, "Fix a broken settings file";
  `settings.md:806`–`settings.md:830`.)
- **`-p` runs:** no dialog; a broken file or values are skipped and the run
  continues, except an unparseable managed document. `claude doctor` lists what
  was dropped. (same section; `settings.md:826`–`settings.md:830`.)
- **Managed settings:** Claude Code first repairs/strips individual invalid
  entries with a warning, then drops what still fails, **except keys that fail
  closed**. An invalid `permissions.defaultMode` reads as `default`; invalid
  security booleans/enums read as their restrictive value until fixed. Interactive
  sessions show a dialog listing invalid entries; `claude doctor` details each.
  (https://code.claude.com/docs/en/managed-settings, "Find entries Claude Code
  dropped" and "Keys that fail closed"; `managed-settings.md:315`–`managed-settings.md:396`.)
- **Permission-rule shapes:** a malformed `Tool(content)` rule is skipped and
  reported ("Malformed Tool(content) rule"); a `Write/NotebookEdit/MultiEdit/Glob`
  path rule is kept but never consulted and warned about (only `Read`/`Edit` path
  rules are checked); a Bash allow wildcard before the subcommand is kept but
  warned about. (https://code.claude.com/docs/en/errors, "Malformed Tool(content)
  rule", "Is not matched by file permission checks", "Has a wildcard before the
  rest of the command"; `errors.md:5268`–`errors.md:5312`.)
- **`mcp__…(...)` rules** (parentheses on an MCP tool) are skipped at load, listed
  in the invalid-settings dialog and `claude doctor`.
  (https://code.claude.com/docs/en/permissions, "Match by input parameter";
  `permissions.md:132`–`permissions.md:140`.)
- **Invalid `--agents` value** makes `claude` exit with code 1 with
  `Error: Invalid --agents configuration:` and one line per problem, capped at 20.
  (https://code.claude.com/docs/en/errors, "Invalid `--agents` configuration";
  `errors.md:2774`–`errors.md:2795`.)
- **Invalid subagent file:** a file with no `name`, no `description`, a `name`
  starting with `-` or containing `:`, or unparseable YAML is skipped (debug log);
  the file is silently treated as documentation in some cases. Unrecognized
  frontmatter fields are ignored **without error**. A plugin subagent with no
  `name`/unparseable frontmatter still loads under its filename.
  (https://code.claude.com/docs/en/sub-agents, "Subagent files Claude Code skips";
  `sub-agents.md:336`–`sub-agents.md:346`.)
- Permission rules combine even when a lower-precedence file is broken: a broken
  file is skipped or its bad entries dropped, and the surviving rules from other
  scopes still apply (settings.md, "Fix a broken settings file", as above).

---

## 7. Agent teams and other multi-agent surfaces

- **Agent teams:** teammates start with the lead's permission mode **except
  `dontAsk`, which they don't inherit**; if the lead runs
  `--dangerously-skip-permissions`, all teammates do. You can change one
  teammate's mode after spawn, but **cannot set per-teammate modes at spawn
  time**. Teammate permission prompts appear in the lead session.
  (https://code.claude.com/docs/en/agent-teams, "Permissions";
  `agent-teams.md:284`–`agent-teams.md:290`.)
- **unknown:** which mode a teammate starts in when the lead is in `dontAsk`
  (the docs say only that it is not inherited).
- A teammate cannot approve a permission prompt, supply consent, or relay a
  denial to another teammate to bypass a check; auto mode reviews each inter-agent
  message and treats relayed approval claims as untrusted.
  (https://code.claude.com/docs/en/agent-teams, "Messages between agents";
  `agent-teams.md:292`–`agent-teams.md:298`.)
- Teammates spawned from a subagent definition get its `tools` and `model`; for
  in-process teammates Claude Code adds `SendMessage` and task tools; `skills`
  are not applied; `mcpServers` apply only to split-pane teammates. Trust is
  required to re-apply a project agent definition when a teammate is brought back.
  (https://code.claude.com/docs/en/agent-teams, "Use subagent definitions for
  teammates"; `agent-teams.md:270`–`agent-teams.md:284`.)
- `TeammateIdle`, `TaskCreated`, `TaskCompleted` hooks can block/return feedback
  (exit code 2). (https://code.claude.com/docs/en/agent-teams, "Enforce quality
  gates with hooks"; `agent-teams.md:212`–`agent-teams.md:218`.)
- **Workflows:** the workflow launch is a normal tool call gated by the session's
  permission mode; the subagents a workflow spawns use your permission rules and
  "Claude Code picks their permission mode by the rules under which permission
  mode a subagent runs in". (`workflows.md:179`–`workflows.md:196`.) A user
  report says the workflow docs previously claimed the subagents always run in
  `acceptEdits`, contradicting observed manual-mode behaviour
  (https://github.com/anthropics/claude-code/issues/89064, 2026-08-23, open).
- **Background/agent-view sessions** are separate `claude` processes: a session
  dispatches with its own settings/mode/model; a session dispatched from an
  agent view opened with `←` takes the target's `permissions.defaultMode` first,
  then the dispatching session's mode, and refuses a project/local `defaultMode`
  more permissive than the session it came from.
  (https://code.claude.com/docs/en/agent-view, "Permission mode";
  `agent-view.md:663`–`agent-view.md:690`.)
- **Forks** (`/subtask`) inherit the main session's system prompt, tools, model,
  and message history; their prompts surface in your terminal. An in-process
  teammate's own subagents must run in the foreground (no background subagents
  from in-process teammates). (https://code.claude.com/docs/en/sub-agents, "How
  forks differ from other subagents"; `sub-agents.md:1186`–`sub-agents.md:1192`;
  agent-teams limits `agent-teams.md:481`–`agent-teams.md:490`.)

---

## 8. Friction users report, and what was added to reduce it

### What users complain about (secondary)

- Subagents not honoring already-configured allow rules and prompting repeatedly:
  the built-in Plan agent ignoring parent `settings.json` permissions
  (https://github.com/anthropics/claude-code/issues/10906, 2025-11-03, open);
  background subagents denied Write/Edit even with matching allow rules while
  foreground ones succeeded (https://github.com/anthropics/claude-code/issues/67906,
  2026-06-12, closed inactive); skills/subagents not inheriting user-level
  `permissions.allow` (https://github.com/anthropics/claude-code/issues/18950,
  2026-01-18, open).
- Agent Teams: teammates ignoring `bypassPermissions` for Bash and not inheriting
  project `settings.local.json`, with "always allow" from teammate prompts not
  persisting (https://github.com/anthropics/claude-code/issues/26479, 2026-02-18,
  open); "too many permission prompts" is called out in the docs themselves
  (agent-teams.md:446).
- Allow-rule ergonomics: "don't ask again" saving verbatim command strings so
  near-identical commands re-prompt
  (https://github.com/anthropics/claude-code/issues/86151, 2026-08-12, open);
  suggested "always allow" patterns too narrow to match variations
  (https://github.com/anthropics/claude-code/issues/83406, 2026-08-02, open);
  workflow subagents ignoring mid-session allow rules and a display/rule name
  mismatch ("Fetch" vs `WebFetch`) producing hundreds of prompts
  (https://github.com/anthropics/claude-code/issues/80621, 2026-07-23, open).
- A maintainer reproduced and closed a deny-rule-in-subagent report as fixed on
  2.1.233 (`permissions.deny` Bash rules are enforced in subagent shells)
  (https://github.com/anthropics/claude-code/issues/78797, 2026-07-18, closed
  2026-08-17) — evidence that some gaps are transient regressions, not the design.

### What Claude Code added (primary)

- **Auto mode** replacing routine prompts with a classifier, and from v2.1.283
  the built-in starting mode for interactive terminal/VS Code
  (`permission-modes.md:13`, `permission-modes.md:70`).
- **Sandbox auto-allow**: with sandboxing on and `autoAllowBashIfSandboxed`
  default `true`, sandboxed Bash runs without prompting even against a bare
  `Bash` ask rule; plan mode skips the substitution.
  (https://code.claude.com/docs/en/permissions, "How permissions interact with
  sandboxing"; `permissions.md:636`–`permissions.md:657`.)
- **`/permissions`** lists every rule and its source file and applies edits to the
  running turn; prompted "Yes, and switch to auto mode" on Bash prompts (v2.1.247+).
  (https://code.claude.com/docs/en/permissions, "Manage permissions";
  `permissions.md:76`–`permissions.md:90`; `permission-modes.md:147`–`permission-modes.md:155`.)
- **Read-only command set** runs without prompting in every mode, and compound
  commands/wrappers are parsed so rules match subcommands.
  (https://code.claude.com/docs/en/permissions, "Read-only commands" and
  "Compound commands"; `permissions.md:221`–`permissions.md:262`,
  `permissions.md:263`–`permissions.md:302`.)
- **`/auto-mode-setup` and `autoMode.environment`** to teach the classifier
  trusted infrastructure, plus an auto-mode tab in `/permissions`.
  (https://code.claude.com/docs/en/auto-mode-config; `auto-mode-config.md:20`–`auto-mode-config.md:26`,
  `auto-mode-config.md:276`.)
- **Prompt relay to remote surfaces** (channels permission relay v2.1.234+;
  Remote Control/mobile) (`channels-reference.md:440`–`channels-reference.md:446`).

---

## Design implications for pi-bouncer (analysis, not a source claim)

- Claude Code is a **session-wide** model: there is no per-child permission set
  in the file format. Per-child behaviour is limited to `permissionMode` (one
  direction, parent-gated) plus `tools`/`disallowedTools`. pi-bouncer's per-child
  permission sets go beyond what Claude Code models, so there is no gold-standard
  semantics to copy for "a restricted orchestrator delegates to a looser child" —
  Claude Code permits a looser child only when the parent is in
  default/dontAsk/plan, never above `bypassPermissions`.
- The two Claude Code mechanisms worth mirroring: **deny-wins across every
  scope/level with lists merging**, and **project grants gated on a trust
  decision while project deny/ask always apply**. Those two rules are the core of
  its "project files may loosen, but only after trust" answer.
- Claude Code's answer to "can a child forge identity" is *not* identity checks
  in the permission engine; it is (a) definitions chosen by scope priority, (b)
  hook `agent_type` from the definition, and (c) output scanning + "no agent
  message carries user authority". Its own issue tracker shows that layer
  producing recurring gaps (#78063, #81852, #71602, #83421).

---

## Unknowns / not settled

1. No documented guard, and no first-party statement, about a nested `claude`
   invoked from the Bash tool or `--dangerously-skip-permissions` used from
   inside a session; only auto-mode's classifier bullet and `--restricted` apply,
   and this report could not confirm a dedicated check. (`unknown`)
2. What permission mode an agent-team teammate starts in when the lead is in
   `dontAsk` (docs say only "not inherited"). (`unknown`)
3. Whether `--inherit-permission-mode` is a real, working CLI flag: a GitHub
   report claims it is accepted by the CLI but has no effect
   (https://github.com/anthropics/claude-code/issues/89911, 2026-08-26, open);
   it is not in the CLI reference fetched 2026-10-02. (`unknown`)
4. Exact boundary of the subagent output scan (which patterns force a marker line)
   beyond the examples in the docs, and its coverage in v2.1.210–current across
   tool-result streams (the docs describe the scan; issue #75372 reports
   fabricated `<system-reminder>` blocks still reaching the parent). (`unknown`)
5. Whether deny/ask rules from a *managed* source are enforced against
   plugin/mod tool calls identically on personal accounts vs Team/Enterprise; the
   docs describe a plan-dependent default. (`unknown`)
6. No first-party confirmation that the background-subagent allow-rule denial
   (#67906) and teammate-inheritance failures (#26479) are fixed on current
   versions; both remain open/closed-inactive, so current-version behaviour is
   unverified here. (`unknown`)
7. Claude Code is closed source; no pinned binary or commit was inspected, so all
   behavioural claims are documentation-level, not code-level. (`unknown`)
8. The docs are living and quote per-feature version gates up to v2.1.287; a
   behaviour gated above a reader's installed version may differ. The exact
   installed version was not interrogated. (`unknown`)

---

## Source index

Docs (all fetched 2026-10-02 from `https://code.claude.com/docs/en/<page>.md`;
local copies under `/tmp/cc/` for this task):

- `sub-agents.md` — subagent definition, scopes, tools, permission modes,
  foreground/background prompts, output scanning, nesting, forks.
- `permissions.md` — rule syntax, deny/ask/allow order, settings precedence,
  managed locks, project trust, working directories, sandbox interaction, hooks.
- `permission-modes.md` — modes, starting mode, auto mode, classifier decision
  order and subagent handling, critical paths, protected paths.
- `settings.md` — settings scopes, precedence, list merging, broken-file handling.
- `settings-reference.md` — permission keys, `allowManagedPermissionRulesOnly`,
  `permissions.defaultMode`, `disableBypassPermissionsMode`,
  `skipDangerousModePermissionPrompt`.
- `hooks.md` — `PreToolUse`, `PermissionRequest`, permission update entries
  (`setMode`, `addRules`, destinations), `ConfigChange`, `SubagentStart/Stop`,
  hook locations and subagent input fields.
- `agent-teams.md` — teammate permissions, subagent definitions for teammates,
  inter-agent messaging, permissions-at-spawn limitation, friction note.
- `agent-view.md` — background sessions, dispatch defaults, permission-mode
  demotion rule.
- `workflows.md` — workflow launch approval and spawned-agent permission rules.
- `plugins_components.md` / `plugins_security.md` — plugin agent frontmatter
  restrictions, plugin default settings, plugin process trust.
- `env-vars.md` / `cli-reference.md` — `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`,
  `--permission-mode`, `--dangerously-skip-permissions`,
  `--allow-dangerously-skip-permissions`, `--restricted`, `--safe-mode`,
  `--permission-prompts`, `--permission-prompt-tool`.
- `managed-settings.md` / `errors.md` — invalid managed entries, fail-closed keys,
  malformed-rule and `--agents` errors.
- `security.md` / `headless.md` / `channels-reference.md` / `sdk-permissions.md` —
  trust safeguards, unattended prompt handling, permission relay, SDK evaluation
  order and subagent-inheritance warning.

GitHub issues (secondary; `https://github.com/anthropics/claude-code/issues/<n>`):
10906, 18950, 23983, 26479, 65784, 67906, 70143, 71602, 75372, 78063, 78797,
80621, 81852, 82150, 82418, 83406, 83421, 86151, 88837, 89064, 89911, 96208.
