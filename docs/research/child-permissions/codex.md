# How OpenAI Codex handles permissions, and what a subagent may do relative to its parent

**Question.** How does OpenAI Codex (CLI, `github.com/openai/codex`) handle permissions —
approval policies, sandbox modes, exec policy / command rules (`execpolicy`, `.rules` files,
`prefix_rule`), profiles — and how do these apply to subagents / multi-agent features
(spawned agents, `codex exec` children, collab/agents tools, MCP server mode)? Specifically:
config layers and precedence, project trust, approval/sandbox rules, whether a child can get
more than its parent, how child approvals reach the user, nested `codex` run from a shell, and
invalid-config handling.

**Short answer.** Codex separates two layers: an **approval policy** (when the agent must ask)
and an **OS-enforced sandbox** (what it can touch), plus optional `execpolicy` `.rules` that
allow/prompt/forbid specific command prefixes. Config is merged from many layers, and a
**trusted project's `.codex/config.toml` outranks user config** and may set `sandbox_mode` and
`approval_policy` (no deny-list entry stops it), while an **untrusted project's `.codex/` layer
is ignored entirely** and its commands default to the stricter internal `UnlessTrusted`
approval policy. For subagents, this commit **forbids a child from exceeding its parent's
permissions**: a custom agent role file can only select model/instructions and *disable*
capabilities, while the runtime re-applies the parent turn's approval policy and permission
profile over it, and multi-agent V2 intersects parent and child permission profiles. The docs
claim a role file can set `sandbox_mode`; the pinned source and its tests contradict that.
Nested `codex` invocation is not blocked by any Codex-level check — only the inherited OS
sandbox constrains it. Malformed config is a hard error except in untrusted projects, where a
parse failure is silently downgraded to an empty layer.

**Date:** 2026-10-02.

**Versions checked.**
- Source: `openai/codex` at commit `ca466061d64f0b44f416135c7fd06aa7af850bbc` (2026-10-02T10:44:29Z),
  obtained with `git clone --depth 1 https://github.com/openai/codex.git && git log -1`. All
  `path:line` citations below are at that commit; the workspace `version` is `0.0.0` (monorepo),
  so the commit SHA is the pin. Docs reference released versions 0.114, 0.115, 0.134.0 and
  0.138.0; the pinned commit is not labeled with a release number.
- Docs: `developers.openai.com/codex/*` pages fetched 2026-10-02. These pages are unversioned,
  so they are a secondary/possibly-newer source beside the pinned commit.

---

## 1. Config layers, precedence, profiles, and project trust

- Codex merges configuration from ordered layers; higher precedence overrides lower. The
  precedence numbers in source are: `PackagedDefaults` -10, `Mdm` 0, `System` 10,
  `EnterpriseManaged` 15, `User` 20 (User profile 21), `Project` 25, `SessionFlags` 30,
  `LegacyManagedConfigTomlFromFile` 40, `LegacyManagedConfigTomlFromMdm` 50 —
  `codex-rs/config/src/config_layer_source.rs:29-53`. (A trusted project therefore outranks
  user config, and CLI overrides outrank the project.)
- The loader comment lists the same order in words: package defaults, admin, system
  `/etc/codex/config.toml`, enterprise cloud bundle, user `${CODEX_HOME}/config.toml`, selected
  profile `${CODEX_HOME}/<name>.config.toml`, then cwd/tree/repo `.codex/config.toml` layers
  (loaded but disabled when the directory is untrusted), then runtime flags —
  `codex-rs/config/src/loader/mod.rs:118-137`.
- Profiles in the current scheme are separate files, not a `[profiles.<name>]` table under
  `config.toml`: `--profile <name>` overlays `~/.codex/<name>.config.toml` on the base user
  config, below project and CLI config —
  `developers.openai.com/codex/config-advanced` (Profiles), and the loader errors if the legacy
  `profile = "..."` selector or `[profiles.<name>]` table still exists in the base user file
  (`codex-rs/config/src/loader/mod.rs:304-320`).
- CLI overrides are applied as a `SessionFlags` layer via dotted-path TOML writes
  (`--config key=value`), alongside dedicated flags such as `--model`, `--sandbox`/`-s`, and
  `--ask-for-approval`/`-a` — `codex-rs/config/src/config_layer_source.rs:47`,
  `codex-rs/utils/cli/src/shared_options.rs:39-42`,
  `codex-rs/tui/src/cli.rs:70-72`.
- A project layer is loaded only when the project is trusted; if untrusted, Codex ignores
  project `.codex/` layers, including `.codex/config.toml`, project-local hooks, and
  project-local rules, and prints a disabled reason — `codex-rs/config/src/loader/mod.rs:1044-1112`,
  `developers.openai.com/codex/config-advanced` (Project config files).
- Trust is recorded as `[projects."<path>"] trust_level = "trusted" | "untrusted"` and can also
  come from managed config — `codex-rs/protocol/src/config_types.rs:642-645`,
  `codex-rs/config/src/loader/mod.rs:1042-1105`,
  `developers.openai.com/codex/config-file/config-reference` (`projects.<path>.trust_level`).
- Project config may not set a specific deny-list of keys, stripped before merge:
  `openai_base_url`, `chatgpt_base_url`, `apps_mcp_product_sku`, `responses_api_metadata`,
  `model_provider`, `model_providers`, `notify`, `profile`, `profiles`,
  `experimental_realtime_webrtc_call_base_url`, `experimental_realtime_ws_base_url`, `otel` —
  `codex-rs/config/src/loader/mod.rs:88-100` and applied at `:1150-1163`. Note the source list
  adds `responses_api_metadata` and `experimental_realtime_webrtc_call_base_url` and spells the
  key `experimental_realtime_webrtc_call_base_url`; the docs' list omits those two
  (`developers.openai.com/codex/config-file/config-reference`).
- **A trusted project can loosen sandboxing or approvals** relative to user config:
  `sandbox_mode`, `sandbox_workspace_write.*`, and `approval_policy` are *not* on the deny-list
  (`codex-rs/config/src/loader/mod.rs:88-100`) and the `Project` layer (25) overrides the `User`
  layer (20) (`codex-rs/config/src/config_layer_source.rs:39-47`). No code path re-restricts a
  trusted project's `sandbox_mode` to the user's value (search of the config loader found no
  such clamp). This is inferred from the precedence + deny-list code, not asserted by a test.
- `projects.<path>.trust_level` is the documented trust control
  (`developers.openai.com/codex/config-file/config-reference`), and the retired top-level
  `approval_policy = "untrusted"` is replaced by relying on project trust: omitting an explicit
  `approval_policy` plus marking the project untrusted makes commands require approval unless an
  execution-policy rule allows them —
  `developers.openai.com/codex/agent-approvals-security` (Migrate from the retired `untrusted`
  approval policy).
- Project-root discovery walks up from cwd; a directory containing `.git` is the root by
  default, configurable via `project_root_markers` (set `[]` to treat cwd as root) —
  `developers.openai.com/codex/config-advanced` (Project root detection).

## 2. Approval policies, sandbox modes, and exec policy / command rules

- `AskForApproval` has four variants: `UnlessTrusted` (internal policy for projects marked
  untrusted; commands require approval unless an explicit exec-policy rule allows them),
  `OnRequest` (the default; aliased `on-failure`), `Granular(...)` (per-category prompt
  on/off), and `Never` — `codex-rs/protocol/src/protocol.rs:986-1032`. `on-request` and `never`
  are the CLI values; `on-failure` is deprecated
  (`developers.openai.com/codex/config-file/config-reference`).
- `untrusted` is no longer a valid user-set `approval_policy`: configuring it is a hard startup
  error (`approval_policy = "untrusted" is no longer supported; remove this setting`) —
  `codex-rs/core/src/config/mod.rs:230` and `:3739-3744`. It remains supported as an *internal*
  derived policy (see below) and in project trust entries.
- If no approval policy is explicitly configured, Codex derives one from project trust: trusted
  project → `OnRequest`, untrusted project → `UnlessTrusted`, otherwise the enum default —
  `codex-rs/core/src/config/mod.rs:3746-3765`. An explicit `on-request` overrides the
  project-derived policy; managed `allowed_approval_policies` must include `untrusted` to permit
  it (`developers.openai.com/codex/agent-approvals-security`).
- Sandbox modes are `read-only`, `workspace-write`, and `danger-full-access` —
  `codex-rs/protocol/src/config_types.rs:104-114`. `workspace-write` keeps network access off by
  default and makes `<writable_root>/.git`, `.agents`, and `.codex` read-only recursively —
  `developers.openai.com/codex/agent-approvals-security` (Protected paths in writable roots).
- Beta **permission profiles** (`default_permissions` + `[permissions.<name>]`) combine
  filesystem and network rules and do not compose with the older `sandbox_mode` /
  `sandbox_workspace_write` settings; built-ins are `:read-only`, `:workspace`,
  `:danger-full-access`, and a profile cannot `extends = ":danger-full-access"` —
  `developers.openai.com/codex/permissions`.
- Decision logic for a command combines approval policy, sandbox kind, and rule matches: a
  dangerous command (or a managed-filesystem profile with no Windows sandbox backend) is
  `Prompt` under `OnRequest`/`UnlessTrusted`/`Granular` and `Forbidden` under `Never`; otherwise
  `Never` → `Allow` (sandbox is the protection), `UnlessTrusted` → `Prompt`, `OnRequest` →
  `Allow` inside a restricted sandbox unless the command requests a sandbox override (then
  `Prompt`), and `Granular` mirrors `OnRequest` with per-category rejects —
  `codex-rs/core/src/exec_policy.rs:800-855`.
- `apply_patch` is assessed similarly: `UnlessTrusted` always asks; otherwise writes confined to
  writable paths auto-approve, and everything else asks (or is rejected under `Never`/granular
  with `sandbox_approval = false`) — `codex-rs/core/src/safety.rs:72-118`.
- Exec policy files are Starlark `.rules` files under a `rules/` folder next to an active config
  layer (e.g. `~/.codex/rules/default.rules`); `prefix_rule(pattern, decision, justification,
  match, not_match)` supports `allow`, `prompt`, `forbidden`, and Codex applies the most
  restrictive matching decision — `developers.openai.com/codex/agent-configuration/rules`.
- Source confirms rule loading from every active config layer's `rules/` dir, low-to-high
  precedence so higher layers can override, with project rules included only via trusted
  (enabled) layers; an admin requirements overlay is merged last —
  `codex-rs/core/src/exec_policy.rs:658-710`. The `rules/` dir name and `.rules` extension are
  `codex-rs/core/src/exec_policy.rs:54-55`.
- "Most restrictive wins" is real ordering: `Decision` derives `Ord` in the order
  `Allow < Prompt < Forbidden`, and evaluation takes `.max()`
  (`codex-rs/execpolicy/src/decision.rs:6-16`,
  `codex-rs/execpolicy/src/execpolicycheck.rs:63`).
- A prompt from a `prompt` rule is rejected outright under `Never`, and under `Granular` it is
  rejected when `rules = false`; sandbox-escalation prompts are rejected when
  `sandbox_approval = false` — `codex-rs/core/src/exec_policy.rs:51-53`, `:216-232`.
- Shell wrappers are parsed specially: a `bash -lc` script that is a linear chain of plain words
  joined by `&&`, `||`, `;`, `|` is split (tree-sitter) and each command evaluated separately;
  scripts using redirection, substitution, variables, globs, or control flow are treated as the
  single invocation `["bash","-lc","<script>"]` —
  `developers.openai.com/codex/agent-configuration/rules` (Shell wrappers and compound
  commands).
- `codex execpolicy check --rules <file> -- <cmd>` shows the strictest decision and matching
  rules, including `justification` text —
  `developers.openai.com/codex/agent-configuration/rules` (Test a rule file).
- `codex exec` (`--ignore-rules`, `--ignore-user-config`, `--strict-config`) defaults its
  approval policy to `Never` for headless runs unless the resolved reviewer is AutoReview —
  `codex-rs/exec/src/cli.rs:25-45`, `codex-rs/exec/src/lib.rs:588-591`.

## 3. Subagents / multi-agent: are they present, and can a child exceed its parent?

- Multi-agent tooling is present and on by default: `features.multi_agent` enables
  `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, and `close_agent`; `agents.enabled`
  also defaults to true —
  `developers.openai.com/codex/config-file/config-reference` (`features.multi_agent`,
  `agents.enabled`). There are V1 and V2 multi-agent backends (`MultiAgentVersion`) —
  `codex-rs/core/src/agent/child_config.rs:18`.
- Custom agents are declared with `[agents.<name>]` (`description`, `config_file`,
  `nickname_candidates`) in `config.toml`, or as standalone TOML files under `~/.codex/agents/`
  or `.codex/agents/`; each file is a session config layer and must define `name`, `description`,
  `developer_instructions` —
  `codex-rs/config/src/config_toml.rs:753-796`,
  `codex-rs/agent-roles/src/agent_role_config.rs:10-70`,
  `developers.openai.com/codex/agent-configuration/subagents` (Custom agents).
- Role overrides are an **allow-list**: `AgentRoleOverrides` carries only
  `developer_instructions`, `model`, `model_reasoning_effort`, `model_reasoning_summary`,
  `model_verbosity`, `personality`, `service_tier`, `features` (disable-only), and `skills`
  (disable-only) — `codex-rs/core/src/agent/role.rs:32-44`, `:100-127`. The top comment states
  the intent: "Roles may customize the child or reduce its capabilities, but never replace the
  parent session's authority" — `codex-rs/core/src/agent/role.rs:1-4`.
- A role file that tries to set `sandbox_mode`, `approval_policy`, `model_provider`,
  `openai_base_url`, `chatgpt_base_url`, `notify`, `apps`, or `mcp_servers` has those keys
  discarded; tests assert the child config equals the parent for permissions, provider, apps,
  MCP servers, notify, and gateway URLs, and that the projected role layer contains none of
  those keys — `codex-rs/core/src/agent/role_tests.rs:437-540` (`apply_role_cannot_expand_parent_authority`).
- A role's `[sandbox_workspace_write] writable_roots` is likewise ignored:
  `apply_role_preserves_parent_sandbox_permissions` asserts `config.permissions ==
  parent_permissions` after applying such a role —
  `codex-rs/core/src/agent/role_tests.rs:396-436`. **This contradicts the docs**, which say you
  can override the sandbox for a custom agent and that `sandbox_mode`/`mcp_servers` are
  inheritable settable keys (`developers.openai.com/codex/agent-configuration/subagents`,
  "Approvals and sandbox controls", "Custom agent file schema").
- A child's config is built from the parent's effective config, then the invoking step's model
  and the parent turn's approval policy, approvals reviewer, cwd, and permission-profile
  snapshot are copied onto it — `codex-rs/core/src/agent/child_config.rs:104-194`
  (`build_agent_shared_config`, `apply_spawn_agent_runtime_overrides`).
- Ordering at spawn is: parent snapshot + model overrides → apply role → re-apply runtime
  overrides — `codex-rs/core/src/agent/child_config.rs:56-96`. So even if a role could express a
  permission change, the parent turn's runtime policy is reapplied afterward, overwriting it;
  `spawn_agent_reapplies_runtime_sandbox_after_role_config` asserts a role config must discard
  the runtime permission override before it is reapplied —
  `codex-rs/core/src/tools/handlers/multi_agents_tests.rs:2297-2450`.
- In multi-agent V2, when a child proposes an environment permission profile that differs from
  the owner's, Codex calls `intersect_effective_permission_profiles`, which computes the set
  intersection of filesystem grants and enables network only if *both* profiles do; it fails
  closed for external/platform-default/unsupported shapes —
  `codex-rs/core/src/agent/control/spawn.rs:540-560`,
  `codex-rs/protocol/src/permission_profile_intersection.rs:37-150`. Intersection means the
  child can never gain authority the parent lacks.
- Resume/reload keeps the same guarantee: for a role-named V2 child, Codex reapplies the role
  and then restores the runtime approval policy, reviewer, cwd, and permission-profile snapshot
  — `codex-rs/core/src/agent/control/spawn.rs:415-460`.
- `[agents]` config exposes only `enabled`, `max_concurrent_threads_per_session`
  (legacy alias `max_threads`), `max_depth` (V1 only; ignored by V2), `default_subagent_model`,
  `default_subagent_reasoning_effort`, and `interrupt_message` — none of which set a sandbox or
  approval policy — `codex-rs/config/src/config_toml.rs:753-776`.
- The child cannot alter its inherited execution policy: loading/resuming a V2 child checks
  `child_uses_parent_exec_policy`, comparing the set of exec-policy config folders, the
  ignore-rules flag, and the requirements exec policy, and refuses the child if they differ —
  `codex-rs/core/src/exec_policy.rs:183-201`,
  `codex-rs/core/src/agent/control/spawn.rs:471-479`.
- **Docs agree on the direction, source proves it:** "Subagents inherit your current sandbox
  policy" and "Choose the permission mode for the parent turn before you ask Codex to
  delegate" — `developers.openai.com/codex/agent-configuration/subagents` (Approvals and sandbox
  controls). The source additionally blocks any per-role permission set, loosening *or*
  tightening, in this commit.
- Child approval requests reach the user through the same client/app-server request channel: a
  server request carries the child thread id, and the TUI reads the child thread's source
  (`SessionSource::SubAgent(ThreadSpawn { parent_thread_id, .. })`) to route the request to the
  owning parent/overview — `codex-rs/tui/src/app/app_server_events.rs:724-760`. Analytics label
  this source `DelegatedSubagent` —
  `codex-rs/analytics/src/events.rs:338`. The agent-review context says an approval of one
  parent action "does not grant general child permission" —
  `codex-rs/guardian-context/src/authorization.rs:54`.
- Subagents inherit the parent's configured MCP servers; there is an open request to allow a
  subagent to opt out ("Per-agent MCP server scoping: allow subagents to opt out of inherited
  MCP servers", issue #20135, open), which is consistent with role files not controlling
  `mcp_servers` in this commit
  (`codex-rs/core/src/agent/role_tests.rs:437-540`).
- `agents.max_depth` bounds V1 nesting depth only (`depth > max_depth` is rejected) and is
  documented as ignored by V2 — `codex-rs/core/src/agent/registry.rs:84-86`,
  `codex-rs/config/src/config_toml.rs:761-762`.

## 4. Nested `codex` run from the shell inside a session

- Codex sets `CODEX_SANDBOX=seatbelt` on macOS seatbelt runs and
  `CODEX_SANDBOX_NETWORK_DISABLED=1` when network is restricted, so the sandbox state is visible
  to descendants — `codex-rs/core/src/spawn.rs:19-26`, `codex-rs/core/src/sandboxing/mod.rs:166-179`.
- In this commit `CODEX_SANDBOX` is **read** only by the macOS doctor network check
  (`codex-rs/cli/src/doctor/network.rs:124`) and the macOS/seatbelt login credential path
  (`codex-rs/login/src/auth/default_client.rs:472`); nothing in the CLI or core refuses to start
  `codex` when it is already set. A repository-wide search for `CODEX_SANDBOX` found no guard
  against launching a nested, less-restricted `codex` (command:
  `rg -n 'CODEX_SANDBOX' codex-rs`). `NON_INHERITABLE_ENV_VARS` scrubs exec-server/auth tokens,
  not sandbox markers — `codex-rs/protocol/src/shell_environment.rs:12-21`.
- Consequence: a nested `codex --dangerously-bypass-approvals-and-sandbox` (alias `--yolo`,
  `codex-rs/utils/cli/src/shared_options.rs:56-63`) would still be executed *inside* the
  inherited OS sandbox, so it can drop Codex's own approval layer but not lift the parent
  kernel sandbox; on macOS that would be nested Seatbelt (seatbelt tests note nested Seatbelt
  must be available: `codex-rs/sandboxing/src/seatbelt_tests.rs:169`, `:339`). Whether nested
  Seatbelt/bwrap reliably intersects the two policies is not asserted by any in-repo test, so
  treat "nested codex cannot escape the OS sandbox" as `unknown` at this commit.
- `codex exec` children are independent processes: each resolves its own config layers
  (`codex-rs/exec/src/lib.rs:588-605`) and defaults to `approval_policy = Never`, so a child
  `codex exec` inherits the OS sandbox of the shell that launched it but is not constrained by
  the launcher's approval policy — `codex-rs/exec/src/lib.rs:588-591`.

## 5. Invalid config handling

- Malformed TOML in a required layer is always a hard error (`toml::from_str` failure →
  `io::ErrorKind::InvalidData`), even without strict mode — `codex-rs/config/src/loader/layer_io.rs:146-177`.
- In a *trusted* project, a parse error in `.codex/config.toml` is a hard error; in an
  *untrusted* project the same error is swallowed and the layer is recorded as an empty,
  disabled layer — `codex-rs/config/src/loader/mod.rs:1708-1740` (and the analogous hooks path at
  `:1818-1860`).
- Unknown/ignored fields produce a startup warning by default (`ignored_config_warning`,
  `codex-rs/config/src/strict_config.rs:205-234`); passing `--strict-config` (or
  `codex exec --strict-config`) turns unknown fields into errors —
  `codex-rs/config/src/loader/layer_io.rs:176-203`,
  `codex-rs/exec/src/cli.rs:20-22`, `codex-rs/cli/src/main.rs:317`.
- When a configured value is disallowed by managed requirements, Codex logs a warning, pushes a
  startup warning, and **falls back to the requirement-compliant value** rather than failing —
  `codex-rs/core/src/config/mod.rs:2261-2290`, `:4109-4115`. Two exceptions are hard errors:
  `approval_policy = "untrusted"` (`:3739-3744`) and the combination where a fallback would
  leave `approval_policy = "never"` with read-only permissions because
  `danger-full-access` is disallowed — `codex-rs/core/src/config/mod.rs:4127-4143`.
- Requirement constraints report the requirement source in their errors
  (`invalid value for <field>: <candidate> is not in the allowed set <allowed> (set by
  <requirement_source>)`) — `codex-rs/config/src/constraint.rs:9-19`.
- Project config keys on the deny-list are stripped and surfaced as a startup warning
  (`project_ignored_config_keys_warning`) rather than an error —
  `codex-rs/config/src/loader/mod.rs:1150-1163`, `:1740-1748`.

## 6. Friction themes from GitHub issues, and mitigations added

- Too many / repeated approval prompts is a recurring theme in the tracker: "Excessive approval
  prompts and slow time to first code change" (#47134, open), "Parallel Codex sessions become
  unusable due to repeated approval prompts" (#37827, open), "Codex asks for permission despite
  full access and approval prompts disabled" (#29235, open), "Unexpected approval prompt for
  writes inside workspace with workspace-write" (#34185, open), and
  "Full Access blocks commands without an approval prompt on Windows" (#47213, open) —
  `gh search issues --repo openai/codex 'approval prompts'` (2026-10-02).
- Subagent-specific friction: "Subagents' permission requests do not trigger a pop-up
  notification on Windows" (#26005, open), "Review-mode subagent ignores runtime sandbox
  override and falls back to config defaults" (#15305, open), "[0.160.0] Reconnect
  leaks/bleed sub-agent approval queues and output into unrelated sessions" (#50233, open), and
  "Per-agent MCP server scoping: allow subagents to opt out of inherited MCP servers" (#20135,
  open) — `gh search issues --repo openai/codex 'subagent permissions'` and `'mcp-server'`.
- Sandbox/permission-boundary friction: "sandbox_permissions: Landlock read restrictions not
  enforced" (#11316, open), "Symlinks in `permissions.*.filesystem` dropped instead of
  passed-through to bwrap with real path" (#34530, open), and "danger-full-access still
  advertises no-op require_escalated capability" (#35974, open) —
  `gh search issues --repo openai/codex 'sandbox permissions'`.
- Mitigations present in the pinned source/docs:
  - Granular approval policy (`approval_policy = { granular = { sandbox_approval, rules,
    mcp_elicitations, request_permissions, skill_approval } }`) to keep some prompts interactive
    while auto-rejecting others — `codex-rs/protocol/src/protocol.rs:1010-1046`,
    `developers.openai.com/codex/config-file/config-reference`.
  - Automatic approval review (`approvals_reviewer = "auto_review"`, alias
    `guardian_subagent`; CLI `--approve-for-me`/`--not-so-yolo`) routes eligible prompts through
    a reviewer subagent instead of the human; failures "fail closed" —
    `codex-rs/protocol/src/config_types.rs:183-205`,
    `codex-rs/utils/cli/src/shared_options.rs:37-55`,
    `developers.openai.com/codex/agent-approvals-security` (Automatic approval reviews).
  - Session-scoped approvals ("Accept for session" / `ApprovedForSession`) so one grant can
    cover repeated identical requests — `codex-rs/core/src/session/mod.rs:2976`.
  - Rules-based prefix allowances written to `~/.codex/rules/default.rules` when a command is
    added to the TUI allow list, and "Smart approvals" proposing a `prefix_rule` during
    escalation — `developers.openai.com/codex/agent-configuration/rules`.
  - Permission profiles (`default_permissions`, `[permissions.<name>]`) to scope filesystem and
    network access precisely instead of asking per command —
    `developers.openai.com/codex/permissions`.
  - `--dangerously-bypass-approvals-and-sandbox` / `--yolo` for users who accept full access —
    `codex-rs/utils/cli/src/shared_options.rs:56-63`.

## Unknowns

1. **Docs vs source on role permissions.** The live docs say a custom agent file can set
   `sandbox_mode`, `mcp_servers`, and `skills.config`, and that one can be marked read-only
   (`developers.openai.com/codex/agent-configuration/subagents`); the pinned commit discards
   those keys (`codex-rs/core/src/agent/role_tests.rs:437-540`). Because the docs pages are
   unversioned, it is unresolved whether the docs describe a newer build than
   `ca466061d64f0b44f416135c7fd06aa7af850bbc` or are simply stale. `unknown`.
2. **Nested-Sandbox intersection.** No in-repo test or doc states that a nested
   `codex --dangerously-bypass-approvals-and-sandbox` under an existing Seatbelt/bwrap sandbox
   is reliably confined by the outer policy. The mechanism is OS-level and was not exercised
   here. `unknown`.
3. **Codex-level nested-codex guard elsewhere.** The search covered `codex-rs` in this commit;
   a guard could live in the desktop app, IDE extension, or app-server integration, which were
   not exhaustively checked. `unknown`.
4. **MCP server mode.** There is no `codex mcp-server` subcommand or bin in this commit (the
   `Mcp` subcommand only lists/get/add/remove/login/logout external servers:
   `codex-rs/cli/src/mcp_cmd.rs:65-81`); when or why a Codex-as-MCP-server mode was removed is
   not determinable from the depth-1 clone. `unknown`.
5. **Released version mapping.** The commit is not labeled with a release number in the
   monorepo (`version = "0.0.0"`), so exact correspondence to docs that mention 0.114, 0.115,
   0.134.0, or 0.138.0 is `unknown` without the releases page/tags.
6. **`codex exec` reviewer default.** The headless default is `approval_policy = Never` "unless
   the fully resolved reviewer is AutoReview" (`codex-rs/exec/src/lib.rs:588-591`); the exact
   condition under which AutoReview is resolved for `codex exec` was not fully traced.
   `unknown`.

## Sources

Primary (pinned source, commit `ca466061d64f0b44f416135c7fd06aa7af850bbc`; reproduce with
`git clone --depth 1 https://github.com/openai/codex.git`):

- `codex-rs/config/src/config_layer_source.rs` — layer enum and precedence.
- `codex-rs/config/src/loader/mod.rs`, `loader/layer_io.rs`, `config/src/diagnostics.rs`,
  `config/src/strict_config.rs` — loading, trust, deny-list, invalid config.
- `codex-rs/config/src/config_toml.rs`, `agent-roles/src/agent_role_config.rs` — `[agents]`
  schema and role files.
- `codex-rs/protocol/src/protocol.rs`, `protocol/src/config_types.rs` — approval/sandbox/trust
  enums.
- `codex-rs/core/src/config/mod.rs` — derived approval policy, requirements fallback, errors.
- `codex-rs/core/src/exec_policy.rs`, `execpolicy/src/*.rs` — rules loading, decisions, matrix.
- `codex-rs/core/src/safety.rs` — patch safety.
- `codex-rs/core/src/agent/role.rs`, `agent/role_tests.rs`, `agent/child_config.rs`,
  `agent/control/spawn.rs`, `agent/registry.rs` — subagent permission inheritance.
- `codex-rs/protocol/src/permission_profile_intersection.rs` — parent/child intersection.
- `codex-rs/core/src/spawn.rs`, `core/src/sandboxing/mod.rs`,
  `protocol/src/shell_environment.rs` — sandbox env markers.
- `codex-rs/tui/src/app/app_server_events.rs`, `analytics/src/events.rs`,
  `guardian-context/src/authorization.rs` — child approval routing.
- `codex-rs/cli/src/mcp_cmd.rs`, `cli/src/main.rs`, `utils/cli/src/*`, `exec/src/{cli,lib}.rs` —
  subcommands and flags.

Secondary (official docs, unversioned, fetched 2026-10-02):

- `developers.openai.com/codex/config-advanced`
- `developers.openai.com/codex/config-file/config-reference`
- `developers.openai.com/codex/agent-approvals-security`
- `developers.openai.com/codex/permissions`
- `developers.openai.com/codex/agent-configuration/rules` (also served at `/codex/exec-policy`)
- `developers.openai.com/codex/agent-configuration/subagents`
- `developers.openai.com/codex/extend/mcp`

Issue-tracker evidence (GitHub issues, open unless noted), via
`gh search issues --repo openai/codex`: #47134, #37827, #29235, #34185, #47213, #26005, #15305,
#50233, #20135, #11316, #34530, #35974.
