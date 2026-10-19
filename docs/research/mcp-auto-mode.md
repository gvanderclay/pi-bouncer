# How peer agents treat MCP tool calls in auto mode

Checked 2026-05 (docs fetched live as `.md` pages; see dates in "Versions").

## Question

In coding agents with an "auto" permission mode, are MCP calls (a) sent to the same classifier as shell commands, auto-approved, or always prompted, and (b) what happens to an MCP call needing approval with no interactive UI?

## Short answer

Three of four peers send MCP calls to the same classifier/reviewer as shell (Claude Code, Codex, Cursor). Gemini CLI has no classifier; its "auto" is a policy engine where YOLO allows everything and otherwise MCP asks the user. In all four, headless ask = deny/cancel, never silent allow. In Claude Code and Codex the carve-out is for tools that the server itself flags as needing a human (`requiresUserInteraction`, destructive annotations); those are not judged, they prompt. Allow lists run before the classifier everywhere. So pi-bouncer sending non-allow-listed MCP calls to the judge matches Claude Code, Codex and Cursor; its current "dialog, or block with no UI" matches Gemini and is stricter than the other three.

## Per tool

### Claude Code (docs fetched from code.claude.com, version-less docs; mentions v2.1.236, v2.1.286)

- Auto mode decision order, "first matching step wins" (https://code.claude.com/docs/en/permission-modes.md, "How the classifier evaluates actions", lines ~494-508):
  1. Allow/ask/deny rules resolve immediately (MCP rules are `mcp__server`, `mcp__server__*`, `mcp__server__tool`; https://code.claude.com/docs/en/permissions.md line ~546-552). Exception: MCP tools marked `_meta["anthropic/requiresUserInteraction"]: true` prompt the user even if an allow rule matches (permission-modes.md line 498; mcp.md line 1372).
  2. Read-only actions and in-workspace edits auto-approve (this describes built-ins; the doc does not say MCP tools qualify, `unknown`).
  3. "Everything else goes to the classifier." So an MCP tool with no rule goes to the classifier, same as Bash. Flagged `requiresUserInteraction` tools and org-`ask` connector tools "never reach the classifier either" (line 508).
- Annotations: `readOnlyHint`/`destructiveHint` are not mentioned anywhere in the permission docs (`rg readOnlyHint` over permissions.md, permission-modes.md, headless.md: no hit). Only the Anthropic-specific `_meta` key `requiresUserInteraction` (and a result-size `_meta`) is documented. The classifier sees tool calls, user messages, CLAUDE.md; tool results are stripped (line ~520).
- Headless `-p`:
  - Auto mode: the classifier still runs; repeated blocks (3 in a row / 20 total) with no `--permission-prompt-tool` "the action doesn't run and Claude keeps working" (permission-modes.md line 481). Where no terminal prompt is possible, auto mode denies the dangerous-removal prompt immediately (line 761).
  - `requiresUserInteraction` MCP tools: denied in `dontAsk`; a `--permission-prompt-tool` allow is converted to deny (mcp.md line 1376). Agent SDK `canUseTool` can approve them.
  - `dontAsk` mode auto-denies anything that would prompt (permission-modes.md "Allow only pre-approved tools", line ~550).
  - `--permission-prompts none` denies prompts instead of waiting for a host (cli-reference.md line 115).

### OpenAI Codex CLI (docs at developers.openai.com/codex and learn.chatgpt.com; source openai/codex `main` at 89461ea6833832b0551ce24ee32205824d5c108d)

- "Auto" here is `approvals_reviewer = "auto_review"` with `approval_policy = "on-request"` (https://developers.openai.com/codex/agent-approvals-security.md, "Automatic approval reviews", lines ~316-335). The reviewer "evaluates only actions that already need approval, such as sandbox escalations, blocked network requests, `request_permissions` prompts, or side-effecting app and MCP tool calls." So MCP calls that need approval go to the same reviewer as shell escalations. Auto-review page (https://learn.chatgpt.com/docs/sandboxing/auto-review.md line 65): "MCP or app tool calls that require approval based on their tool annotations or configured approval mode."
- Annotations DO matter: "Destructive app/MCP tool calls always require approval when the tool advertises a destructive annotation (unless the tool advertises a read annotation, which takes priority)" (agent-approvals-security.md line 74). Per-server `default_tools_approval_mode` = `auto | prompt | writes | approve`; `writes` "prompts for tools that aren't marked read-only"; per-tool `tools.<tool>.approval_mode` override (https://developers.openai.com/codex/mcp.md lines ~321-324). Which exact annotation keys (`readOnlyHint`, `destructiveHint`) map to those: `unknown` from docs (not verified in source).
- `approval_policy = { granular = {...} }` has an MCP-prompt category (`mcp_elicitations`) that can be auto-rejected (agent-approvals-security.md lines 308, 389).
- Headless `codex exec`: runs read-only sandbox by default; `--approve-for-me` routes approvals through auto review (noninteractive.md line 61, "Permissions and safety"). Without a reviewer, source shows exec "auto-cancels" MCP elicitation, including tool-approval ones, with cancellation reason `NonInteractive` (https://raw.githubusercontent.com/openai/codex/main/codex-rs/exec/src/lib.rs lines 2010-2024 and 2093-2097, commit 89461ea). `-a never` means no prompts (agent-approvals-security.md line 302); how never interacts with a tool that requires approval is `unknown`.

### Gemini CLI (docs on `main` of google-gemini/gemini-cli: docs/reference/policy-engine.md, docs/tools/mcp-server.md, packages/core/src/policy/policies/*.toml)

- No classifier. Approval modes are `default`, `autoEdit`, `plan`, `yolo`; YOLO is "all tools are auto-approved" (policy-engine.md line 182), implemented as an allow-all rule (yolo.toml priority 998/999). `autoEdit` auto-approves only edit tools; I found no rule making MCP tools auto-approve there (`unknown` in the strict sense).
- MCP server `trust: true` "bypasses all tool call confirmations" for that server (mcp-server.md lines 173, 739-749); tool/server allow lists exist (`serverName`, `serverName.toolName`; `mcp_server_*` wildcards in policy rules). Otherwise MCP calls ask the user (default write-tool behaviour, `ask_user`).
- Annotations: policy rules can match `toolAnnotations = { readOnlyHint = true }` (policy-engine.md lines 306-307), so a user can write a rule allowing read-only MCP tools. No built-in default that auto-allows by annotation was found (`unknown`).
- Headless: "`ask_user`... In non-interactive mode, this is treated as `deny`" (policy-engine.md lines 116-117). Rules can be scoped with `interactive = false/true` (lines 102-104).

### Cursor (agent + CLI docs at cursor.com/docs)

- Run Modes: Auto-review, Allowlist, Run Everything (https://cursor.com/docs/agent/security/run-modes.md). "Auto-review applies to shell, MCP, and Fetch tool calls." Allowlisted calls run immediately; others go to an LLM classifier on Cursor's backend (currently Gemini 3.5 Flash Lite, Haiku fallback). If it blocks, the agent tries another approach or "Cursor will show you an approval prompt." https://cursor.com/docs/mcp.md line ~294: "in Auto-review mode, allowlisted MCP tools run immediately and everything else is routed through the classifier." Default (no run mode) is a prompt for every MCP tool call (https://cursor.com/docs/agent/security.md line 21; mcp.md line 288).
- Annotations: not mentioned in the fetched pages (`unknown`).
- CLI/headless: `-p/--print`; `--force`/`--yolo` "Force allow commands unless explicitly denied"; `--approve-mcps` approves MCP servers (https://cursor.com/docs/cli/reference/parameters.md; https://cursor.com/docs/cli/headless.md). CLI permission rule `Mcp(server:tool)` in allow/deny (https://cursor.com/docs/cli/reference/permissions.md line ~65). What print mode does with an unallowed MCP call and no `--force`: `unknown` (docs only say without `--force` file changes are "only proposed").

### Others

Cline, Goose, Copilot CLI, Aider: not researched; no primary-source fetching done. `unknown`.

## Pattern

1. Explicit allow/deny lists win and run before any judge.
2. Classifier-based auto modes (Claude Code, Codex, Cursor) judge MCP tools alongside shell; none treats MCP as always-prompt or always-allow.
3. The only carve-out from judging is a server-declared "needs a human" flag (Claude `requiresUserInteraction`; Codex destructive annotation unless read annotation), and a user-set per-server mode (Codex `prompt`, org `ask` in Claude).
4. Standard MCP annotations (`readOnlyHint`) feed decisions only in Codex (documented) and in Gemini via user-written rules; Claude and Cursor docs do not mention them.
5. Headless: a needed approval becomes deny/cancel; never auto-allow. Claude keeps running after denial; Codex exec cancels the elicitation; Gemini treats ask as deny.

## Versions / limits

Docs fetched live on the date of this note; Claude Code docs mention v2.1.236+ and v2.1.286; Codex source at openai/codex@89461ea; Gemini and Cursor docs unversioned. Web search was unavailable, so everything came from direct fetches of first-party pages. Codex docs are partly hosted on learn.chatgpt.com (OpenAI-owned).
