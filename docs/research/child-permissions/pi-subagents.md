# How Pi subagent / workflow / delegation packages launch children and interact with permission extensions

**Question.** How do the other Pi subagent / workflow / delegation packages launch
children, identify them, and interact with permission extensions? Which signals
should a permission extension (pi-bouncer) read to identify a child and its
agent, and can in-process children be supported at all given the process-wide
mode?

**Short answer.** There is no cross-vendor convention. The only widely repeated
signal is an environment-marker variable in the child, and its *names* differ per
package: nicobailon/pi-subagents sets `PI_SUBAGENT_CHILD=1` (and
`PI_SUBAGENT_PARENT_SESSION` for pi-permission-system asks), HazAT sets
`PI_SUBAGENT_AGENT` (the agent type) among a `PI_SUBAGENT_*` block, pi-daddy sets
`PI_DADDY_DEFINITION` (the agent definition) among a `PI_DADDY_*` block, and
@henryqw uses `--pi-subagent-role-tools` flags plus `PI_SUBAGENT_EXECUTION_BUDGET`.
Subprocess and tmux launchers can set an explicit env var, but inheritance of the
parent's `process.env` is not guaranteed (the local `delegate` uses the tmux
server environment plus a whitelist). In-process children (nicobailon foreground,
tintinweb, gotgenes, @quintinshaw, @agwab) have no environment boundary at all;
the reliable per-call signal there is the session id on `ExtensionContext`
(`ctx.sessionManager.getSessionId()`), which a permission extension can map to an
agent name via the orchestrator's `pi.events` lifecycle events or a published
registry. In-process children are therefore supportable, but only when the
orchestrator actually loads the permission extension into the child session
(tintinweb and gotgenes do by default; nicobailon foreground and @quintinshaw
deliberately do not). **Recommendation:** read an explicit `PI_BOUNCER_AGENT`
first, fall back to a small list of child-marker env vars for the agent name and
for "am I a child?", and for in-process children use
`ctx.sessionManager.getSessionId()` plus lifecycle-event/registry mapping — fail
closed to the most restrictive permission set when a child marker is present but
the agent name is unknown.

## Date and versions checked

Checked 2026-10-02 (local time). Pi itself is
`@earendil-works/pi-coding-agent` **1.0.0** at
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent` (the `pi
--version` output and that package's `package.json` both report `1.0.0`).
Packages were read from npm tarballs extracted into
`/tmp/pi-child-research-2026-10-02/`; HazAT/pi-interactive-subagents is not on
npm and was read from GitHub at commit
`c100577ebf7393a11d098ad9810ec6c269dcfc30`. Popularity is npm weekly downloads
from `https://api.npmjs.org/downloads/point/last-week/<pkg>` on 2026-10-02.

| Package | Version read | Weekly downloads (npm) |
|---|---|---|
| `pi-subagents` (nicobailon) | 0.74.0 | 191,312 |
| `pi-background-tasks` | 2.6.9 | 31,226 |
| `@tintinweb/pi-subagents` | 0.19.0 | 7,639 |
| `@quintinshaw/pi-dynamic-workflows` | 3.13.1 | 6,018 |
| `@gotgenes/pi-subagents` | 21.9.1 | 3,122 |
| `@henryqw/pi-subagent` | 25.0.2 | 2,607 |
| `@osolmaz/pi-workflows` | 0.17.6 | 1,499 |
| `pi-daddy` | 0.43.1 | 1,249 |
| `@agwab/pi-workflow` | 0.15.0 | 608 |
| `pi-subagent-permission-compat` | 0.1.0 | 9 |
| HazAT/pi-interactive-subagents | GitHub `c100577` | not on npm (716 GitHub stars) |

Command and output (one line per package):

```
$ for p in ...; do printf "%-40s " "$p"; v=$(npm view "$p" version); \
    dl=$(curl -s "https://api.npmjs.org/downloads/point/last-week/$p" | jq .downloads); \
    echo "v$v  $dl/wk"; done
pi-subagents                             v0.74.0  191312/wk
pi-background-tasks                      v2.6.9  31226/wk
@tintinweb/pi-subagents                  v0.19.0  7639/wk
@quintinshaw/pi-dynamic-workflows        v3.13.1  6018/wk
@gotgenes/pi-subagents                   v21.9.1  3122/wk
@henryqw/pi-subagent                     v25.0.2  2607/wk
@osolmaz/pi-workflows                    v0.17.6  1499/wk
pi-daddy                                 v0.43.1  1249/wk
@agwab/pi-workflow                       v0.15.0  608/wk
pi-subagent-permission-compat            v0.1.0  9/wk
```

Extraction command (fresh `/tmp` dir, no `rm -rf`), repeated per package:

```
$ mkdir -p /tmp/pi-child-research-2026-10-02/<dir>
$ url=$(npm view pi-subagents dist.tarball)   # https://registry.npmjs.org/pi-subagents/-/pi-subagents-0.74.0.tgz
$ curl -sL "$url" | tar xz -C <dir> --strip-components=1
```

## The baseline: Pi's own bundled subagent example (1.0.0)

Path:
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts`.

- **Subprocess.** It spawns a separate `pi` per agent:
  `spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore","pipe","pipe"] })`
  (`index.ts:346-350`), with args `["--mode", "json", "-p", "--no-session"]`
  (`index.ts:300`).
- **No env is passed**, so the child inherits the parent's `process.env` by
  Node's default (`index.ts:346-350` has no `env` key). It sets no `PI_*` marker
  of its own.
- **Agent name is not exposed to the child through env.** The agent's system
  prompt is written to a temp file and passed as
  `--append-system-prompt <file>` (`index.ts:333-341`); the agent name itself is
  never passed as `--name` or an env var. The child's system prompt contains the
  agent body, so a permission extension hosted in the child cannot learn the
  agent name from the environment or argv — only from the prompt text.
- **Per-agent tool scope** is a `tools:` frontmatter list in the agent markdown,
  passed as `--tools <a,b,c>` when non-empty (`index.ts:307`); discovery and the
  frontmatter live in `agents.ts`. There is no per-agent deny list and no
  per-child ask prompt.
- **Approvals live in the parent, not the child:** the example asks the *parent*
  user to confirm running project-local agents in an untrusted project
  (`ctx.ui.confirm`, `index.ts:~520-560`; described in
  `examples/extensions/subagent/README.md`, "Security Model"). It has no
  `tool_call` gating.
- **Events:** the file contains no `pi.events` calls (verified by `rg
  "pi\.events" index.ts` returning nothing), so a permission extension cannot
  hook this launcher.
- **Extensions in the child:** none are disabled (no `--no-extensions`), so the
  child is a normal Pi process and loads the normal extension set, including a
  permission extension if installed.

## nicobailon/pi-subagents 0.74.0 (the popular one)

Tarball: `https://registry.npmjs.org/pi-subagents/-/pi-subagents-0.74.0.tgz`.

- **In-process and subprocess.** "A child is a pi `AgentSession` created inside
  the process that owns it: the parent pi process for foreground children, the
  detached runner process for background children."
  (`src/runs/shared/child-session.js:10-16`). `docs/watchdog.md:183` repeats:
  "Children are pi sessions inside the parent process (foreground) or the
  detached runner process (background), not separate `pi` binaries".
- **Env vars it sets.**
  - `PI_SUBAGENT_CHILD` — `export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD"`
    (`src/runs/shared/child-runtime-config.js:6`), set as `"1"` in the
    child-hosting process (`src/runs/background/subagent-runner.js:86`:
    `process.env[SUBAGENT_CHILD_ENV] = "1"`). The extension entry point
    registers nothing when it sees it, so an ambient copy stays inert
    (`src/extension/index.js`, `if (process.env[n] === "1")`).
  - `PI_SUBAGENT_PARENT_SESSION` — `SUBAGENT_PARENT_SESSION_ENV` is documented as
    "Root parent session id the parent publishes for pi-permission-system ask
    forwarding" (`src/runs/shared/child-runtime-config.js:8`). Only the detached
    runner gets it: `runnerEnv[SUBAGENT_PARENT_SESSION_ENV] =
    launchParentSessionId` (`src/runs/background/async-execution.js:480-482`).
- **Env inheritance.** The detached runner's env is a spread of the parent's:
  `const runnerEnv = { ...omitGitRoutingEnv(omitExtensionBindingsEnv(process.env)), ... }`
  (`src/runs/background/async-execution.js:469-478`) and that object is passed as
  `env: runnerEnv` (`:487`). So the runner inherits the parent environment minus
  named keys, then adds the marker.
- **Agent name in the child.** Not an env var in 0.74.0. Agent identity travels in
  the child runtime config (`childSupervisorMetadata(config)` builds
  `{ channelDir, runId, agent, childIndex, orchestratorSessionId, ... }`,
  `src/runs/shared/child-runtime-config.js:9-20`), i.e. through the SDK session
  and events, not `process.env`.
- **Events on `pi.events`** (literals from `src/shared/types.js:11-18`,
  `src/api/delegation.js:4-7`, `src/extension/rpc.js:18`):
  `subagent:async-started`, `subagent:async-complete`,
  `subagent:foreground-complete`, `subagent:child-status`,
  `prompt-template:subagent:request`, `prompt-template:subagent:response`,
  `subagents:rpc:v1:ready`. Emitted at
  `src/runs/foreground/subagent-executor.js:2895,5105,5315` and
  `src/extension/rpc.js:472,712`.
- **Tool permissions per agent.**
  - `tools` is a "Strict child tool allowlist" and `excludeTools` an optional
    deny list applied after resolution (`docs/agents.md:348-349`).
  - A separate native gate exists: "Native child tool permissions … Values are
    `allow`, `ask`, and `deny`" from agent frontmatter `permission:` /
    `permissions:`, with an `ask` answered by a one-call arbiter model (the child
    watchdog), not the user (`docs/watchdog.md:177-181`). "Bash is always passed
    through; bash rules are rejected" (`docs/watchdog.md:183`).
  - External CLI agent profiles are opaque processes and launches with effective
    `ask`/`deny` are rejected (`docs/watchdog.md:183`).
- **Extension loading in the child.** Foreground children never load ambient
  parent extensions; background children load the parent's ambient extensions
  unless `extensions` says otherwise (`docs/agents.md:352`). Per-agent
  `extensions` and `subagentOnlyExtensions` control it (`docs/agents.md:353`).
  So a permission extension in the parent is not carried into a foreground
  in-process child unless that agent lists it.
- **Documented permission-extension integration.** `PI_SUBAGENT_PARENT_SESSION`
  exists specifically so "Environment-only permission extensions" can forward
  `ask` requests, but only for detached runners: "Root and in-process foreground
  hosts do not publish a global parent identity because multiple Pi sessions can
  share a host. … that path remains unsupported until the extension accepts a
  session-scoped target." (`docs/watchdog.md:185`).

## @tintinweb/pi-subagents 0.19.0 (in-process)

Tarball: `https://registry.npmjs.org/@tintinweb/pi-subagents/-/pi-subagents-0.19.0.tgz`.

- **In-process.** It imports `createAgentSession` from the Pi SDK
  (`src/agent-runner.ts:13`) and calls it inside an async-context marker:
  `const { session } = await runInChildSessionContext(() => createAgentSession(sessionOpts))`
  (`src/agent-runner.ts:1008`). The marker is an `AsyncLocalStorage<boolean>`
  (`src/child-context.ts:7-15`) so re-entering the extension in the child is
  prevented (`src/index.ts:302`: "Child AgentSessions load normal extensions.
  Re-entering this extension there would create another manager and leak
  handlers").
- **Env vars: none.** `src/env.ts` only detects git/platform; grep for `PI_`
  across `src/` finds only unrelated names. The child shares the parent's
  `process.env` because it is the same process.
- **Agent name exposure.** Through events and prompts, not env: it is the `type`
  field on `subagents:created` / `subagents:started`
  (`README.md:724-740`). The child's system prompt is built by `prompts.ts`.
- **Events** (`README.md:724-740`): `subagents:created` (`id`, `type`,
  `description`, `isBackground`), `subagents:started`, `subagents:completed`,
  `subagents:failed`, `subagents:steered`, `subagents:compacted`,
  `subagents:scheduled`, `subagents:scheduler_ready`, `subagents:ready`,
  `subagents:settings_loaded`, `subagents:settings_changed`. A cross-extension
  registry is published as `Symbol.for("pi-subagents:manager")`
  (`src/index.ts:659`), which a permission extension can use to map agent ids.
- **Extension loading in the child.** Default is the full discovered set:
  `const loadAll = extensions === true || extensionsSpec?.wildcard === true;`
  and the loader's `extensionsOverride` filters it
  (`src/agent-runner.ts:713-760`). A per-agent `extensions:` list, `extensions:
  false`, `exclude_extensions:` and `isolated` narrow it
  (`src/agent-runner.ts:635-726`). A bouncer installed normally is therefore
  loaded per child by default.
- **Tool permissions.** `tools:` is an allowlist of built-in names plus `ext:`
  selectors; `disallowed_tools` is a deny list applied after the base set
  (`src/agent-runner.ts:640-737`). No interactive ask prompt; the extension has
  no documented permission-extension integration (grep for "permission" in
  `README.md`/`docs/` finds only a tool-description string).

## @gotgenes/pi-subagents 21.9.1 (in-process; launch side only)

Tarball: `https://registry.npmjs.org/@gotgenes/pi-subagents/-/pi-subagents-21.9.1.tgz`.
(A separate report covers this package's permission system; this section covers
launch and identity only.)

- **In-process.** The composition root builds `createAgentSession(...)` from the
  SDK (`src/index.ts:151-172`) and hands it to the assembler; child sessions are
  wrapped in `SubagentSession` (`src/lifecycle/create-subagent-session.ts`).
- **Env vars: none for identity.** The only `PI_*` use is
  `PI_SUBAGENTS_DEBUG` (`src/debug.ts:10`). Process is shared with the parent.
- **Agent identity is published on events**, including the child session id:
  - `subagents:child:spawning` → `{ agentName, parentSessionId? }`
    (`src/lifecycle/child-lifecycle.ts:19, 51-54`).
  - `subagents:child:session-created` → `{ sessionId, parentSessionId? }`
    (`:28, 55-58`), emitted "immediately before `bindExtensions()`. Carries the
    child session id consumers need to register the session … Subscribers must
    register synchronously" (`:20-27`).
  - `subagents:child:bound` → `{ sessionId, parentSessionId? }` (`:37, 62-64`).
  - `subagents:child:completed` → `{ sessionDir, agentName, aborted, steered }`
    (`:40, 66-73`); `subagents:child:disposed` → `{ sessionId }` (`:43, 77-80`).
  - Higher-level `subagents:started/completed/failed/resuming/resumed/compacted/
    created/steered` are exported as `SUBAGENT_EVENTS` from
    `src/service/service.ts:157-168`.
- **A typed service is published** under
  `Symbol.for("@gotgenes/pi-subagents:service")` with `getRecord(id)`,
  `listAgents()`, `spawn`, `resume`, etc. (`src/service/service.ts:114-150,
  169-180`), i.e. an in-process permission extension can resolve agent records.
- **Child extension set.** "A child session runs in the parent's process but is a
  full Pi session with its own extension set" (`README.md`, "Child session
  lifecycle"); it builds a `DefaultResourceLoader` per child
  (`src/index.ts:400-430`) and supports an `excludedExtensionPackages` setting
  that removes packages from the child
  (`src/index.ts:124-135`). Extensions are bound per child, and
  `session_shutdown` fires once per child (`README.md`, "Child session
  lifecycle").
- **Tool permissions (launch side).** `createAgentSession` gets an allowlist
  `tools: string[]` and a denylist `excludeTools?: string[]` applied on every
  tool-registry rebuild (`src/lifecycle/create-subagent-session.ts`, options
  interface); the extension's own tool names are denied in children via
  `EXCLUDED_TOOL_NAMES = ["subagent", "get_subagent_result", "steer_subagent"]`
  (same file).

## pi-subagent-permission-compat 0.1.0 (the compat shim)

Tarball:
`https://registry.npmjs.org/pi-subagent-permission-compat/-/pi-subagent-permission-compat-0.1.0.tgz`.

- **Purpose:** "publishes `PI_SUBAGENT_PARENT_SESSION` for root Pi processes, so
  subagent child processes that inherit the environment can route their
  permission asks back to the parent session", for compatibility with
  `@gotgenes/pi-permission-system` (`README.md`, intro).
- It publishes `PI_SUBAGENT_PARENT_SESSION` at `session_start` only when the
  process is a root, skipping when any child hint or an existing parent-session
  declaration is present (`extensions/parent-session-env.ts:99-115`), and removes
  its own value at `session_shutdown` (`:118-135`).
- **It is the best available catalogue of third-party child env markers**
  (`extensions/parent-session-env.ts:17-41`), though the list is a declaration of
  *other* packages' names and I could only verify some of them in the current
  tarballs:
  - pi-agent-router: `PI_IS_SUBAGENT`, `PI_SUBAGENT_SESSION_ID`,
    `PI_AGENT_ROUTER_SUBAGENT` (`:19-21`); parent:
    `PI_AGENT_ROUTER_PARENT_SESSION_ID` (`:46`).
  - nicobailon/pi-subagents: `PI_SUBAGENT_CHILD`, `PI_SUBAGENT_RUN_ID`,
    `PI_SUBAGENT_CHILD_AGENT`, `PI_SUBAGENT_DEPTH` (`:23-26`).
  - HazAT/pi-interactive-subagents: `PI_SUBAGENT_NAME`, `PI_SUBAGENT_ID`,
    `PI_SUBAGENT_SESSION`, `PI_SUBAGENT_ACTIVITY_FILE` (`:28-31`).
  - HamdiMaz/pi-sub-agent: `PI_SUB_AGENT_DEPTH` (`:33`).
  - shared convention: `PI_SUBAGENT_PARENT_SESSION` (`:46-47`).
- **Its own limits** are explicit: "Processes with a replaced environment,
  long-running daemons, remote launches, and **in-process subagents sharing one
  `process.env`** are not covered." (`README.md`, "Notes and Limitations"). The
  cwd guard matches tool names containing `subagent`, `delegate`, `spawn`, or
  `agent`, asks once per call, and hard-blocks input it cannot scan
  (`README.md`, "Subagent cwd Guard").

## pi-daddy 0.43.1 (governed subprocess, closest prior art)

Tarball: `https://registry.npmjs.org/pi-daddy/-/pi-daddy-0.43.1.tgz`.

- **Subprocess.** "Enforcement is pi's own `--tools` allowlist on a separate child"
  (`README.md:5`); `planSpawn` builds `pi` argv including `--tools` (or
  `--no-tools`) (`src/kernel/spawn.js`, comment and body) and the granted child
  also loads the governance extension explicitly with `-e`
  (`dist/kernel/delegate.js:314`).
- **Env it passes** (`src/kernel/env-names.ts:17-34`, written in
  `dist/kernel/delegate.js:322-341`): `PI_DADDY_GRANT` (comma-separated
  capabilities), `PI_DADDY_DEPTH`, `PI_DADDY_MAX_DEPTH`, `PI_DADDY_GATED`,
  `PI_DADDY_LEDGER`, `PI_DADDY_APPROVED`, `PI_DADDY_FANOUT`,
  `PI_DADDY_PARENT_ID`, `PI_DADDY_EXECUTION_ID`, `PI_DADDY_EPISODE_ID`, and the
  child attribution trio `PI_DADDY_EPISODE`, `PI_DADDY_DEFINITION`,
  `PI_DADDY_EXECUTION`. `PI_DADDY_DEFINITION` is set to the requested agent /
  `DELEGATE_SUBJECT` (`dist/kernel/delegate.js:341`) — this is the agent-name
  env-var precedent.
- **Grant narrows downward**: a delegated child receives
  `inheritableGrant(result.effective)` (`dist/kernel/delegate.js:318-323`), and
  "a sub-agent may delegate further, but only ever a subset of what it holds"
  (`README.md:4-5`).
- **Legacy/namespace note:** the package renamed `PI_GRANTS_*` to `PI_DADDY_*`
  and keeps a legacy read table for one minor release
  (`src/kernel/env-names.ts:47-70`).

## HazAT/pi-interactive-subagents (GitHub `c100577`, tmux/cmux panes)

Repository: `https://github.com/HazAT/pi-interactive-subagents`;
files read at
`https://api.github.com/repos/HazAT/pi-interactive-subagents/contents/pi-extension/subagents/index.ts?ref=c100577ebf7393a11d098ad9810ec6c269dcfc30`.

- **Tmux/cmux/zellij panes, subprocess.** It builds a `pi` CLI command and sends
  it into a multiplexer pane (`cmux.ts` picks the backend; `pi` args at
  `index.ts:1075-1145`). It was last pushed 2026-05-12 and imports from the old
  package scope `@mariozechner/pi-coding-agent` (`index.ts:1`), so it is a stale
  package — but it is the origin of several env names.
- **Env prefix set on the child** (`index.ts:1126-1143`):
  `PI_CODING_AGENT_DIR` (when set), `PI_DENY_TOOLS`,
  `PI_SUBAGENT_NAME=<instance name>`, `PI_SUBAGENT_AGENT=<agent type>` (only when
  an agent is given), `PI_SUBAGENT_AUTO_EXIT=1` (when the agent opts in),
  `PI_SUBAGENT_SESSION`, `PI_SUBAGENT_ID`, `PI_SUBAGENT_ACTIVITY_FILE`,
  `PI_SUBAGENT_SURFACE`. The same names are re-derived on resume
  (`index.ts:1831-1839`).
- **Agent name to the child: yes**, as `PI_SUBAGENT_AGENT`; the child reads it
  back for a self-spawn guard (`index.ts:1419`: `const currentAgent =
  process.env.PI_SUBAGENT_AGENT`).
- **Env inheritance.** The pane shell gets the multiplexer's environment; the
  launcher prefixes only the listed assignments. `cmux.ts:156` spreads
  `{...process.env}` for its own exec, but the child command's inheritance
  depends on the mux (tmux server env vs `update-environment`) — exact inheritance
  is `unknown` for cmux/zellij.
- **Tool permissions.** `--tools` allowlist built from the agent's `tools:`
  frontmatter (`index.ts:666-690, 1116`), plus `PI_DENY_TOOLS` which makes the
  child extension skip registering those tools (`index.ts:1386-1390`:
  `const deniedTools = new Set((process.env.PI_DENY_TOOLS ?? "").split(",")...)`).
  The Claude-Code path uses `--dangerously-skip-permissions`
  (`index.ts:1017`), not a Pi permission check.
- **Events:** none on `pi.events`; completion is detected by reading the child
  session file / activity file and a `subagent_done` tool
  (`index.ts:1090-1130`, `activity.ts`, `session.ts`).

## Other popular launchers (shorter)

### @henryqw/pi-subagent 25.0.2 — subprocess, flag-driven tool policy

- **Subprocess:** `spawn(invocation.command, args, { env: {...process.env,
  ...prepared.launch.env, [EXECUTION_BUDGET_ENV]: ...} })`
  (`dist/ephemeral.js:384-401`), args `--mode json -p ...`
  (`dist/ephemeral.js:384`).
- **Env:** `PI_SUBAGENT_EXECUTION_BUDGET` (JSON budget,
  `dist/ephemeral.js:9,397`) and `PI_SUBAGENT_PROCESS_LEASE`
  (`dist/index.d.ts:8`, enforced in `extensions/role-tools.ts:101`).
- **Tool policy:** not env — a child extension loaded with `-e` enforces
  `--pi-subagent-role-tools` (JSON tool names) at `session_start` by calling
  `pi.setActiveTools([...])` (`extensions/role-tools.ts:104-130`), with a
  forbidden-tool exclusion list (`--no-session --no-extensions --no-skills
  --exclude-tools <...>` in `dist/index.js:286`).
- **Agent name:** role is delivered via prompt/argv flags; no agent-name env
  variable found.
- **Events:** none found on `pi.events`.

### pi-background-tasks 2.6.9 — subprocess, capability-based

- **Subprocess:** `pi --mode text --print --session-id <id> --session-dir <dir>
  --no-builtin-tools --tools <...> --exclude-tools <...> [--no-extensions]
  --extension <path> ...` (`src/core/delegate/launch.ts:290-330`). An
  evidence-oriented variant launches `pi --mode json` (`src/core/attested-pi-run.ts:271`).
- **Env:** it deliberately strips the parent session identity —
  `DELEGATE_REMOVED_ENV_KEYS = ['PI_SESSION_ID','PI_SESSION_FILE','PI_PROVIDER',
  'PI_MODEL','PI_REASONING_LEVEL']` (`src/core/delegate/launch.ts:330-338`) —
  then sets `PI_BG_DELEGATE_ARTIFACT_DIR`, `PI_BG_DELEGATE_SEED_PATH`,
  `PI_BG_DELEGATE_SEED_SHA256`, `PI_BG_DELEGATE_TASK_ID`,
  `PI_BG_DELEGATE_LAUNCH_NONCE` (`src/core/delegate/launch.ts:353-357`).
  This is the clearest evidence that a parent's env is *not* simply inherited.
- **Events on `pi.events`:** a versioned request channel
  (`src/core/extension-api.ts:449,565`; documented in
  `docs/api/eventbus-v1.md`).
- **Agent name:** not in env; the tool set is derived from a capability string
  (`delegateToolsFor(input.capability)`, `src/core/delegate/launch.ts:203-210`).

### @quintinshaw/pi-dynamic-workflows 3.13.1 — in-process, host extensions off

- **In-process:** `createAgentSession` from the SDK (`dist/agent.js:4`,
  `src/agent.ts:8-16`).
- **Host extensions are disabled for children by default:** "Child sessions
  intentionally disable host extensions to avoid per-child factory churn and
  recursive orchestration" (`README.md:243`); "Subagents no longer load host
  extensions by default. Each run now builds one shared, extension-free resource
  loader" (`README.md:332`). Opt-in is `providerMiddlewareExtensions`
  (`README.md:243`). `pi-dynamic-workflows`, `workflow`, and `pi-subagents` are
  always excluded.
- **A process-wide spawn policy** exists: `setPreSpawnModelResolver` registered
  on `globalThis` under `Symbol.for("@quintinshaw/pi-dynamic-workflows.preSpawnModelResolver")`
  (`README.md:360-362`); it can reject a spawn but is model routing, not a tool
  gate.
- **Env:** no per-child identity marker; only `PI_CACHE_RETENTION`/
  `PI_WORKFLOW_AGENT_CACHE_RETENTION` applied to the child's stream options
  (`src/child-cache-retention.ts:24-37`).
- **Events:** `WORKFLOW_LIFECYCLE_EVENT = "pi-dynamic-workflows:lifecycle"`
  (`src/task-panel.ts:653`) with `{ status, runId, name }` and `sessionId` when
  known (`README.md:271`).
- **Tool scope:** `allowedTools` / `excludeTools` on the agent type
  (`src/agent.ts:334,731`).
- **Consequence for the bouncer:** an in-process child here has *no* permission
  extension loaded, so per-child gating is impossible unless
  `providerMiddlewareExtensions` (or an SDK resource loader) opts the bouncer in.

### @osolmaz/pi-workflows 0.17.6 — subprocess RPC

- **Subprocess:** `spawn(piBin, ["--mode","rpc","--no-session",...], { env:
  {...process.env, ...this.options.env} })` (`src/server/rpc-executor.ts:156-172`).
  One child serves one agent step. It has no agent-name env marker.

### @agwab/pi-workflow 0.15.0 — worker role marker

- It sets `process.env[PI_WORKFLOW_ROLE] = "worker"` around a launch and restores
  it afterwards (`src/subagent-backend.ts:619-638`), i.e. an *in-process*
  marker, not a child env. Its `headless` backend is named at
  `src/subagent-backend.ts:254`, and `src/backend.ts` only declares the backend
  type (`id: "pi-subagent/headless"`, `src/backend.ts:72`); the exact child
  execution mechanism is `unknown` from the files read. Weekly downloads 608.

## In-process children and the Pi extension API

This is the crux of the bouncer's design.

- **Each `AgentSession` owns its own extension runtime**: "`createAgentSession()`
  creates an `AgentSession`. The session owns one conversation, its model and
  tools, queued messages, compaction state, and extension runtime."
  (`docs/sdk.md:28`). Extensions bound to a child session receive that session's
  events; the parent's extension instance does not receive the child's
  `tool_call` events.
- **`ExtensionContext` carries the session**: it has
  `sessionManager: ReadonlySessionManager` (`dist/core/extensions/types.d.ts:213,
  218`), and `ReadonlySessionManager` exposes `getSessionId` and
  `getSessionFile` (`dist/core/session-manager.d.ts:178, 246-247`).
- **`tool_call` handlers get that context**: `pi.on("tool_call", async (event,
  ctx) => ...)` (`docs/extensions.md:169`); the event is only
  `toolCallId`/`parentToolCallId`/`toolName`/`input`
  (`dist/core/extensions/types.d.ts:888-952`) — it does **not** itself carry a
  session id. The session id comes from the handler's `ctx`.
- **Therefore:** an in-process permission extension *can* tell which session a
  `tool_call` belongs to, by `ctx.sessionManager.getSessionId()`. What it cannot
  do is see a child that never loaded it. Loading is decided by the
  orchestrator's resource loader:
  - tintinweb: loads the full discovered set by default
    (`src/agent-runner.ts:713-760`), so a normally installed bouncer is present
    per child.
  - gotgenes: builds a full child session with its own loader and loads normal
    extensions (`README.md`, "Child session lifecycle"; `src/index.ts:400-430`).
  - nicobailon: foreground children never load ambient extensions
    (`docs/agents.md:352`).
  - @quintinshaw: children are extension-free by default (`README.md:243,332`).
- **Mapping session id → agent name, in process:** gotgenes publishes
  `subagents:child:session-created` with `sessionId` + `parentSessionId`, and
  `subagents:child:spawning` with `agentName` before it
  (`src/lifecycle/child-lifecycle.ts:19-80`); tintinweb publishes
  `subagents:created`/`subagents:started` with an `id` and `type`
  (`README.md:724-740`) plus the `Symbol.for("pi-subagents:manager")` registry
  (`src/index.ts:659`); gotgenes also publishes a service under
  `Symbol.for("@gotgenes/pi-subagents:service")` with `getRecord(id)`
  (`src/service/service.ts:114-180`).
- **The process-wide mode problem.** `src/mode.ts` stores mode on `globalThis`
  under `Symbol.for("pi-bouncer.mode")`, so every extension runtime in the
  process (including a child's) shares one holder. Per-child permission sets
  therefore need a second, session-scoped layer keyed by
  `ctx.sessionManager.getSessionId()`, not a second process-wide holder. The
  existing `session:launch` contributor (`src/session-launch.ts:43-50`, which
  appends `--auto`/`--yolo`) runs in the **parent** and cannot know the child's
  session id — for in-process children the session id only exists after
  `createAgentSession`, which is why the event/registry route is required.

## Local `delegate` (the launcher this feeds)

`~/pi/extensions/delegate/index.ts` (the sibling extension named in the brief):

- It emits `session:launch` with `{ args, env }` before opening the window
  (`index.ts:415-421`), and the bouncer already consumes it
  (`pi-bouncer/src/session-launch.ts:43-50`).
- The launch `env` it builds is small: `PI_CODING_AGENT_DIR`,
  `PI_DELEGATE_PARENT`, `PI_DELEGATE_AUTO_EXIT` (+ `PI_CODING_AGENT_SESSION_DIR`
  when set) (`index.ts:407-414`). The agent name is in `args` as
  `--name <agent>-<label>` and in the record (`index.ts:395-410`), **not** in
  `env` and **not** in the `{ args, env }` payload as a named field.
- Its README states the child starts "with the tmux server's environment plus
  only these from the parent: `PI_CODING_AGENT_DIR`,
  `PI_CODING_AGENT_SESSION_DIR` …, `PI_DELEGATE_PARENT` and
  `PI_DELEGATE_AUTO_EXIT`" (`README.md:122-127`). So the child does **not**
  inherit arbitrary parent env; a `PI_BOUNCER_AGENT` must be added explicitly by
  the launcher (or by a `session:launch` listener, which can only add env, not
  read the agent name reliably from the current payload).

Pi itself also sets two process markers, `AI_AGENT=pi` and
`PI_CODING_AGENT=true`, which child processes inherit, and injects
`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`,
`PI_REASONING_LEVEL` into the shell tools (`docs/environment-variables.md`,
"Process Marker" and "Shell Tool Session Environment"). These identify "inside
Pi", not "child vs parent", and the shell-tool variables are not in the
extension's own `process.env`.

## Env-var conventions (table)

| Package | Child env marker(s) | Agent-name env var | Parent-session env var | "Child?" detection |
|---|---|---|---|---|
| Pi bundled example (1.0.0) | none | none (system prompt only) | none | none |
| nicobailon/pi-subagents 0.74.0 | `PI_SUBAGENT_CHILD=1` | none in 0.74.0 (config/events) | `PI_SUBAGENT_PARENT_SESSION` (detached runner only) | `PI_SUBAGENT_CHILD` |
| @tintinweb/pi-subagents 0.19.0 | none | none (events `type`) | none | none |
| @gotgenes/pi-subagents 21.9.1 | none | none (events `agentName`) | none (events carry `parentSessionId`) | none |
| pi-subagent-permission-compat 0.1.0 | writes none for child | none | writes `PI_SUBAGENT_PARENT_SESSION` in root | reads the third-party list below |
| HazAT/pi-interactive-subagents | `PI_SUBAGENT_NAME`, `PI_SUBAGENT_SESSION`, `PI_SUBAGENT_ID`, `PI_SUBAGENT_ACTIVITY_FILE`, `PI_SUBAGENT_SURFACE`, `PI_SUBAGENT_AUTO_EXIT`, `PI_DENY_TOOLS` | `PI_SUBAGENT_AGENT` | none | any `PI_SUBAGENT_*` |
| @henryqw/pi-subagent 25.0.2 | `PI_SUBAGENT_PROCESS_LEASE`, `PI_SUBAGENT_EXECUTION_BUDGET` (plus `--pi-subagent-role-tools` flag) | none (flag/role) | none | lease/budget presence |
| pi-daddy 0.43.1 | `PI_DADDY_GRANT`, `PI_DADDY_DEPTH`, `PI_DADDY_MAX_DEPTH`, `PI_DADDY_GATED`, `PI_DADDY_APPROVED`, `PI_DADDY_FANOUT`, `PI_DADDY_PARENT_ID`, `PI_DADDY_EXECUTION_ID`, `PI_DADDY_EPISODE_ID` | `PI_DADDY_DEFINITION` | none (parent id in `PI_DADDY_PARENT_ID`) | any `PI_DADDY_*` |
| pi-background-tasks 2.6.9 | `PI_BG_DELEGATE_ARTIFACT_DIR`, `PI_BG_DELEGATE_SEED_PATH`, `PI_BG_DELEGATE_SEED_SHA256`, `PI_BG_DELEGATE_TASK_ID`, `PI_BG_DELEGATE_LAUNCH_NONCE` | none (capability string) | none (strips `PI_SESSION_*`) | any `PI_BG_DELEGATE_*` |
| @quintinshaw/pi-dynamic-workflows 3.13.1 | none | none | none | none |
| @osolmaz/pi-workflows 0.17.6 | none | none | none | none |
| @agwab/pi-workflow 0.15.0 | `PI_WORKFLOW_ROLE=worker` (in-process marker) | none | none | weak |
| Local `delegate` | `PI_DELEGATE_PARENT`, `PI_DELEGATE_AUTO_EXIT`, `PI_CODING_AGENT_DIR` | none today (`--name` in argv) | `PI_DELEGATE_PARENT` | `PI_DELEGATE_PARENT` |
| pi-agent-router (per compat list, not inspected) | `PI_IS_SUBAGENT`, `PI_SUBAGENT_SESSION_ID`, `PI_AGENT_ROUTER_SUBAGENT` | unknown | `PI_AGENT_ROUTER_PARENT_SESSION_ID` | `PI_IS_SUBAGENT` |
| HamdiMaz/pi-sub-agent (per compat list, not inspected) | `PI_SUB_AGENT_DEPTH` | unknown | unknown | `PI_SUB_AGENT_DEPTH` |

## Recommendation: which signals the bouncer should read

1. **Primary: an explicit `PI_BOUNCER_AGENT` set by the launcher.** It is the only
   signal that can carry the agent name across a process boundary without
   parsing another package's argv. Read it at extension init; if present, use the
   named permission set from `bouncer.json`. The local `delegate` must be changed
   to put it in the `session:launch` `env` map (its `README.md:122-127` shows
   arbitrary parent env is not inherited), or the bouncer's `session:launch`
   contributor would have to parse `--name` out of `args`, which is the
   delegate's private format and should be avoided.
2. **Fallback child markers, for "am I a child?" and a best-effort name.** Read
   `PI_SUBAGENT_AGENT` (HazAT) and `PI_DADDY_DEFINITION` (pi-daddy) for the agent
   name, and `PI_SUBAGENT_CHILD`, `PI_SUBAGENT_*`,
   `PI_DADDY_*`, `PI_BG_DELEGATE_*`, `PI_DELEGATE_PARENT` as evidence of being a
   child. Prefer an explicit allow-list of these names; do not treat every `PI_*`
   as a marker, since Pi itself sets `PI_SESSION_*`, `PI_MODEL`, etc. in both
   parents and children.
3. **Fail closed on an unknown child.** If a child marker is present but no agent
   name resolves, apply the most restrictive set (deny or the tightest configured
   set) rather than inheriting the parent's looseness. The bouncer already has a
   fail-closed precedent (unreadable-command denies, `AGENTS.md`).
4. **In-process children: use `ctx.sessionManager.getSessionId()` plus events or
   a registry.** In a `tool_call` handler, `ctx` is the child's context when the
   bouncer is loaded in that child, so `getSessionId()` identifies the session.
   Map it to an agent via the orchestrator's events — gotgenes
   `subagents:child:session-created`/`spawning` (which carry `sessionId` and
   `agentName`), tintinweb `subagents:created`/`started` (`type`) or
   `Symbol.for("pi-subagents:manager")`, gotgenes'
   `Symbol.for("@gotgenes/pi-subagents:service")` — and keep a session-id → set
   map in memory. Accept that this requires the orchestrator to load the bouncer
   into the child; document that @quintinshaw (extension-free by default) and
   nicobailon foreground children are out of scope until they opt the bouncer in.
5. **Make the mode holder session-aware.** Keep the process-wide holder for the
   current session's mode, but add a per-session override map keyed by
   `getSessionId()`. A child's `--auto`/`--yolo` append and a named child set are
   two different things; a child should not be able to widen its parent's set
   unless the named set says so.
6. **Do not assume env inheritance.** pi-background-tasks strips the parent
   session variables (`launch.ts:330-338`) and the local `delegate` uses the tmux
   server env; an absent marker is not proof of "parent", and a present
   `PI_SESSION_ID` from a shell tool is not proof of "child".

## Unknown / unsettled

- **whole nicobailon marker set.** The compat shim lists `PI_SUBAGENT_RUN_ID`,
  `PI_SUBAGENT_CHILD_AGENT`, and `PI_SUBAGENT_DEPTH` for nicobailon, but the
  0.74.0 tarball only contains `PI_SUBAGENT_CHILD` and
  `PI_SUBAGENT_PARENT_SESSION` (verified by `rg` across the tarball). The extra
  names are either historical or from another fork — `unknown`.
- **pi-agent-router and HamdiMaz/pi-sub-agent were not located on npm or GitHub
  in this pass**, so their env names are known only from the compat shim's list
  (secondary).
- **HazAT/pi-interactive-subagents is not published to npm** (E404 for
  `pi-interactive-subagents` and `@hazat/pi-interactive-subagents`), so it has no
  npm weekly downloads; only GitHub stars (716) and a last push of 2026-05-12. It
  imports the retired `@mariozechner/pi-coding-agent` scope.
- **Exact mux env inheritance.** Whether cmux/tmux/zellij panes inherit a
  variable the bouncer's `session:launch` listener added is not verified for each
  backend; the local `delegate` documents no general inheritance, so it is
  treated as not guaranteed.
- **@agwab/pi-workflow:** the `headless` backend's process mechanism is not
  visible in `src/backend.ts` (which is only type declarations); `unknown`.
- **@henryqw/pi-subagent:** whether the child learns its role name through any
  env var (vs only the `--pi-subagent-role-tools` flag and prompt) is `unknown`.
- **Whether any host shares one extension runner across parent and child
  sessions.** Pi's SDK docs say each `AgentSession` owns its extension runtime
  (`docs/sdk.md:28`), and tintinweb's `inChildSessionContext` guard implies a
  fresh factory run per child, but not every in-process host was inspected to the
  same depth.
- **How a permission extension can gate an in-process child whose host loads no
  extensions at all** (nicobailon foreground, @quintinshaw). No hook in the
  files read reaches those child tool calls; treat as unsupported until an
  orchestrator opts in.

---

### Cited claims

Counted claims: **120 statements carry a `path:line` citation** (many with several
line references; plus 6 npm tarball sources, the HazAT GitHub API at `c100577`,
and the installed Pi 1.0.0 docs/dist). Unsettled items: **8** (listed above under
"Unknown / unsettled"). Citable source forms used: npm tarball URL + version + `path:line`
for published packages; `https://api.github.com/repos/HazAT/.../contents/...?ref=c100577...`
for HazAT; and the installed
`@earendil-works/pi-coding-agent` 1.0.0 `docs/` and `dist/` for Pi's own API.
