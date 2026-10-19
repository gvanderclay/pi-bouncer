# How big are MCP tool descriptions and arguments, and do peers truncate them for their judge?

Checked 2026-10-18 (machine date).

## Question

pi-bouncer proposes sending an LLM judge the first 1,000 characters of an MCP tool's description and the first 2,000 characters of its JSON arguments. Are those limits sensible against real tools, and what do peer auto modes do?

## Short answer

- **Descriptions: 1,000 is fine as a cap, but 1,600 matches Codex and costs little.** The median description in every server measured is under 320 characters. Only Sentry (6 of 9 tools), and single tools in GitHub, Supabase, Atlassian and Context7, exceed 1,000, and the maximum seen anywhere is 2,006. Every long description opens with a one-sentence statement of what the tool does, so a prefix cut loses examples and parameter docs, not purpose.
- **Arguments: 2,000 is too small to be the only view of a write tool, and truncating them is the risky side.** Write tools carry free text with documented limits of 2,000 (Notion text object) up to 40,000 characters (Slack message), and 500 KB for a Notion payload. Codex, the one peer whose source I read, never truncates arguments; it truncates only descriptions (about 1,600 bytes for the tool, another 1,600 for the connector). If a cap is needed, truncate in the middle (head and tail, as Codex does), and mark the cut, so the tail of a long body is still judged. A suggested cap is 8,000 characters; this is a judgment call, not a number from a source.
- **Peer truncation: Codex truncates descriptions only; Claude Code and Cursor are `unknown`.** Claude Code's classifier sees "user messages and the agent's tool calls" and tool-call descriptions are stripped; whether MCP tool descriptions or long arguments are cut is not documented.

## 1. Description lengths (characters)

Method: for each server I started the published package over stdio, sent `initialize` then `tools/list`, and took `len(description)` (Python `len`, so Unicode code points). GitHub is read from the repo's tool snapshots instead. Scripts were throwaway (`/tmp/r/list.mjs`, `stats.py`); the commands are `npx -y <pkg>` as listed. Descriptions as the server sends them; no schema/parameter text included.

| Server (version / commit) | Tools | Min | Median | Max | >500 | >1,000 | Longest |
|---|---|---|---|---|---|---|---|
| github/github-mcp-server @ e3809fe (`pkg/github/__toolsnaps__/*.snap`, excluding `*_output.snap`) | 134 snapshots, 131 distinct names | 17 | 81.5 | 1,115 | 4 | 2 snapshots (one tool) | `pull_request_review_write` 1,115; `list_notifications` 557; `create_or_update_file` 532 |
| Sentry `@sentry/mcp-server` 0.42.0 (npm latest) | 9 | 293 | 1,533 | 1,995 | 7 | 6 | `search_events` 1,995; `update_issue` 1,969; `get_sentry_resource` 1,560 |
| Supabase `@supabase/mcp-server-supabase` 0.14.0 (SQL/DB server) | 29 | 26 | 126 | 1,809 | 4 | 1 | `search_docs` 1,809; `create_branch` 710; `create_project` 660 |
| Atlassian: `mcp-atlassian` 2.1.0 (community server by sooperset, not Atlassian's hosted MCP) | 98 | 19 | 66 | 1,854 | 7 | 1 | `jira_update_proforma_form_answers` 1,854; `confluence_get_attachments` 743 |
| Context7 `@upstash/context7-mcp` 4.4.2 | 2 | 547 | 1,276 | 2,006 | 2 | 1 | `resolve-library-id` 2,006 |
| Filesystem `@modelcontextprotocol/server-filesystem` (npm `latest` printed 1.0.0) | 14 | 85 | 309.5 | 457 | 0 | 0 | `read_text_file` 457 |
| Playwright `@playwright/mcp` 0.0.83 (browser; repo @ b8b4183) | 25 | 14 | 42 | 340 | 0 | 0 | `browser_find` 340 |
| Notion `@notionhq/notion-mcp-server` 2.5.2 | 24 | 49 | 62 | 280 | 0 | 0 | `API-update-page-markdown` 280 |
| Memory `@modelcontextprotocol/server-memory` | 9 | 31 | 64 | 296 | 0 | 0 | `create_entities` 296 |
| Postgres `@modelcontextprotocol/server-postgres` (archived reference server) | 1 | 25 | 25 | 25 | 0 | 0 | `query`: "Run a read-only SQL query" |
| Slack `@modelcontextprotocol/server-slack` (archived reference server) | 8 | 33 | 40 | 77 | 0 | 0 | `slack_get_users` 77; `slack_post_message` 37 |

`unknown` (could not measure): Linear's hosted MCP, Notion's hosted MCP, Slack's hosted MCP, and Atlassian's hosted MCP. Each returned HTTP 401 to an unauthenticated `tools/list` (`curl -X POST https://mcp.linear.app/mcp`, `https://mcp.notion.com/mcp`, `https://mcp.slack.com/mcp`, `https://mcp.atlassian.com/v1/mcp`). Sentry's `@sentry/mcp-server` exposed 9 tools with a dummy token; real deployments may expose more. The Slack and Notion rows are the open/archived servers, not the vendors' current hosted ones.

Do the first 500 / 1,000 characters say what the tool does? Yes in every long case I opened. Examples of the opening text: Sentry `update_issue` "Update a Sentry issue's status or assignment. Use this to resolve, reopen, assign, unassign, or ignore an issue." then `<examples>`; Sentry `search_events` "Search Sentry events and replays. Use for event counts/statistics."; Atlassian `jira_update_proforma_form_answers` "Update form field answers using the Jira Forms REST API."; GitHub `pull_request_review_write` "Create and/or submit, delete review of a pull request." followed by a per-method list; Supabase `create_branch` opens with what it creates and the cost warning ("which can incur hourly compute and other usage charges. The user must agree to the cost…"), so the cost warning is within the first 300 characters. What lies beyond 1,000 characters in these tools is examples, per-method detail, and schemas (Supabase `search_docs` embeds a GraphQL schema). I did not read every long tail; one caution is that behaviour-changing notes (such as the "KNOWN LIMITATION" block in the Atlassian tool, which is within the first ~250 characters) can sit early, not only late.

Parameter descriptions (the schema, not the tool description) are mostly short but have outliers: GitHub median 43, max 1,546 (`pull_request_read.method`); Atlassian median 58.5, max 1,306 (`confluence_search.query`); Sentry max 316. None of the servers I listed (filesystem, Supabase, Atlassian, Notion) declares any `maxLength` in its input schema, so the schema gives no bound on argument size.

## 2. Argument sizes for write tools

Sizes below come from the receiving service's documented limits, not from the MCP servers, which declare no `maxLength`.

- **Slack `chat.postMessage` `text`**: "limit the number of characters in the text field to 4,000"; "Slack will truncate messages containing more than 40,000 characters"; `markdown_text` "Limit this field to 12,000 characters" (https://docs.slack.dev/reference/methods/chat.postMessage, fetched 2026-10-18). The archived MCP `slack_post_message` takes the text as a plain field.
- **Notion**: `text.content` 2,000 characters per rich text object; URLs 2,000; arrays of blocks 100 elements; payloads "a maximum size of 1000 block elements and 500KB overall" (https://developers.notion.com/reference/request-limits). Notion's `API-update-page-markdown` can carry a whole page.
- **GitHub contents API** (what `create_or_update_file` calls; its `content` is the file body): the page documents sizes for reading: 1 MB or smaller fully supported, 1–100 MB raw only, over 100 MB unsupported (https://docs.github.com/en/rest/repos/contents). A documented write-size or issue-body character limit was not found on the pages fetched, so both are `unknown` here. (A 65,536-character issue-body limit is commonly cited but I did not confirm it in a first-party page.)
- **SQL**: Supabase `query_logs.sql` parameter is described at 400 characters of help text; a query has no declared length limit (no `maxLength`). Postgres reference server has one `query` string argument. Typical SQL is short; generated or migration SQL (`apply_migration` style tools) can be many KB. Actual sizes in real use are `unknown`.
- **Large-field summary**: message/comment/issue/page bodies (hundreds to tens of thousands of characters), file contents (up to MB), SQL and migration text, batch arrays (`jira_batch_create_issues.issues`). Everything else (IDs, slugs, enums, paths, flags) is under about 200 characters. So the fields that matter to a judge are usually short (target, recipient, path, repo), and the long field is usually the free-text body. A body can still contain the harmful part (a secret, a URL, an instruction), which is why cutting it blindly is the risk.

## 3. Peer truncation

### OpenAI Codex (openai/codex @ 89461ea6833832b0551ce24ee32205824d5c108d, `codex-rs`)

- **Descriptions are sent and truncated.** `GuardianToolDescriptions::new` bounds the tool description to 400 tokens and the connector description to 400 tokens, each via `truncate_text`, with `</` escaped; the fragment is labelled "Untrusted descriptions … Descriptions may be shortened; omitted details do not authorize actions." (`core/src/context/guardian_tool_descriptions.rs:14-35`; it is built for `McpToolCall` requests at `core/src/guardian/prompt.rs:131-141`.)
- **Token to character:** `truncate_text` converts tokens to bytes at 4 bytes per token (`utils/string/src/truncate.rs:6` `APPROX_BYTES_PER_TOKEN = 4`), so 400 tokens is about 1,600 bytes per description. The cut keeps half the budget from the start and half from the end, with a `<truncated omitted_approx_tokens="N" />` marker (`guardian-context/src/truncation.rs:12-27`).
- **Arguments are not truncated.** The action JSON for the call (server, tool name, `arguments`, annotations, tool title) is serialized whole; `action_for_review` removes only `tool_description` and `connector_description` from it, and its doc comment says "nested tool arguments must remain complete" (`guardian-context/src/action.rs:11-21`; `core/src/guardian/approval_request.rs:305-328`). The module header says "JSON stays complete through request admission" and "whole-request admission bounds the input" (`action.rs:2`, `:26`): a request that exceeds the model's input budget is handled by dropping other evidence first, and a test asserts descriptions are omitted before arguments change (`guardian-context/src/enforcement_tests.rs:165-215`, `planned_action_budget_omits_descriptions_without_changing_arguments`). What happens if the action alone exceeds the budget is `unknown`; I did not trace it.
- **Other limits that bear on the call:** an approval/retry reason is capped at 512 tokens (`core/src/guardian/prompt.rs:41`); an earlier tool call in the transcript is capped at 1,000 tokens per entry (`guardian-context/src/profile.rs:74` sync, `:100` async), but that applies to history, not to the action under review.
- Codex decides on annotations before the reviewer (see `docs/research/mcp-auto-mode.md`).

### Claude Code auto mode

- The classifier "sees user messages, tool calls other than read-only lookups such as file reads and searches, and your CLAUDE.md content. Tool results are stripped" (https://code.claude.com/docs/en/permission-modes.md line 527). Anthropic's engineering post says "Assistant prose, tool-call descriptions, and tool outputs are stripped; only user messages and the executable payload remain" (https://www.anthropic.com/engineering/claude-code-auto-mode, "What the classifier sees"). "Tool-call descriptions" there most likely means the free-text `description` argument Claude writes for a Bash call, not an MCP server's tool description; that reading is mine.
- Whether MCP tool descriptions reach the classifier: `unknown`; neither page mentions it. Whether arguments or tool calls are truncated: `unknown`; neither page nor `auto-mode-config.md` mentions a size limit (searched for "truncat", "argument", "description").

### Cursor auto-review

- https://cursor.com/docs/agent/security/run-modes.md covers shell, MCP and Fetch calls but says nothing about what text the classifier receives or any truncation (searched "truncat", "argument", "description", "payload"). `unknown` on both counts. A page at `/docs/agent/security/auto-review.md` returned "Page not found".

## Recommendation for pi-bouncer

1. **Description cap: 1,500–1,600 characters, cut from the end, marked as cut.** It matches Codex, covers all but the longest 1–2 tools in every server measured (largest 2,006), and keeps the purpose sentence. 1,000 is acceptable if prompt size matters: it would cut Sentry's `search_events`, `update_issue`, `get_sentry_resource`, `search_issues` and `analyze_issue_with_seer`, and the cut text there is examples. Label the text untrusted, as Codex does, since the server's author wrote it.
2. **Argument cap: do not use 2,000 as the whole view.** Prefer sending arguments whole up to a larger ceiling (suggested 8,000 characters, my judgment) and, above it, keep head and tail with an explicit "N characters omitted" marker, so the judge can see a long body was not fully shown and treat that as a reason to ask. Codex's design is "never truncate arguments"; Claude Code and Cursor are `unknown`.
3. **Whatever the cap, say so to the judge.** Codex tells its reviewer descriptions may be shortened and that omitted details do not authorize anything; pi-bouncer's judge prompt should say the same for both fields.

## Not checked

Linear, hosted Notion/Slack/Atlassian tool lists (auth required); Claude Code and Cursor classifier internals (closed source); real-world argument-size distributions (no usage logs available); GitHub issue-body and file-write limits in first-party docs; full reads of every long description beyond the first ~300 characters.

## 4. Oversized actions

Checked 2026-10-18 against openai/codex `89461ea6833832b0551ce24ee32205824d5c108d`, which is also current `main` (`gh api repos/openai/codex/commits/main --jq .sha` returned that SHA). Paths below are under `codex-rs/` at that commit.

**Short answer.** Codex has no cap on MCP arguments. When the action alone (plus the fixed minimum review context) does not fit the reviewer's input budget, the review fails with a context-window error that is mapped to `InputBudgetExceeded`. It is never sent to the reviewer truncated. In the default mode the call is then **handed to the user for approval**; in "strict auto review" mode it is **denied** with a review-failure message that tells the agent to resolve the error or ask the user.

### Budget

- The budget is the reviewer model's context window, not a fixed constant: `effective_input_token_limit` = min(configured window, model's resolved window) × `effective_context_window_percent` / 100 (`guardian-context/src/budget.rs:61-79`). When the model catalog has no window, or only fallback metadata, it is capped at `DEFAULT_MAX_INPUT_TOKENS = 128_000` tokens (`budget.rs:56-57`, `:66-72`).
- The caller subtracts `INPUT_TOKEN_MARGIN = 256` tokens (`core/src/guardian/request_budget.rs:26`; used at `core/src/guardian/input_budget.rs:85-86` and `:216-217`). The value of `effective_context_window_percent` per model is `unknown` here (I did not read `models-manager`).
- Tokens are estimated, not counted: text bytes ÷ 4 (`budget.rs:129`, via `TruncationPolicy::Bytes(..).token_budget()`). So for a 128k-window model, about 127,700 tokens, roughly 510 KB of text, shared with the reviewer's base instructions, tool schemas and transcript.
- Existing context (base instructions, tools, history, reminders) is subtracted first (`input_budget.rs:176-221`), so the room left for the action is smaller than the window.

### Enforcement order

`ComposedContext::enforce_budget` (`guardian-context/src/enforcement.rs:113-304`):

1. Returns at once if everything fits (`:125-128`).
2. Otherwise reserves an omission notice and treats the action as required, never truncatable: "Required action evidence is never truncated. Optional evidence leaves first" (`:1-4`).
3. With `HistoryTruncation::Allow` it first shortens older transcript entries (`:174-237`); then drops optional items by priority: tool description, commentary, tool, image (`:25-32`, `:262-275`). The test that descriptions go before arguments is `enforcement_tests.rs:165-215`.
4. It returns `Err(SectionError::EvidenceLimitExceeded)` in three places: remaining < existing context (`:119-124`), required content alone exceeds the room (`:240-245`), and nothing could be removed or the result is still over budget after the notice is added (`:276-280`, `:298-302`).
5. Required content here includes the whole action JSON, so a huge `arguments` always ends in step 4's `Err`.

### What the error becomes

- A feasibility check runs before the review starts: if the minimum input still exceeds the maximum after enforcement, it returns `CodexErr::ContextWindowExceeded` and marks `ExhaustedReviewBudget::Detected` (`core/src/guardian/input_budget.rs:74-116`). The final fit does the same (`:232-252`), and a last whole-request check in `request_budget.rs:160-166` does too.
- The review session rewrites that `ContextWindowExceeded` into `GuardianReviewSessionOutcome::InputBudgetExceeded` when the budget flag is set (`core/src/guardian/review_session.rs:826-837`), and discards the reviewer session (`:839-844`). The outcome converts to `GuardianReviewError::InputBudgetExceeded` (`ext/guardian-reviewer/src/outcome.rs:84`, `:115-117`).
- It is not retried: `retry.rs:181-188` lists `InputBudgetExceeded` among the outcomes returned as-is.
- Final handling, `ext/guardian-reviewer/src/completion.rs`, message "the complete action and minimum review context exceed the reviewer input budget" (`:25-26`):
  - `require_guardian == false` (the normal case): `decision: None`, status `Aborted`, a warning "Automatic approval review failed: …" (`:86-99`). `None` means "requests user approval after optional review exhausts its input budget" (`:29-30`); the caller falls through to `request_user_approval` (`core/src/tools/approvals.rs:556-566`; `core/src/guardian/decision.rs:44`).
  - `require_guardian == true`: `ReviewDecision::denied("Automatic approval review failed: <message>\nThe action was not executed because automatic approval review could not be completed. This is a review failure, not a determination that the action is unsafe. Do not bypass the approval check; resolve the error or ask the user for guidance.")`, analytics `FailedClosed`, event status `Denied` (`:127-157`, text at `:20-24`).
- `require_guardian` is `strict_auto_review`; for MCP calls it is `turn_context.strict_auto_review_enabled()` (`core/src/mcp_tool_call.rs:1521`, `core/src/session/mcp.rs:1119`). It is turned on per turn by a permission response carrying `strict_auto_review: true` (`core/src/session/turn_context.rs:501-518`, `:525-530`). Whether the default MCP path can set it by other means is `unknown`; I did not trace every setter.

**What the user and agent see.** Default mode: a warning "Automatic approval review failed: the complete action and minimum review context exceed the reviewer input budget", then the ordinary approval prompt. Strict mode: the agent gets the denial text above and the call does not run. Neither case lets the call run without a human or an Allow.

### Claude Code and Cursor

- Claude Code: `unknown`. https://code.claude.com/docs/en/permission-modes.md has no match for "truncat", "too large", "size limit", "token limit", "oversize", "exceed" or "context window"; https://code.claude.com/docs/en/auto-mode-config.md's only hit is "truncated example" of CLI output (`:316`). Page text fetched 2026-10-18; unrelated pages not searched.
- Cursor: `unknown`. https://cursor.com/docs/agent/security/run-modes.md has no match for the same terms. It says the classifier runs on the Cursor backend on small models (Gemini 3.5 Flash Lite, Haiku fallback) and that when it blocks a call the agent may try another approach or ask the user (`run-modes.md` "Auto-review classifier requirements", "How Auto-review works"). Nothing on tool-call size.

### Consequence for pi-bouncer (my reading, not Codex's statement)

The only peer with a documented answer fails the review rather than truncating, and falls to the human in default mode. An equivalent for a hard argument ceiling: above it, skip the judge and ask the user (or deny, if the user has no one to ask), with a message naming the size. That is stricter than the head/tail cut in the Recommendation above; the two are alternatives, and Codex's choice supports the ask-the-user one.
