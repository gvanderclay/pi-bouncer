# How do Pi auto-mode peers judge MCP / non-bash tool calls, and how much of the arguments do they send?

## Question

For five Pi extensions with an LLM-judged "auto mode": which tool calls reach the judge, what the judge receives (name, description, arguments, any cap), what happens when a call is too big, and what happens headless. This feeds the size limit on MCP arguments in pi-bouncer's auto-mode judge. Claude Code, Codex and Cursor are in `mcp-auto-mode.md` and `mcp-judge-limits.md` and not repeated.

## Short answer

- **No peer sends the MCP tool description to the judge.** Every one sends tool name + arguments only.
- **Three different policies for arguments:**
  - pi-automode sends the full argument JSON, never truncated, and **blocks** when it does not fit the judge model's `contextWindow`.
  - pi-verdict caps the action line at 1000 chars (60% head + 40% tail, marker `…[truncated]…`) and judges the cut text; it never checks `contextWindow`.
  - ohmyjev cuts to the first 4000 chars (head only, `…`) and judges it (it asks a hosted "Jev" service, not a Pi model).
- **mzwing's pi-permission-auto-review** sends the full argument JSON and, when the prompt plus a 16 384-token reserve exceeds `model.contextWindow`, **defers to the human prompt** (`input-budget-exceeded`). It is the only peer that checks `contextWindow` and then asks the user.
- **erichll's pi-auto-review** uses a fixed 8 192-token default budget (2 048..32 768), sheds optional evidence first, and **fails closed** (deny, or defer if `failureMode: "defer"`) when mandatory evidence does not fit. It does not read `contextWindow`.
- Headless behaviour is mostly delegated or unknown; see section 4.

## Versions checked (read 2026-10-18, default-branch HEAD of a shallow clone)

| Package | Version | Commit |
|---|---|---|
| @czottmann/pi-automode | 1.17.0 | `e69c02036b56ca9c6a42035623bab7d4ddf73ca5` |
| pi-verdict | 0.15.0 | `3744feb2a4e1a0d785d3ca2dccb1f20758854815` |
| @erichll/pi-auto-review (`packages/pi-auto-review`) | 0.27.0 | `67955cc2cdac57ec850ed67c9d5c9ed0fb67c30e` |
| @mzwing/pi-permission-auto-review (`packages/pi-permission-auto-review`) | 0.9.2 | `23cb9098b373f18296e16c752a3d6fda6d0fbc08` |
| ohmyjev | 0.12.0 | `78bb82cea03c0fb06fbf8892dc6d1840a7f02c11` |

Sources are the cloned GitHub repos at those commits (`git clone --depth 1`). Paths below are relative to each package root.

## 1. Which tool calls go to the judge

- **pi-automode: all tools** that are not decided earlier. The `tool_call` hook (`extensions/auto-mode/extension.ts:439`) lists the order: permission rules, hard denies, own inspection tool, path denials, allow tiers, then "classifier for every remaining action" (`:440-447`). Built-in `read grep find ls` skip the judge by default (`constants.ts:191`, `DEFAULT_CLASSIFY_READ_ONLY_TOOLS = false` at `:209`). MCP tools have no special path: they reach `classify(... serializeClassifierAction(event.toolName, input) ...)` at `extension.ts:750-754`.
- **pi-verdict: all tools**, with MCP/custom tools always going to the model. `pi-verdict.ts:200` ("其余工具(MCP/自定义)不参与用户规则,恒走分类器": other tools take no user rules and always go to the classifier). A configurable `ignoreTools` list (`:259`, defaults at `:352`) skips families such as todo and web_search. Rule layer returns "no rule" for MCP at `:1069`.
- **erichll pi-auto-review: only what @gotgenes/pi-permission-system escalates as an "ask".** The reviewer is a broker on the ask path (`src/index.ts:310-365`), and requests carry `surface` including `"mcp"` (`src/broker/types.ts:6`). Which MCP calls ask is decided by the user's permission-system rules (`README.md:183-195`). unknown: the exact default for unmatched MCP calls (set in permission-system, not read).
- **mzwing pi-permission-auto-review: same model**: "Each ask is judged by ... `codex-auto-review`" (`README.md:5`); the reviewer is an `Authorizer` plugged into permission-system (`src/reviewer.ts:215`). MCP calls are reviewed only if permission-system asks.
- **ohmyjev: bash/powershell, write/edit, and `mcp__*` tools** (`adapters/pi.ts:495-529`; MCP at `:532`, gated by `exfilGate`, default on, `README.md:283`). Read-only bash (`plainRead`) skips the call (`:501`). It also screens `mcp__*` **results** for injection (`:567`).

## 2. What the judge receives, and caps

Neither tool descriptions nor schemas appear anywhere in the judge input of any peer (searched each package for `description` in the judge-prompt code; `unknown` only for permission-system's own ask payload, which was not read).

| Package | Tool name | Arguments | Cap and cut |
|---|---|---|---|
| pi-automode | yes | **full** `JSON.stringify({toolName, input})` | None: "Serialize the complete current tool input without truncation" (`classifier.ts:381-387`). A shorter `actionSummary` of `safeJson(input, 6000)` (`state.ts:66-70`) is used only for log/UI text, not for the judge (`extension.ts:752` passes the serialised full input). |
| pi-verdict | yes (`name: …`) | JSON of args, or `command`/`path` if present (`pi-verdict.ts:1399-1403`) | `MAX_ENTRY_CHARS = 1000` (`:1377`); over that, **head 60% + `…[truncated]…` + tail 40%** (`:1380-1387`); line breaks escaped to `\n` (`:1395-1397`). Applied to the action line (the last transcript line, `:1434`, `:2158`, judged at `:1679`). Also cuts `User:` lines and the last 10 tool calls the same way (`:1375-1376`). |
| erichll | `toolName`, `surface` | `toolInputPreview` string from permission-system, passed unchanged (`src/review/input.ts:140`) | `reviewerRequestView` cuts only `command`, `executedUnit`, `fullCommand` to 10 240 UTF-8 bytes (`review/shell-text.ts:29`, `input.ts:215-233`); `toolInputPreview` is **not** cut. Evidence items taken from the transcript are rendered by `boundedString` with `MAX_EVIDENCE_ITEM_CHARACTERS = 4000`, middle cut with `…[middle truncated]…` (`policy.ts:205`, `:716-728`). The size of `toolInputPreview` itself: unknown (comes from permission-system). |
| mzwing | yes | `toolInput` = the assistant tool call's full `arguments` (`transcript.ts:254-267`) plus the ask fields incl. `toolInputPreview` (`prompt.ts:6-24`, `:47`) | "The request is never truncated: a reviewer must not approve an action it saw only in part" (`prompt.ts:31`). Only the surrounding **transcript** is capped: 1 000 tokens per tool entry, 10 000 total per pool (`transcript.ts:4-5`). |
| ohmyjev | yes (`tool`) | `clip(json(input), 4000)` (`adapters/pi.ts:536`) | `clip` is **head only**: first `n-1` chars + `…` (`hooks/policy.ts:243-246`). Bash/write payloads use `CLIP = 16_000` (`adapters/pi.ts:126`, `:504`) and set `truncated: true` for bash only (`:504`); MCP gets no `truncated` flag. Recent-history tool lines are cut to 400 chars (`:615`). |

In all cases the judge text is labelled or treated as untrusted data (pi-automode `classifier.ts:379`; mzwing `prompt.ts:51`).

## 3. What happens when a call is too big

- **pi-automode: fail closed, no truncation, checks `contextWindow`.** `classifierRequestLimitReason` (`classifier.ts:433-467`) estimates input at 4 chars/token, adds output reserve (stage max tokens + reasoning budget, capped by the model's `maxTokens`) and a 4 096-token margin, and compares with `model.contextWindow`. If it does not fit: block with "Exact tool input cannot fit in the … classifier context without truncation … auto mode fails closed" (`:464-466`). A model with no valid `contextWindow` or `maxTokens` also blocks (`:441-446`). It is called before both the fast stage (`:726-736`) and the detailed stage (`:816-828`); each returns `decision: "block"`. The agent sees a block, the user a notify (`extension.ts:365-369`) if there is a UI. The user cannot approve; there is no prompt fallback.
- **pi-verdict: truncate and judge; no size check.** No `contextWindow` use anywhere in `extensions/pi-verdict.ts` (searched). Middle of a long argument (typical for a big payload) is dropped, silently apart from the in-text marker. Judge failures (provider error, malformed answer) fail closed to deny, with an optional fallback model (`:2204-2238`).
- **erichll: shed optional evidence, then fail closed locally, then `failureMode`.** `applyReviewerInputBudget` (`src/review/input.ts:424-491`) drops secondary reasons, older tool matches, optional results; if still over `maxReviewerInputTokens` (default 8 192, range 2 048..32 768, `review/config.ts:25`, `:139-141`) it sets `failureCode = "reviewer_input_budget_exceeded"` (`:490`) and the model is not called (`review/complete.ts:178-182`). README: "If mandatory evidence does not fit, review fails closed before calling the model" (`README.md:385-391`). The outcome is `config.failureMode`, default `"deny"`, or `"defer"` to the human terminal (`src/index.ts:323`, `review/config.ts:27`, `README.md:222-223`). A truncated command (>10 KiB) defers to a human regardless (`complete.ts:97-101`, `README.md:111-114`). It does not read the model's `contextWindow` (searched `src`); the budget is a configured number. A user-approved retry skips the budget failure (`complete.ts:143-152`).
- **mzwing: defer to the user's prompt; checks `contextWindow`.** `approximateTokens(prompt) + OUTPUT_RESERVE_TOKENS (16 384) > model.contextWindow` returns `input-budget-exceeded` (`reviewer.ts:20`, `:142-144`; estimator `chars/4`, `transcript.ts:65-67`). Any non-cancel failure maps to `{kind: "defer"}` (`reviewer.ts:236-246`), and README says "whatever it cannot decide falls through to the normal prompt" (`README.md:5`). Cancelled reviews deny (`:238-240`).
- **ohmyjev: truncate and judge; failure is fail-open.** The 4000-char head cut is silent for MCP. If the judge call fails or no key is set, `decide` returns `null` (`adapters/shared.ts:106-127`) and the gate does `if (!d) return`, i.e. the call proceeds (`adapters/pi.ts:532-545`). Its backend is a hosted Jev API (`askJev`), not a Pi model; no `contextWindow` check for the judge model (only `getContextUsage` for the main session, `adapters/pi.ts:57`).

## 4. Headless (no UI) behaviour for a call needing approval

- **pi-automode:** a judged call never needs a human; the judge decides allow/block and block applies headless (`extension.ts:365` notifies only `if (ctx.hasUI)`). A `permissions.ask` rule match with no UI is **blocked**: "…but no UI is available" (`extension.ts:546-565`).
- **pi-verdict:** asks degrade to **deny** with no UI, built into `adjudicate` (`pi-verdict.ts:2243-2268`, "ask:无 UI 降级为 deny"; the `hasUI` flag is `:2036`). The same applies to the protected-path ask (`:2179-2190`).
- **erichll:** unknown for plain headless. The reviewer's `defer` hands back to permission-system's own prompt/headless rules, which were not read; `/auto-review-approve` and break-glass require TUI mode (`src/index.ts:417`, `:502`).
- **mzwing:** unknown for the same reason; `defer` falls through to permission-system's prompt (`README.md:5`).
- **ohmyjev:** not applicable: there is no ask; its gates only allow or deny (`adapters/pi.ts:495-545`).

## Implications for the pi-bouncer decision

- Sending the **whole** argument and checking it against the judge model's `contextWindow` has precedent (pi-automode, mzwing); both use a 4-chars-per-token estimate plus a reserve (4 096 margin + output; 16 384 output).
- What to do when it does not fit splits two ways: **fail closed** (pi-automode, erichll) or **hand to the user** (mzwing, and erichll with `failureMode: "defer"`). Silent truncation then judging (pi-verdict, 1000 chars; ohmyjev, 4000 chars) is the minority, and is the pattern that lets a judge approve what it saw only in part. mzwing states that reasoning in `prompt.ts:31`.
- No peer sends the tool description.

## Not checked / unknown

- @gotgenes/pi-permission-system (source of `toolInputPreview`, the ask payload, and headless ask behaviour) was not read; its preview size cap and headless fallback are `unknown`.
- Default permission-system policy for unmatched MCP calls: `unknown`.
- pi-automode's transcript context carries earlier tool calls capped at 1 000 tokens each (`transcript.ts:5-6`, middle-cut marker `<truncated approx_tokens="…" />` at `:73-85`); only the current action is uncapped. Not traced into the final prompt layout beyond that.
- Whether any of these packages' published npm tarballs differ from the GitHub HEAD read: unknown (GitHub source only).
