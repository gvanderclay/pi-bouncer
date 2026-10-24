# How do permission and guard systems for coding agents gate the file tools (read, write, edit, grep, find, ls) as opposed to shell commands?

## Question

How do popular permission / guard systems gate an agent's file tools, as distinct from its shell? This feeds pi-bouncer's design for protecting Pi's built-in `read`, `write` and `edit` tools: which threats to cover, which tools to gate, how path rules are expressed and decided, and what the defaults are.

Scope (set by the requesting session): only guards that inspect and decide tool calls in-process (allow / ask / deny). Packages whose job is container, VM or OS sandboxing (Seatbelt, bubblewrap, landlock) are excluded; see "Excluded".

## Short answer

- **Everyone that gates file tools does it in the `tool_call` hook, from `input.path`.** Pi's `read`, `write`, `edit`, `grep`, `find`, `ls` all take a `path` field, so one extractor covers all six (gotgenes `README.md` "path surface"; aliou `extensions/guardrails/targets.ts:30-37`; pi-automode `docs/defaults.md:75-81`). Claude Code is the same idea with two rule kinds: `Read(...)` and `Edit(...)`.
- **Peers split the tools into only two directions: read vs write.** Claude Code collapses to `Read` and `Edit` (`Edit` covers Write and every other editing tool; `Read` covers Grep/Glob "best effort"). gotgenes has `path_read` / `path_write`. aliou has protection levels `noAccess` (all six tools plus bash) and `readOnly` (write, edit, bash). Heimdall gates only `read`. pi-verdict denies secret reads and grades writes by location.
- **Path rules are one of three shapes:** gitignore-style globs with anchors (Claude Code), wildcard globs with `~` expansion (gotgenes, pi-automode), or basename/regex lists (Heimdall, pi-verdict). The better ones match several spellings of the path: as typed, absolute, `~`-relative, and symlink-resolved. A deny matches if any spelling matches; an allow needs all of them to (Claude Code, gotgenes, pi-automode, pi-verdict).
- **Defaults are thin.** Only `.env`-style files are denied by default in aliou (home dirs are shipped but disabled) and Heimdall; pi-verdict ships a larger secret list as a hard deny on file tools; gotgenes ships no secret list on purpose and asks for everything unmatched; Claude Code ships no read denies but prompts for writes to a fixed list of "protected paths".
- **Self-protection is rare and strong when present.** pi-verdict and pi-automode hard-deny writes by the agent to the guard's own config and extension files, and nothing a config can turn off. Claude Code protects `.claude`, `.git`, shell rc files and similar from auto-approval. gotgenes and aliou have no stated self-protection (`unknown` for aliou beyond the absence found in a code search).
- **Shell is covered separately and imperfectly.** gotgenes and aliou parse bash and apply the same path rules to command arguments and redirects. Claude Code applies Read/Edit rules to recognised file commands (`cat`, `head`, `tail`, `sed`, `tee`) and redirects, and says plainly it does not cover `grep -r pattern .` or scripts. pi-verdict documents that `cat ~/.ssh/id_rsa` is *not* denied by its path floor (only `read` is). Heimdall's `env-protect` is read-tool only.

## Versions checked

Read 2026-10-22. Pi packages were shallow-cloned at default-branch HEAD; paths below are relative to the package root.

| Package | Version | Commit | Notes |
|---|---|---|---|
| @gotgenes/pi-permission-system | 41.0.0 | `41405de895fb53f802df89f8978456cd1dae397e` (`packages/pi-permission-system`) | 67.1K downloads/mo, top of the catalog's "permission" search |
| @aliou/pi-guardrails | 0.20.0 | `483d6d4b3918e7577a477b83400ac57888141e2a` | 6,553/mo |
| @casualjim/pi-heimdall (`env-protect` guard only) | 0.3.21 | `76c823d00002ef233e2ef8d2e232998b3e1b4ddb` (`packages/pi-heimdall`) | 2,716/mo |
| @trim21/personal-pi-extensions (`src/lib/write-guard.ts` only) | 0.1.0 | `058f238bad702fb193bbd02cd294d00fe8fd2c6c` | 21.6K/mo for the bundle ("guard" search) |
| pi-verdict | 0.15.0 | `3744feb2a4e1a0d785d3ca2dccb1f20758854815` | same commit as `pi-automode-peers.md` |
| @czottmann/pi-automode | 1.17.0 | `e69c02036b56ca9c6a42035623bab7d4ddf73ca5` | same commit as `pi-automode-peers.md` |
| ohmyjev | 0.12.0 | `78bb82cea03c0fb06fbf8892dc6d1840a7f02c11` | README only this time |
| Claude Code | docs as fetched 2026-10-22 | n/a | <https://code.claude.com/docs/en/permissions>, <https://code.claude.com/docs/en/permission-modes> (the `.md` forms of those pages) |
| Gemini CLI | docs on `main`, fetched 2026-10-22 | n/a | <https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/policy-engine.md> |

Catalog searches used: `permission`, `guard`, `sandbox`, `protect` on the pi.dev package catalog.

## Excluded (seen, not analysed)

- **pi-sandbox** (carderne, 0.7.2): OS sandbox for bash via sandbox-runtime; its read/write/edit prompts are an add-on.
- **pi-better-sandbox** / pi-better-harness (1aboveio, 0.12.1): Seatbelt/bubblewrap permission profiles for subagents.
- **@yuru7/pi-sandbox**, **pi-landstrip**, **@agimon-ai/doompi-sandbox**, **context-mode**: sandbox or container packages, by description.
- **Heimdall's `sandbox-guard`** (bash via `heimdall-sandbox`): sandbox half of a package whose `env-protect` guard is covered below.
- **OpenAI Codex CLI**: its file-edit approvals are tied to its OS sandbox's writable roots, so there is no separate in-process file rule to learn from. Dropped per the scope change. (Not re-fetched this session; see `child-permissions/codex.md` for what is already recorded.)
- **Cursor**: not covered; docs not read. `unknown`.
- **Not read** (found in the catalog, lower downloads): pi-cwd-guard, @yaosu/pi-path-guard, @firstpick/pi-extension-safety-guard, @lystran/pi-guard, pi-file-permissions, @vtstech/pi-security, pi-control.

## 1. Which tools are gated, and read vs write

| System | Tools gated | Read treated differently from write/edit? |
|---|---|---|
| gotgenes | `read write edit find grep ls`, bash, MCP, extension tools with `input.path` (`README.md` "path surface"; `docs/configuration.md:744-750`) | Yes. Optional direction keys `path_read`, `path_write`, `external_directory_read`, `external_directory_write`; a bare `path` key means both (`README.md`, directional paragraph). |
| aliou | per rule: `noAccess` blocks `read write edit bash grep find ls`; `readOnly` blocks `write edit bash` (`extensions/guardrails/rules.ts:38-42`). Separate `path-access` extension for outside-cwd paths. | Yes, via the two protection levels. `pathAccess.applyTo: "write"` gates only writes outside the workspace so reads of skills/config pass (`README.md` path-access section). |
| Heimdall `env-protect` | `read` only (`lib/guards/env-protect.ts:46`). README: host tools `read write edit grep find ls` are "not constrained" by its native sandbox. | n/a, only reads are checked. |
| trim21 write-guard | `write` and `edit` only (`src/lib/write-guard.ts` header) | n/a, write only. |
| pi-verdict | `read write edit grep find ls bash powershell` (`README.md:123`, `extensions/pi-verdict.ts:543`) | Yes. Reads: secret paths (S0) deny, system config gray, else allow. Writes: full grading (`pi-verdict.ts:543-575`). |
| pi-automode | `deniedPaths` covers `read write edit grep find ls` (`docs/defaults.md:75-81`); `protectedPaths` affects only `write`/`edit` | Yes. Read-only tools "remain locally allowed after permission and deterministic checks" (`docs/defaults.md`, `protectedPaths` section); every write/edit goes to the classifier by default. |
| ohmyjev | write/edit ("Write gate") and bash; reads of files are not gated (README table) | Yes (write only). |
| Claude Code | `Read(...)` rules and `Edit(...)` rules. `Edit` applies to all built-in editing tools; `Read` is best effort on Grep, Glob, `@file` mentions and IDE context (`permissions.md`, "What Read and Edit rules cover"). A `Read` deny also blocks Edit and Write on that path per the docs summary; `NotebookEdit` needs its own `Edit` deny. | Yes. Read-only tools need no prompt inside working directories; edits prompt unless `acceptEdits`. |
| Gemini CLI | any tool by name (`write_file`, `replace` shown as examples); no read/write split beyond naming tools (`policy-engine.md`, example at the "write_file / replace" TOML) | Only by choosing which tool names a rule lists. |

Claude Code also states that a path rule written for `Write`, `Glob` or `MultiEdit` is accepted but never matched; only `Read(...)` and `Edit(...)` path rules work (`permissions.md`, "What Read and Edit rules cover").

## 2. How protected paths are expressed

- **Claude Code**: gitignore syntax with four anchors: `//abs`, `~/home`, `/relative-to-settings-source`, `path` / `./path` relative to cwd (`permissions.md`, "How path patterns match"). A single leading `/` is *not* absolute, which the docs flag as a warning. A leading `!` in a deny list is a gitignore negation and carves exceptions out only of rules from the same settings file (`permissions.md`, negation paragraph). Symlinks: both the requested path and its resolved target are checked. Deny matches if either matches; allow needs both. Deny rules written through a symlinked directory also apply at the real location (macOS `/etc` -> `/private/etc`). Edit/Write on a path that is itself a symlink is refused, and the tool re-confirms the path still resolves to the approved location when it opens the file (`permissions.md`, "Symlinks").
- **gotgenes**: wildcard patterns (`*` greedy, crosses `/`) in `permission.path`, `permission.external_directory`, and per-tool maps; `~` and `$HOME` expansion in patterns; last matching rule wins within a map; relative inputs also match their cwd-absolute form; patterns match both the referenced path and its canonical symlink-resolved form (`docs/configuration.md:437`, `:744-760`, `:925-935`). It decodes `file://`, Unicode spaces, and macOS screenshot/curly-quote spellings the way Pi's own resolver does, so the rule matches the file Pi will actually open. It does not expand `$HOME` in tool paths because Pi does not (`docs/configuration.md:774`, `:1362`). Four layers combine most-restrictive-wins: `path`, `external_directory` (outside cwd), per-tool patterns, bash patterns (`docs/configuration.md:788-800`).
- **aliou**: glob patterns (name-based like `.env`, relative globs, `~/` or `/` anchored globs) or regex, grouped into named rules with `allowedPatterns` exceptions, `onlyIfExists` (default true), and `respectCwd` (default true: anchored patterns that contain the cwd don't neuter the workspace) (`src/shared/config/defaults.ts:21-31`; `extensions/guardrails/rules.ts:100-139`; `README.md`). Each target is matched against every spelling (cwd-relative, `~/...`, absolute) (`rules.ts:84-100`). It does **not** resolve symlinks; the source says "Does NOT resolve symlinks, this is a known limitation" (`src/core/paths/path.ts:35`).
- **pi-automode**: `deniedPaths` globs with `~`/`$HOME` expansion; matches the typed path and its symlink-resolved form (`docs/defaults.md:75-81`). `protectedPaths` are prefix names (`.git`, `.pi`, `.bashrc`, ...) matched case-insensitively against the project-relative path, and, for paths outside the project, against every path-component suffix, so `../other/.git/config` still matches (`extensions/auto-mode/paths.ts:185-232`). The nearest existing ancestor is resolved so a symlinked parent directory is respected even when the file doesn't exist yet (`paths.ts:196-199`).
- **pi-verdict**: `denyPaths` are plain paths (`~/.ssh/`, `~/.zshrc`, ...) (`README.md:94-122`). The built-in floor is regex lists S0 (secrets), S1 (system dirs), S2 (shell rc, crontab, LaunchAgents, systemd user), S3 (`.git/hooks|config|modules`, `.gitmodules`) tested against every canonical form of the path, lexical and real, so a symlink alias of `~/.ssh` or `.git/hooks` doesn't pass (`pi-verdict.ts:475-575`). In-cwd write is allowed only if every form is inside cwd.
- **Heimdall**: basename tests only (`.env`, `.envrc`, `.env.*`, `*.env`, `fnox*.toml`) with an example-suffix exemption (`.example`, `.sample`, `.template`, `.dist`, `.defaults`); strips a leading `@` from the path; no cwd, `~` or symlink handling (`lib/guards/env-protect.ts:14-37`).
- **trim21**: containment only: inside cwd or `/tmp` is auto-allowed, anywhere else needs approval (`src/lib/write-guard.ts:25-46`).

## 3. Defaults with no config

- **Claude Code**: reads inside working directories need no prompt; edits prompt in `default` mode and auto-accept in working directories in `acceptEdits`. A fixed list of protected writes (directories `.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`, `.claude`; files such as `.gitconfig`, shell rc files, `.envrc`, `.npmrc`, `.mcp.json`, `.claude.json`) is never auto-approved except in `bypassPermissions` (`permission-modes.md`, "Protected paths"). No default read deny: the docs tell you to add `Read(./.env)` yourself (`permissions.md`, "Read and Edit").
- **gotgenes**: omitting `"*"` means `ask` for everything (`docs/configuration.md:401`); no built-in secret list ("No built-in secret denylist", `README.md` non-goals). Outside-cwd access goes through `external_directory`, which asks when unset. Reads of Pi's own infrastructure (skills, extensions, docs, `settings.json`, `AGENTS.md`) are auto-allowed even outside cwd, while `auth.json`, `models.json`, `sessions/` and the permission system's own logs are not (`docs/configuration.md:937-950`).
- **aliou**: policy feature on with one rule enabled, `secret-files` (`.env`, `.env.local`, `.env.production`, `.env.prod`, `.dev.vars`; exceptions `.env.example` etc.), protection `noAccess`. Rules for `~/.ssh`, `~/.config/{gh,gcloud,op,sops}`, `~/.gnupg` ship but `enabled: false`. `features.pathAccess` (outside-cwd gate) defaults to **false** (`src/shared/config/defaults.ts:5-90`). A hit is a block, with a message telling the agent to ask the user.
- **Heimdall**: `env-protect` on by default (opt-out via `disabled`); a hit is a hard block with no prompt (`README.md` guard table, `env-protect.ts:57-63`).
- **pi-verdict**: a fresh install pre-fills `denyPaths` with `~/.ssh/`, `~/.gnupg`, `~/.mc`, `~/.kube`, shell rc files (`README.md:94-122`); built-in floor on (`builtinDenyFloor: true`).
- **pi-automode**: `deniedPaths` empty; `protectedPaths` default is the Claude-Code-like list above plus `.pi`; all writes/edits go to the classifier (`docs/defaults.md:48-75`).
- **trim21**: writes inside cwd or `/tmp` pass; outside prompts; headless rejects outside writes outright (`write-guard.ts` header).
- **Gemini CLI**: unknown for file defaults; the policy engine is rule-based with tiers (default, user, admin; workspace tier "currently disabled") and `ask_user` becomes `deny` in non-interactive mode (`policy-engine.md`).

## 4. Decision outcomes and judges

- **Claude Code**: allow / ask / deny, deny first, then ask, then allow; an allow cannot carve an exception out of a deny (`permissions.md`, rule evaluation). Protected-path writes: prompt in `default`/`acceptEdits`, classifier in `auto`, deny in `dontAsk` (`permission-modes.md`). `permissions.allow` entries cannot pre-approve protected-path writes. A write that resolves through a symlink to a protected path prompts instead of going to the classifier. A session-scoped "allow edits in `.claude` for this session" option exists on the prompt. File-edit approvals last until session end and are not saved to disk (`permissions.md:29`).
- **gotgenes**: allow / ask / deny, most restrictive wins across layers. A deny never prompts. Approvals can be "once" or "for the session" with a suggested pattern. Optional authorizer chain: a registered link (e.g. a model judge) is consulted on `ask`; the chain owner caps a link's `allow` on `path`/`external_directory` surfaces so a judge cannot loosen path policy (`README.md`, `authorizerChain` paragraph). Headless asks are denied (or forwarded from subagents).
- **aliou**: block only for policy rules; path-access can allow / block / ask with once / session / always grants, grants stored as explicit `{kind: file|directory, path}` entries (`README.md` path-access).
- **pi-verdict**: deny floor, then `denyPaths` terminal ask (non-interactive degrades to deny), then user allow/deny regexes, then the classifier for the gray zone. A `denyPaths` hit **never reaches the classifier**; the classifier is only told protected paths exist, with no path text (`docs/adr/0002-deny-paths-deterministic-ask.md`). Judge text for file tools is the action line (path or JSON args) capped at 1000 chars (`pi-automode-peers.md` section 2).
- **pi-automode**: deterministic `deniedPaths`/hard-deny layers run before the classifier; the classifier receives the **complete** tool input, including the content of a `write` (`pi-automode-peers.md` section 2). Protected-path writes cannot use the `permissions.allow` tier or the inside-cwd tier; they always reach the classifier (`extensions/auto-mode/extension.ts:660-730`).
- **ohmyjev**: the write gate judge gets the path and new content, 16,000 chars (README line 305); writes outside the repo are blocked **before anything is sent** to the judge; failure of the judge is fail-open for MCP (see `pi-automode-peers.md`).
- **trim21**: the human approval dialog shows a unified diff of the pending change (preview capped at 100 lines), rendered from the exact old/new content that will be written; after approval it re-hashes the file and refuses to write if the file changed while the dialog was open (`write-guard.ts:50-107`).
- **erichll / mzwing**: judge only what gotgenes escalates to `ask` (see `pi-automode-peers.md`).

## 5. Self-protection of the guard's own config

- **pi-verdict**: yes, a layer no config can turn off. Writes by the agent to `pi-verdict.json` and to the installed extension copy are hard-denied; reads pass. Reasoning: a guard its subject can reconfigure cannot be trusted, and a hard deny is equivalent to "user-editable only" since the user's editor never passes through the gate. A tamper check snapshots the files at `session_start` and re-checks before every verdict (extension copy auto-restored and session fail-closed; config change asks keep/restore; headless restores). ADR-0001 explicitly rejects protecting all of `~/.pi/agent/` as overreach, because installing skills and editing MCP config is legitimate agent work (`README.md:162-168`; `docs/adr/0001-self-protection-layer.md`, in Chinese).
- **pi-automode**: yes. `isSafetyControlPath` matches `~/.pi/agent/settings.json`, `~/.pi/agent/extensions/**`, `.../auto-mode.json`, and paths containing `pi-automode`; a `write`/`edit` or a bash redirect to them is hard-denied, as are writes to shell profiles and `~/.ssh/authorized_keys` (`extensions/auto-mode/paths.ts:234-270`; `hard-deny.ts:395-425`). Its `protectedPaths` default also includes `.pi`.
- **Claude Code**: `.claude` (project and `~/.claude`) and `.claude.json`, `.mcp.json` are protected paths, and an allow rule cannot pre-approve them. Settings files that are symlinks protect the link target too (`permission-modes.md`, "Protected paths"). It is a prompt, not a deny, in default mode.
- **gotgenes**: no self-protection statement found; the guard's own *logs* are excluded from the read auto-allow (`docs/configuration.md:949`), and project config loads only after Pi project trust so an untrusted repo cannot loosen global policy (`README.md`, 22.0.0 note). Whether `write` to `~/.pi/agent/extensions/pi-permission-system/config.json` is blocked relies on the user's own rules and the default `ask` for outside-cwd; `unknown` beyond that.
- **aliou, Heimdall, trim21**: nothing found in code or docs (search for `guardrails.json` in non-test source found only the writer paths). `unknown` is stricter than "no"; I did not run them.

## 6. Interaction with shell

- **gotgenes**: same path rules apply to bash. It parses the command and extracts path-candidate tokens (dot-files, relative and absolute paths, option values like `--file=/x`, redirect targets, and a bare filename if a file of that name exists), resolves them against the effective directory after literal `cd`, and takes the most restrictive result. Read direction is inferred: `<` reads, `>` writes, and 19 fixed read-only commands (`cat`, `grep`, `ls`, `find`...) prove a read; an unrecognised command consults both directions. Commands it cannot parse fully, and wrappers like `bash -c`, `sudo`, `xargs`, `find -exec`, prompt (`README.md`, "Fails closed" and "A read grant reaches bash"; `docs/configuration.md:770-785`).
- **aliou**: same policy rules apply to bash via a shell-AST walker (`extensions/guardrails/targets.ts:40-140`), including `$(...)`, backticks and process substitution. Commands with no file operands (`echo`, `printf`) are treated as data. Documented holes: heredoc bodies, `${x:-$(...)}` operands, extglob (`README.md`, "Shell substitution checks"). A path with an unexpanded `$VAR` is treated as unresolved and keeps full enforcement (`rules.ts:104-124`).
- **Claude Code**: Read/Edit denies apply to file commands it recognises (`cat head tail sed tee`) and to redirect targets; they do not apply to `grep -r pattern .` or to scripts that open files themselves. For those it points to the OS sandbox or a `PreToolUse` hook (`permissions.md:262`, `:308-313`, `:356`).
- **pi-verdict**: the path floor is file tools only. Its own README lists as a limit that `cat ~/.ssh/id_rsa` goes to the classifier, while `read ~/.ssh/id_rsa` is denied (`README.md:245`). `denyPaths` extraction on bash is "honestly obfuscatable" and the ADR rejected a deterministic bash path layer (ADR-0002, "Considered alternatives").
- **pi-automode**: `deniedPaths` is file tools only; "the classifier continues to govern `bash` access" (`docs/defaults.md:79`). Hard-denies do parse bash redirect targets for profile/safety-control paths (`hard-deny.ts:232-246`).
- **Heimdall**: `env-protect` is read tool only; the bypass is named in its own block message (`cat`, `head`, `tail`, `xxd`, `base64`).

## 7. Pitfalls and bypasses visible in the sources

- **Lexical-only matching is bypassed by symlinks and `..`.** aliou documents it as a known limitation; Heimdall and trim21 do not resolve anything. Claude Code, gotgenes, pi-automode and pi-verdict resolve and match both forms, and pi-verdict adds the rule "every form must be inside cwd" for allows.
- **Allow must be stricter than deny on symlinks.** Claude Code: deny if either form matches, allow only if both match (`permissions.md`, "How rules match a symlinked path").
- **Non-existent targets.** A write creating a new file under a symlinked directory: pi-automode resolves the nearest existing ancestor (`paths.ts:196-199`); Claude Code refuses when symlinks don't resolve.
- **Check-then-use races.** Claude Code re-confirms the resolved path when the tool opens the file. trim21 re-hashes after approval. gotgenes and aliou do not mention either (`unknown`).
- **Matching what Pi will actually open.** Pi's resolver normalises `file://`, Unicode spaces and macOS name variants; gotgenes replicates that, and Heimdall strips only a leading `@`. A rule keyed to the raw string can miss the real file.
- **Only `read` gated leaves grep/find/ls open.** Heimdall gates only `read`; `grep -r`, `find` and `ls` of a secret directory pass. pi-automode and pi-verdict compare the whole *search scope*: an omitted `path` (Pi's default: current directory) or a parent of a protected path triggers the protection (`pi-verdict README.md:122`; `pi-automode extension.ts:660-668`).
- **Rule shape traps.** Claude Code `/path` is not absolute and `Write(...)` path rules silently never match. pi-automode `protectedPaths` as prefixes match any path component suffix outside the project, which can be broader than intended.
- **Home-anchored rules neutering the workspace.** aliou's `respectCwd` exists because an anchored `~/work/**` rule would block the whole project when the session starts inside it (`README.md`, guardrails section).
- **Bash cannot be fully covered by path rules** (all of Claude Code, gotgenes, aliou, pi-verdict say so in some form). gotgenes and pi-automode state the guard is a decision layer, not isolation (`docs/troubleshooting.md` threat model).
- **Judge exposure.** A judge asked about a secret path leaks it into the model's context if it is shown the file path/content. pi-verdict sends no protected path text to the classifier; ohmyjev blocks outside-repo writes before sending; pi-automode sends full write content to the classifier.
- **Self-edit via approval.** Claude Code rule `allow` cannot approve protected paths; pi-verdict reasons that an `ask` on its own config relies on the user catching an injection, so it uses hard deny.

## Ideas worth borrowing for pi-bouncer

1. **One `path` extractor for all six Pi tools, with a read/write direction.** Source: gotgenes (`path_read`/`path_write`), aliou (`noAccess` vs `readOnly`), Claude Code (`Read` vs `Edit`). This fits bouncer's named rules at deny/ask/off: a rule is read-secret, write-outside-project or write-self, each with its own level.
2. **Match several spellings, resolve symlinks, and make allow stricter than deny.** Source: Claude Code symlink section, gotgenes dual-form, pi-verdict "every form inside cwd". Also resolve the nearest existing ancestor for new files (pi-automode `paths.ts:196`), and normalise the way Pi's own resolver does (gotgenes), including a leading `@` (Heimdall).
3. **A short, fixed "protected paths" list for writes, prompted rather than denied, in a table the user can read.** Source: Claude Code `permission-modes.md` list; pi-automode `DEFAULT_PROTECTED_PATHS` (same list plus `.pi`). Config `allow` entries must not pre-approve them. This pairs naturally with the existing `protect` key.
4. **Default hard-deny a small set of secret reads, ask for the rest.** Source: pi-verdict S0 (`.ssh`, `.aws`, `.gnupg`, `.env*`, `.netrc`, `.npmrc`, `id_rsa*`, `*.pem`, `.kube`, `.docker/config.json`, Pi's `auth.json`), aliou (`.env` family with `.example` exceptions via `allowedPatterns`), Heimdall's example-suffix list. Offer user-declared paths as `ask`, not `deny`, because the user is the right person to grant the exception (pi-verdict ADR-0002).
5. **Self-protection that no config can turn off.** Source: pi-verdict ADR-0001 and pi-automode `isSafetyControlPath`. Hard-deny agent writes to bouncer's own config (global and project) and installed extension files; reads pass. Cover bash redirects as well (pi-automode `hard-deny.ts:232-246`). Do not extend it to all of `~/.pi/agent/`; pi-verdict's ADR rejects that as breaking legitimate skill and MCP edits. This matches the existing rule in AGENTS.md that project files never loosen the always-deny set.
6. **Gate `grep`, `find` and `ls` by search scope.** Source: pi-verdict, pi-automode. An omitted `path` means cwd, and a scope that contains a protected path should trigger the rule.
7. **Show the human the change, and verify it is unchanged at write time.** Source: trim21 (diff preview from the exact old/new content; re-hash after approval).
8. **Keep a judge from loosening path rules.** Source: gotgenes (a link's `allow` on path surfaces is capped), pi-verdict (a `denyPaths` hit never reaches the judge; no path text sent), ohmyjev (outside-repo writes blocked before the judge). For auto mode: deterministic path denials first, judge only the gray zone.
9. **Say which spellings are not covered.** Source: gotgenes and aliou list parser holes in their README; pi-verdict lists "cat ~/.ssh/id_rsa not denied". If bouncer applies the same path rules to bash, its existing bash rules already own that; state the overlap.
10. **A `respectCwd`-style escape for home-anchored rules.** Source: aliou. A `~/projects/**` protect entry should not block the project the session lives in.
11. **Headless behaviour: ask becomes deny.** Source: pi-verdict, gotgenes, Gemini CLI (`ask_user` is `deny` non-interactively), trim21.

## Things to avoid

- **Basename-only or lexical-only path tests** (Heimdall `env-protect`, aliou's no-symlink limitation, trim21's containment): they are bypassed by symlinks, `..` and different spellings.
- **Gating only `read`** (Heimdall): leaves `grep`, `find` and `ls` as a way to read the same secrets.
- **Anchor syntax where `/path` looks absolute but is not** (Claude Code) and rule keys that are accepted but never match (Claude Code `Write(...)` path rules). Validate the config and reject unknown keys.
- **An `ask` on the guard's own config** (rejected by pi-verdict ADR-0001): approval fatigue makes it the first thing a prompt injection asks for.
- **Protecting the whole `~/.pi/agent/` tree** (rejected by pi-verdict ADR-0001): breaks skill installs and MCP edits.
- **Sending protected paths or full file content to a judge without need** (pi-automode sends complete write content; pi-verdict sends none): decide the judge's input deliberately.
- **Guard error means allow.** gotgenes fails closed on an internal gate error and on bash it cannot parse; ohmyjev's judge failure is fail-open for MCP.
- **Letting project config loosen policy before trust is established** (gotgenes loads project config only for a trusted project).
- **A shipped-but-disabled secret list** (aliou ships `~/.ssh`, `~/.gnupg` rules with `enabled: false`; the outside-cwd `pathAccess` feature is off too): it looks protective in the settings UI but does nothing out of the box.

## Unsettled (`unknown`)

- Cursor and Codex CLI file-approval behaviour: not read in this pass.
- Whether aliou, Heimdall, trim21 and gotgenes block agent writes to their own config: no code found, not tested by running them.
- Whether gotgenes or aliou re-check the resolved path at open time (the check-then-use race): not found.
- What the judge sees for a `write` or `edit` in erichll's and mzwing's packages: depends on gotgenes' `toolInputPreview`, not read (`pi-automode-peers.md` section 2).
- pi-better-sandbox and pi-sandbox contained file-tool guards of their own; excluded by scope and not analysed.
