# How @gotgenes/pi-permission-system handles permissions for subagents

**Question.** How does `@gotgenes/pi-permission-system` (with
`@gotgenes/pi-subagents`) handle permissions for subagents: per-agent config
locations and merge semantics, child identity and forgeability, modes,
invalid/missing config, ask forwarding, where it prompts, and evidence of
friction?

**Short answer.** Per-agent policy is YAML frontmatter (`permission:`) in
`~/.pi/agent/agents/<agent>.md` and `<cwd>/.pi/agents/<agent>.md`, merged on top
of global and project config files with **override-wins** semantics — an agent
can loosen as well as tighten, and the project scopes are gated on Pi project
trust. A child is identified by an in-process registry (event-bus announcement
from pi-subagents), by env vars, or by a session-directory heuristic; the
agent's *name* comes from a `<active_agent name="…"/>` system-prompt tag that
pi-subagents writes and that the permission system trusts verbatim, with no
authenticity check. `yoloMode` is a file-config knob only (not per-agent) and
is re-evaluated per node; a forwarded ask is re-resolved against the *serving*
node's rules and yolo state. Invalid non-global scopes clamp `allow`→`ask`;
missing files are empty scopes. A child's `ask` forwards as request/response
files under the agent dir, the parent's UI answers, and a dead/absent parent
fails closed after a ~2 s grace (headless) or falls back to the child's own
dialog (child with UI). The project's own issues show heavy prompt fatigue and
forwarding breakage as the main friction.

## Sources and versions checked

- Date: 2026-10-02 (UTC).
- `gotgenes/pi-packages` at commit
  `3eb40befbcf490785fd50782017b64947aa8b1ca` (default branch `main`, committed
  2026-10-02T06:02:22Z), fetched with
  `gh api repos/gotgenes/pi-packages/tarball/3eb40be...`.
- `@gotgenes/pi-permission-system` version **37.0.0** at that commit
  (`packages/pi-permission-system/package.json`).
- `@gotgenes/pi-subagents` version **21.9.1** at that commit
  (`packages/pi-subagents/package.json`).
- Pi CLI flag reference: `@earendil-works/pi-coding-agent` `docs/cli.md`
  (installed copy at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/cli.md`).
- Every `packages/…` path below is at commit `3eb40be` unless stated. The old
  standalone repos `gotgenes/pi-permission-system` and `gotgenes/pi-subagents`
  are archived ("Moved to gotgenes/pi-packages"), so the monorepo is the only
  current source (`gh api repos/gotgenes/pi-permission-system`).

## 1. Per-agent permission config: locations, merge order, semantics, trust

[C1] Config file scopes: global
`~/.pi/agent/extensions/pi-permission-system/config.json` (respects
`PI_CODING_AGENT_DIR`) and project
`<cwd>/.pi/extensions/pi-permission-system/config.json`
(`packages/pi-permission-system/docs/configuration.md:5-9`;
`src/config/config-paths.ts:12,20`).

[C2] Per-agent frontmatter scopes: global `~/.pi/agent/agents/<agent>.md` and
project `<cwd>/.pi/agents/<agent>.md`
(`docs/configuration.md:1081-1113`). The global dir is
`join(getAgentDir(), "agents")` (`src/config/policy-loader.ts:109`); the project
dir is `join(cwd, ".pi", "agents")` (`src/config/config-paths.ts:33`).
`@gotgenes/pi-subagents` independently encodes the same two dirs
(`packages/pi-subagents/src/config/custom-agents.ts:23-29`).

[C3] Precedence (later wins): global config file < project config file < global
agent frontmatter < project agent frontmatter
(`docs/configuration.md:31-36`; enforced at
`src/policy/permission-manager.ts:187-192`, which merges scopes in the order
`global, project, agent, project-agent`).

[C4] Merge semantics are deep-shallow, override-wins: string-vs-string
replaces, object-vs-object shallow-merges the pattern map (higher scope's
patterns win per key), string-vs-object the override wins entirely
(`docs/configuration.md:38-41`; `src/policy/permission-merge.ts:5-6,19-36`;
`src/policy/scope-merge.ts:53-71`).

[C5] Because higher scopes override rather than clamp, **an agent can loosen
relative to the session** — e.g. a global `bash: ask` becomes `bash: allow` for
that agent. This is deliberate: ADR 0001 explicitly rejected a restrict-only
merge, on the grounds that "operators who want project-specific overrides in a
trusted directory should be able to set them"
(`docs/decisions/0001-project-trust-adoption.md:83-86`).

[C6] Only the `permission` block is read from agent frontmatter; other keys are
ignored and malformed permission entries are dropped tolerantly
(`src/config/policy-loader.ts:270-284`). Runtime knobs such as `yoloMode` and
`shellTools` are *not* per-agent (`docs/plans/0580-shell-tool-alias-config-model.md:47-48`;
`src/config/config-store.ts` merges runtime config from files only).

[C7] Project and project-agent scopes — both permission policy and the project
runtime config (`yoloMode`, `permissionReviewLog`, …) — load only when Pi
reports the project trusted (`ctx.isProjectTrusted()`)
(`docs/configuration.md:14-19`;
`src/session/permission-session.ts:112-114,140-142,219-221`;
`src/config/config-store.ts:110-152`). In an untrusted directory only global
(and global-agent) config applies, so an untrusted repo cannot loosen global
policy; a skip is warned and logged as `project_trust.skipped`
(`docs/configuration.md:16`; ADR 0001).

[C8] Global agent frontmatter is *not* project-gated — it is the operator's own
home directory, so it always applies. Only project and project-agent scopes are
withheld (`src/config/policy-loader.ts` + `derivePolicyLoaderOptions` in
`src/policy/permission-manager.ts:396-408`; `configureForCwd(undefined)` leaves
`projectGlobalConfigPath`/`projectAgentsDir` null).

[C9] The permission objects from the four scopes are merged per `(surface,
pattern)` with a parallel origin map, then normalized into rules and composed
over synthesized defaults and a baseline
(`src/policy/permission-manager.ts:187-226`).

[C10] There is a separate, orthogonal "most-restrictive-wins" rule *within* a
single check across surface layers (path vs external_directory vs bash etc.),
which is not the same as the scope merge
(`docs/configuration.md:677-692`; `src/policy/restrictiveness.ts`). A `path`
allow cannot loosen an `external_directory: ask` boundary; `deny` beats `ask`
beats `allow`.

## 2. Child identity: detection, agent name, and forgeability

### How a child is identified

[C11] Three detection signals, in priority order: (1) the process-global
`SubagentSessionRegistry` keyed by child session id, (2) env vars, (3) a
session-directory heuristic that checks whether the session dir is inside
`<agentDir>/subagent-sessions` (`src/authority/subagent-context.ts:48-80`).

[C12] The registry is a `globalThis` + `Symbol.for()` singleton, shared across
per-session jiti instances and event buses
(`src/authority/subagent-registry.ts:1-100`). It is written only by
`subscribeSubagentLifecycle`, which registers on
`subagents:child:session-created`, audits on `subagents:child:bound`, and
unregisters on `subagents:child:disposed`
(`src/authority/subagent-lifecycle-events.ts:33,78-101`).

[C13] `@gotgenes/pi-subagents` emits those events: `sessionCreated` is emitted
synchronously on the same call stack *before* `bindExtensions()`, which is the
contract that lets the parent's registry entry land before the child's own
permission instance checks detection
(`packages/pi-subagents/src/lifecycle/create-subagent-session.ts:289-294`;
`docs/subagent-integration.md:14-30`).

[C14] Env-var hints are `PI_IS_SUBAGENT`, `PI_SUBAGENT_SESSION_ID`,
`PI_AGENT_ROUTER_SUBAGENT`, `PI_SUBAGENT_CHILD`, `PI_SUBAGENT_RUN_ID`,
`PI_SUBAGENT_CHILD_AGENT`, `PI_SUBAGENT_DEPTH`, `PI_SUBAGENT_NAME`,
`PI_SUBAGENT_ID`, `PI_SUBAGENT_SESSION`, `PI_SUBAGENT_ACTIVITY_FILE`, plus the
parent-session candidates `PI_AGENT_ROUTER_PARENT_SESSION_ID` and
`PI_SUBAGENT_PARENT_SESSION` (`src/authority/permission-forwarding.ts:26-64`).
The doc calls the older per-extension markers "grandfathered for compatibility"
and says new implementations use `PI_SUBAGENT_PARENT_SESSION` only
(`docs/subagent-integration.md:50-64`).

[C15] The forwarding target is resolved registry-first (child session id →
registered `parentSessionId`), then from the env candidates in order; a
candidate equal to the reading session's own id is ignored
(`src/authority/permission-forwarding.ts:307-346`;
`docs/subagent-integration.md:62`).

### How the agent name is resolved

[C16] `PermissionSession.resolveAgentName` tries, in order: a session entry
with `type: "custom"`, `customType: "active_agent"` (last one wins), then the
`<active_agent name="…">` tag parsed out of the system-prompt string, then the
last known name (`src/session/permission-session.ts:180-194`;
`src/session/active-agent.ts:37-72`).

[C17] The tag regex is
`/<active_agent\s+name=["']([^"']+)["'][^>]*>/i` — case-insensitive, matches
anywhere in the prompt, and only trims whitespace from the captured name
(`src/session/active-agent.ts:25-34`).

[C18] `@gotgenes/pi-subagents` writes that tag into every child's system prompt
in both prompt modes (`packages/pi-subagents/src/session/prompts.ts:50-52,149-150`).
It writes no `active_agent` session entry (searched all `packages/*/src`; only
the prompt tag exists), so for a gotgenes child the name is resolved from the
tag, not the entry.

[C19] The resolved agent name is used directly as a filename:
`join(dir, \`${agentName}.md\`)` with no allowlist, existence check, or
sanitization beyond `trim()` (`src/config/policy-loader.ts:255`;
`src/session/active-agent.ts:28-34`). A name containing path separators would
therefore resolve outside the agents directory.

### Can a model forge identity?

[C20] Within its own running session, no: `resolveAgentName` reads either
session-manager entries or the `systemPrompt` argument that Pi rendered for
`before_agent_start` (`src/handlers/before-agent-start.ts:117-119`;
`src/session/permission-session.ts:180-194`). A `bash` subprocess cannot mutate
the Pi process's system prompt or its session entries, and setting an env var
inside a bash command changes only that subprocess's environment, not the Pi
process's `process.env` (`src/authority/subagent-context.ts:61-66` reads
`process.env` of the Pi process).

[C21] A model *can* spawn a nested `pi` process from `bash` with
`--append-system-prompt '<active_agent name="…"/>'`. Pi documents that flag as
appending text or a file to the system prompt and being repeatable
(`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/cli.md:219-220`).
In that new process there is no `active_agent` session entry, so
`getActiveAgentNameFromSystemPrompt` returns the forged name and the nested
node applies that agent's frontmatter (`src/session/permission-session.ts:186-192`;
`src/policy/permission-manager.ts:181-192`).

[C22] There is **no guard** that the tag is genuine. Nothing checks that the
tag was written by a subagent extension, that the named agent exists, or that
the named agent is the session's real agent; the only validation is the regex
and a `trim` (`src/session/active-agent.ts:25-34,59-72`). This is the same
channel pi-subagents itself uses, so the permission system cannot distinguish
the two producers.

[C23] The project's ADR on the policy model records the adjacent concern:
"Agent frontmatter may not declare effects; whether that channel opens is
[#799]'s question, and a subagent declaring its own tools read-only would be
self-granted relief"
(`docs/decisions/0013-permission-policy-model.md:509`). Issue #799 is still
open and asks for an ADR deciding "which channels permission policy may enter
through, and what their precedence, trust gating, and write-back semantics are"
(`gh api repos/gotgenes/pi-packages/issues/799`, state `open`, 2026-08-22). So
the trustworthiness of agent frontmatter as a channel is explicitly undecided,
not guarded.

[C24] Setting `PI_SUBAGENT_PARENT_SESSION=<current-session-id>` in a nested
`pi` process makes that process detect itself as a child and forward its asks to
the current session's UI rather than prompting locally
(`src/authority/subagent-context.ts:54-66`;
`src/authority/authorizer.ts:175-179`). Combined with a forged agent name whose
frontmatter loosens, the nested node's own gate can allow without asking. This
is a reasoned exploit chain from the code, not a test in the repo; see
`unknown` U3.

## 3. Modes (`yoloMode`) and parent/child interaction

[C25] `yoloMode` is a boolean in the unified config file schema, default
`false`, and rewrites every matched `ask` to a standing `allow` tagged
`origin: "yolo"` (`docs/configuration.md:106`; `src/config/config-schema.ts:359`;
`src/policy/permission-manager.ts:305-317`).

[C26] It is read from the merged global+project config *files* only, not from
agent frontmatter and not per-agent
(`src/config/config-store.ts:139-169`; `src/config/policy-loader.ts:270-284`
extracts only `permission`; `docs/plans/0580-shell-tool-alias-config-model.md:47-48`).

[C27] Each node (parent or child) reads its own config files and therefore its
own `yoloMode`; there is no parent→child propagation of the mode in
pi-subagents (no `yolo` reference in `packages/pi-subagents/src`). A child in a
different cwd (e.g. a worktree) with its own trusted project config can
therefore have a different mode.

[C28] A child with `yoloMode` on never forwards: its own gate rewrites the
`ask` to `allow` before escalation (`src/policy/permission-manager.ts:305-317`).

[C29] When a child does forward an `ask`, the **serving node** re-resolves the
forwarded intent against its own composed ruleset, scoped to the requester's
agent name (`principal.agentName`), applying the parent's per-agent overrides
for that agent (`docs/decisions/0008-cross-session-access-intent.md:98-109`;
`src/authority/forwarded-request-server.ts:435-441`). The parent's `allow`
(including a yolo-rewritten allow) auto-approves and its `deny` auto-denies;
only an `ask` reaches the parent's dialog/chain
(`src/authority/forwarded-request-server.ts:443-470`;
`docs/decisions/0005-serving-authorizer-provenance.md:20-31`). So on a forwarded
ask the serving node's mode and policy win; the child's own policy already
decided only whether to ask.

[C30] `deny` survives yolo on the serving path; only `ask` is rewritten
(`docs/decisions/0005-serving-authorizer-provenance.md:49-53`;
`src/policy/permission-manager.ts:316`).

## 4. Invalid and missing config handling

[C31] Global config that fails schema validation contributes an empty scope and
emits issues, but triggers **no** clamp — it is the lowest scope, so nothing
more permissive is inherited when it fails
(`src/config/config-loader.ts:169-186`; `docs/configuration.md:48`).

[C32] Project config that is present but rejected is marked `invalid: true`
(parse error or schema rejection) (`src/config/policy-loader.ts:236-240`).

[C33] Agent and project-agent frontmatter are marked `invalid: true` only when
the file exists but cannot be read or parsed; a file with no frontmatter, or
with malformed `permission` entries, yields an empty/partial scope instead
(`src/config/policy-loader.ts:262-290`; `src/config/config-loader.ts:80-131`).

[C34] A missing agent file is a legitimately empty scope, cached with stamp
`"missing"` (`src/config/policy-loader.ts:262-268`).

[C35] When any non-global scope is `invalid`, the composed ruleset is floored:
every `allow` (including one inherited from a lower scope) is clamped to `ask`,
while `deny` and `ask` are unchanged, and the session reports the fail-closed
scopes (`src/policy/permission-manager.ts:228-241,153-166`;
`docs/configuration.md:43-49`).

[C36] The clamp is deny-preserving and is applied at composition, so
`yoloMode: true` re-permits the floored `ask` back to `allow`
(`docs/configuration.md:49`; `src/policy/permission-manager.ts:316`).

[C37] If a child's own `@gotgenes/pi-permission-system` is not loaded (e.g.
listed in pi-subagents' `excludedExtensionPackages`), the child has no gate, no
tool filtering, no frontmatter resolution, and no ask forwarding; the parent
records `child_node_absent` and warns once per session
(`src/authority/child-node-audit.ts:1-90`;
`docs/subagent-integration.md:79-100`;
`packages/pi-subagents/docs/configuration.md:334-338`).

## 5. Ask forwarding from child to parent

[C38] A forwarded exchange is file-based: the child writes
`<forwardingDir>/sessions/<parentSessionId>/requests/<id>.json` and polls
`…/responses/<id>.json`, where `forwardingDir = <agentDir>/sessions/permission-forwarding`
(`src/authority/approval-escalator.ts:250-330`;
`src/config/extension-paths.ts:45-47`;
`src/authority/permission-forwarding.ts:250-300`).

[C39] The serving (parent) session must have a UI: `ForwardingManager.start`
only polls when `ctx.hasUI`, and serving eligibility is "`hasUI` and nothing
else" — deliberately not "is this a subagent"
(`src/authority/forwarding-manager.ts:43-45,63-72`).

[C40] Liveness has two channels: an in-process `ServingSessionRegistry`
(globalThis) for registry-resolved targets, and a filesystem heartbeat under
`<forwardingDir>/serving/<sessionId>.json` (sessionId, pid, updatedAt) for
out-of-process targets (`src/authority/forwarding-liveness.ts:1-56,165-260`;
`src/authority/serving-registry.ts:1-120`).

[C41] Dispatch by context (`selectAuthorizer`): a node **with UI** relays to a
named parent only when that target is confirmed serving; otherwise it opens its
own local dialog. A node **without UI** that is detected as a subagent builds a
`ParentAuthorizer` (relay). A node with neither UI nor child status gets a
`DenyingAuthorizer` (`src/authority/authorizer.ts:142-211`).

[C42] Headless child with no resolvable target: the tool is blocked as
approval-unavailable with "Could not resolve a parent session to forward this
permission request to"; it is explicitly not reported as a user denial
(`src/authority/approval-escalator.ts:118-127,232-247`).

[C43] Headless child whose target is not draining its inbox: after an ~2 s
grace window (`PERMISSION_FORWARDING_SERVING_GRACE_MS`, 8 poll ticks) it gives
up with "Session '<id>' is not serving forwarded permission requests" and logs
`forwarded_permission.no_serving_session` with channel/state
(`src/authority/approval-escalator.ts:380-410`;
`src/authority/permission-forwarding.ts:11-23`).

[C44] A draining target is waited on for the full `forwardingTimeoutMs`
(default 600000 ms = 10 min), however long the human takes; timeout ends in the
same approval-unavailable denial, not a user denial
(`src/authority/approval-escalator.ts:330-378,412-425`;
`docs/configuration.md:106`).

[C45] A child with its own UI that names a live serving parent relays instead
of prompting locally, and re-decides every turn: once the parent stops serving,
the next activation selects the local dialog again
(`docs/subagent-integration.md:64-78`; `src/authority/authorizer.ts:142-172`).

[C46] On a forwarded approval the human chooses a scope: "this subagent only"
(least privilege, default) records the grant on the requesting child, while
"the whole session" records it on the serving parent so all its subagents
resolve it (`docs/subagent-integration.md:139-142`;
`src/authority/forwarded-request-server.ts:329-356`).

## 6. Where it prompts, and friction evidence

[C47] The local prompt is an inline TUI dialog owned by `LocalUserAuthorizer`,
constructed with `ctx.ui`, the session dialog queue, and
`requestPermissionDecision`; it also emits a `permissions:ui_prompt` broadcast
and can emit terminal notifications (`src/authority/authorizer.ts:151-173`;
`src/authority/local-user-authorizer.ts`;
`docs/configuration.md:104-110`).

[C48] Friction theme — **prompt fatigue / ask-by-default volume.** Issue #501
("configurable bash trust profile / workflow mode to escape prompt fatigue")
reports "72 `permission_request.waiting` prompts, 71 approved, 0 denied, 1
pending" in 45 minutes and says the user "reflexively approved without reading
each one — at which point the gate is pure friction with zero security value"
(`gh api repos/gotgenes/pi-packages/issues/501`, open, 2026-06-27). It asks for
an allow-by-default trust profile instead of enumerating benign commands.

[C49] Friction theme — **false positives from path heuristics.** Issue #859
reports git revision ranges like `cc83d7b48..origin/master` classified as
external path candidates, so read-only `git log` raises `external_directory`
asks on every run (`gh api …/issues/859`, open, 2026-09-26). Issue #800 reports
`cat ~/.cargo/bin/x`, `ls /dev`, `find /etc` all prompting, and asks for a
read-only bash exemption from the `external_directory` gate
(`gh api …/issues/800`, closed, 2026-08-22).

[C50] Friction theme — **read-only tools vetoed by the write surface.** Issue
#952: an extension/MCP tool cannot declare its direction, so a read-only tool
consults the bare `external_directory` family and the write-side catch-all
vetoes a read grant; the reporter counted 9 `waiting` prompts over a 17,972-entry
log (`gh api …/issues/952`, open, 2026-09-19).

[C51] Friction theme — **double prompting.** Issue #915: two gates that both
resolve to `ask` on one call each raise their own prompt, "so one invocation can
cost the operator two decisions — and a subagent two forwarding round-trips"
(`gh api …/issues/915`, open, 2026-09-11).

[C52] Friction theme — **forwarding stalls and misleading denials.** Issue #719
reports a subagent's first `bash({command:"pwd"})` got no parent dialog, hung
exactly 10 minutes, then received "User denied bash command 'pwd'" though no one
denied it (`gh api …/issues/719`, closed, 2026-08-12; fixed by the liveness
work in §5). Issue #398 reports a repeating "Permission Required (Subagent)"
prompt loop with overlapping children that only killing `pi` resolved
(`gh api …/issues/398`, closed, 2026-06-13). Issue #710 reports forwarded
prompts rendering unbounded raw tool input and pushing the transcript out of
view (`gh api …/issues/710`, closed, 2026-08-10).

[C53] Friction theme — **third-party subagent forwarding broke**, driving the
env-var grandfathered list: #44 and #22 document that the major pi-subagent
extensions set none of the then-recognized vars, so `ask` in their children
silently denied (`gh api …/issues/44`, `…/issues/22`).

[C54] Friction theme — **dialogs interfere with input.** Issue #927: the
hardcoded `y/s/b/n/r` hotkeys are unusable under an IME (Chinese/Japanese/Korean
composition), which "caused a real accidental rejection of a tool call"
(`gh api …/issues/927`, closed, 2026-09-16). Issue #488 reports the permission
prompt stealing focus while typing (`gh api …/issues/488`, closed, 2026-06-26).
Issue #931 asks for an auto-reject-on-timeout so an away user gets an
actionable notification instead of a pending request
(`gh api …/issues/931`, open, 2026-09-16).

[C55] Friction theme — **permission persistence is missing.** Issue #691 asks
to persist approved rules at project or global scope
(`gh api …/issues/691`, open, 2026-08-01), and #799 (open) is the unresolved
ADR on policy channels, including a write-back `config.local.json`.

[C56] Friction theme — **the restrictive default is acknowledged, not a bug.**
The package's own quickstart ships `"*": "ask"` plus an allow-list, which #501
describes as "the right default for first-time users … but for daily-driver
workflows on a trusted machine, the current config forces every user to either
(a) enumerate every benign command they use, or (b) rubber-stamp prompts"
(`gh api …/issues/501`; `README.md:33-49`).

## Unknowns

[U1] Whether a forged `--append-system-prompt` tag in a nested `pi` process can
practically loosen the nested node's policy is reasoned from the code
([C21]–[C24]) but is **not covered by a test or doc** in the repo, and the
nested process is still subject to the outer `bash` gate that permits launching
`pi`. `unknown`.

[U2] Whether the agent-name path traversal in [C19] is exploitable or
intentional: no sanitization exists at the `join`, and no test asserts the
behaviour either way. `unknown`.

[U3] Whether pi-subagents passes any mode/trust signal to a child beyond the
system prompt and the lifecycle events: searched `packages/pi-subagents/src` for
`yolo`, `permission`, `trust` and found no propagation; a child's project trust
is whatever its own `ctx.isProjectTrusted()` returns. Not verified against the
Pi SDK child-session construction beyond `create-subagent-session.ts`. `unknown`.

[U4] The exact merge of *runtime* config between an in-process child and its
parent when the child has a different cwd is not documented; the code shows each
node reading its own files ([C27]) but there is no test asserting a differing
mode across a worktree child. `unknown`.

[U5] The number of `permission_request.waiting` prompts and approval ratios is
from the reporter's log in #501, not independently reproduced. `unknown`
beyond that issue.

[U6] The archived standalone repos may contain behaviour not present in the
monorepo; the monorepo at `3eb40be` is treated as authoritative here. `unknown`.

## Claim / unknown counts

- Cited claims: 56 (`C1`–`C56`).
- Unknowns: 6 (`U1`–`U6`).
