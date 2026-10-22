# When can recursive deletion run without an ask?

## Question and short answer

What existing tools, libraries, and filesystem techniques can establish that `rm -rf <dir>` will not destroy data that exists nowhere else, particularly for an AI coding agent?

**There is no trustworthy general-purpose “regenerable” bit in ordinary file metadata.** The useful distinction is between evidence that another name or verified copy exists **now**, and making deletion recoverable by retaining a copy first. Hardlink accounting is a useful, narrowly justified addition to the bouncer's existing exemption, but is not a general solution for package installations or archives: pnpm can use independent copy-on-write clones, and an archive's dates do not establish that the archive still exists. Reversible removal is the broadest practical fallback; isolated copy-on-write workspaces are the stronger but more expensive design. These are deductions from the link semantics, package importer, archive, and snapshot sources below, not claims of a universal safety proof. [S1–S4, S12–S19]

Two corrections to the motivating examples matter:

- **npm deliberately gives packed archives a 1985 timestamp, but current pacote extracts packages with `noMtime: true`.** Therefore “npm install normally creates 1985-dated files” does not follow from npm's packing behavior. The exact versions and code are below. [S2]
- **pnpm's conceptual “every file is a hard link” documentation is not an adequate description of every real installation.** Its importer supports clones and copies; the inspected pnpm 11 importer tries cloning first, including a native macOS reflink implementation. Hardlink-only recognition will miss those installations. [S3]

## Date, scope, versions, and evidence standard

Research date: **2026-10-22 UTC**, from `date -u +%F` → `2026-10-22`. Repository baseline: **`55a92e8170b3c27cc1afaf5443ff22e0f061bfca`**, from `git rev-parse HEAD`. Only this report is changed; implementation and tests are not changed.

Pinned source checks:

- npm CLI **12.2.1**, commit `ae98c62586b6fea44114f72e249e246a2981de70`; its dependency is `pacote: ^22.0.0`. Pacote **22.0.1**, commit `453a0adac3592e5f93c8f782fb1b1b320ac95009`. Versions were read from their pinned `package.json` files. [S2]
- pnpm commit **`9c11ea9948f08243dd489ae0a8e5146f5e3939e7`**, specifically the retained **pnpm 11 TypeScript importer**, not an assumption that its current Rust importer is identical. [S3]
- Cline commit **`c441897f11f658f978a00678f045670c1ab2b60d`**; OpenHands documentation commit **`cdeae6147fd6ca9bab1df9d62511850c917d1dff`**. [S9, S11]
- trash-cli commit **`bfb1595b8520fc7b6eba905d81ef4c228d705aba`**; rip commit **`11f0b8d018975f78d922038efc7f60bf9fffafd0`**; gomi commit **`1bf1f287880d21cdb305f99c9b22674a5b4f142f`**. [S13–S15]
- Linux documentation **6.18**, libfuse **3.17.1**, and GNU tar manual **1.35.90**. These versioned references are intentionally older than the last month; they establish API semantics, not recent product defaults. [S4, S18, S20, S25]

Unversioned official documentation was fetched on the research date using `ketch scrape <URL> --max-chars <limit>`; publication date and exact installed product version are **unknown** unless stated. Apple APFS/FSEvents archives and its Endpoint Security WWDC 2020 sample are explicitly older sources. Cursor's implementation article is dated **2026-02-18**, and Time Machine's page **2026-07-06**; both are older than the last month. Search summaries were used for discovery, not as evidence where their underlying text could not be confirmed. This is a targeted documentation/source survey, not a full security audit or empirical benchmark.

## 1. What the bouncer currently establishes

At the baseline commit, `src/agent-made.ts:35–43` supplies the two-second slack and 10,000-item limit. `src/agent-made-check.ts:106–130` uses `lstat`, checks modification and available birth times, walks directories without following interior symlinks, and fails when the shared item budget is exhausted. `docs/behaviour.md:93–103` explicitly says the check cannot identify who supplied a file and does not cover the race between checking and running `rm`. Thus the current exemption is already a heuristic against accidental deletion, not proof that every deleted byte has another copy. [S1]

An old timestamp is a reasonable reason to ask, but a recent timestamp is not proof of non-uniqueness. The existing documented counterexample is a new file supplied by a user or another process. Relaxing old-date rejection for a file with an external hardlink can be more strongly justified than relaxing it because its parent is named `node_modules`. [S1, S12]

## 2. How other coding agents handle deletion

The inspected sources describe **permissions, execution boundaries, and recovery**, not filesystem-wide uniqueness tests. No inspected source establishes an exemption equivalent to “agent-created directory plus proof no unique data is inside.” Whether some uninspected implementation does so is **unknown**; absence from documentation is not proof of absence.

| System | Primary-source behavior | Relevance and limitation |
| --- | --- | --- |
| Claude Code | Its Bash sandbox limits writable paths and network access; it can run commands within the sandbox without per-command approval. Direct file tools and some other processes run outside that sandbox. Checkpoints track its file-editing tools, **not Bash `rm`, `mv`, or `cp`**. [S5, S6] | A writable project boundary is not a promise that project data survives. Its advertised rewind feature is specifically not shell-delete recovery. |
| OpenAI Codex CLI | Its official approvals page distinguishes OS-enforced sandbox scope from approval policy. The documented Auto preset permits edits and commands in the workspace automatically; outside-workspace writes require approval. [S7] | This is authorization by location, not evidence another copy exists. A shell delete inside a writable workspace remains possible by this model. |
| Gemini CLI | Supports macOS Seatbelt and Docker/Podman isolation. The default macOS profile confines writes to the project; Docker mounts the current working directory at the same absolute path. [S8] | Isolation contains the blast radius; a writable bind mount still exposes the original project data. [S17] |
| Cursor | Its first-party February 2026 implementation article describes macOS Seatbelt, Linux Landlock/seccomp, and Linux overlays used to enforce ignored-file restrictions. [S10] | This establishes access control, **not** a retained undo snapshot. The older checkpoint URL redirected to a documentation landing page during this research, so current shell-delete checkpoint coverage is **unknown**; do not rely on search snippets claiming it. |
| Aider | Automatically commits its edits, separates preexisting dirty changes before editing, and supports `/undo`. Its docs explicitly recommend backups if Git integration is disabled. [S16] | This is Git recovery for captured edits. The cited page does not establish that arbitrary shell deletes, ignored files, or all untracked files are captured: **unknown** for that broader claim. |
| Cline | Pinned documentation says a separate shadow Git repository commits project state after tool use, including commands, and includes files not tracked by the project's Git. It warns of storage/performance costs for large repositories. [S9] | A relevant recovery pattern. “Not tracked by project Git” does not establish coverage of every ignored, oversized, external, or special file. Those exclusions and the exact current pre-delete capture behavior were not audited: **unknown**. Do not adopt the page's “nearly zero” mistake-cost statement as a guarantee. |
| Roo Code | Official checkpoint documentation describes a shadow Git repository, a task-start snapshot, and snapshots before file modifications; it explicitly says snapshots are **not automatically created before command execution**. [S21] | Task-start recovery can help, but is not necessarily a fresh backup immediately before `rm`; later user data may not be captured. |
| OpenHands | Pinned runtime docs describe Docker execution and optional bind-mount overlays: `:ro,overlay` plus `SANDBOX_VOLUME_OVERLAYS` creates per-container upper/work directories. [S11] | This is a concrete existing implementation of copy-on-write workspaces rather than deciding that original files are disposable. Its runtime page is legacy architecture documentation; applicability to every current sandbox configuration is **unknown**. |
| Goose | Official docs offer autonomous, manual, smart-approval, and chat-only modes. They explicitly describe read/write classification as **best effort and interpreted by the model provider**, with `rm`, `cp`, and `mv` as write examples. [S22] | A semantic risk judgment, not an on-disk uniqueness test. Autonomous mode can delete without approval. |
| Amp | Its first-party permissions note gives an example asking for Bash commands matching `*rm*rf*`, `*find*exec*`, and `*find*delete*`, then allowing other tools. It argues for Git/backups to lower recovery cost. [S23] | Pattern-based review and recovery; the example is not parsing or proving what recursive deletion will destroy. |

**Transferable lesson:** an execution boundary protects files the agent cannot write, while a verified pre-delete copy protects files it can write. The two protections are complementary, not interchangeable. Docker explicitly warns that bind mounts are writable by default and container processes can delete important host files. [S17]

## 3. Existing deletion and recovery tools

### Protected-path wrappers are not uniqueness checkers

The established **safe-rm by François Marier** wraps `rm` and excludes configured important paths. Its manual documents limitations: protecting `/usr/lib` does not protect against `cd /usr/lib; rm -f *`, and protecting `/usr/lib/*` alone does not protect against `rm -rf /usr/lib`. It neither checks duplicates nor makes approved deletion recoverable. This is not the same project as newer similarly named trash wrappers. [S24]

### Trash tools retain the data instead of proving it replaceable

- **andreafrancia/trash-cli** implements the FreeDesktop trash model, recording original path/deletion metadata and supplying list/restore/empty commands. It is useful primarily for Linux desktop-style trash semantics. [S13, S26]
- **sindresorhus/trash** is a Node library with macOS/Linux/Windows support; its README says macOS uses `macos-trash` and Linux follows XDG. Importantly, its current README explicitly says the **Linux implementation is not very good and not maintained**. Its globbing and silent handling of nonexistent paths also differ from a literal `rm`-operand contract. This is a candidate to evaluate, not a recommendation to add blindly. [S27]
- **rip / rm-improved** retains removed objects in a graveyard and offers `--unbury`; the README's default is **`/tmp/graveyard-$USER`**, with `XDG_DATA_HOME`/`GRAVEYARD` overrides. A `/tmp` graveyard is not a durable recovery policy and can disappear or consume RAM on a tmpfs. Its `--decompose` permanently deletes the graveyard. [S14]
- **gomi** documents XDG-compatible trash, a restore browser, and Linux/macOS/Windows support. This is another usable reversible-removal command, not proof of uniqueness. [S15]

For the bouncer, explicitly steering a blocked delete to a chosen trash command is simpler to reason about than silently rewriting a shell command: `rm` and trash differ in flags, storage requirements, error behavior, and restore conventions. The bouncer already documents such steering when a configured/discovered trash program exists. [S1, S13–S15, S27]

**Safety condition for adopting reversible removal:** do not fall back to permanent `rm` if retaining the data fails; confirm successful retention before reporting success; protect the retained copy from agent deletion if prompt-injection resistance is required; define retention, capacity, and restore behavior. These are proposed requirements, deduced from the recovery mechanism, not guarantees all the listed tools make. A same-user trash directory is reversible against mistakes but not protected against an adversarial command deleting the trash as well. [S12–S15, S26]

### Snapshots and isolated workspaces

| Technique | What it actually preserves | Fit and caveats |
| --- | --- | --- |
| Git commit / shadow Git | Contents represented in the committed tree. Aider, Cline, and Roo supply working examples. [S9, S16, S21] | Cross-platform and familiar, but do not infer whole-tree coverage from “Git-backed.” Any proposed exemption must confirm every target file is captured and unchanged relative to that snapshot. File metadata/special-file fidelity requires a separate design. |
| APFS snapshot | APFS exposes snapshots and copy-on-write filesystem features. [S19] | macOS-specific native integration; snapshot creation, coverage, retention, and restore must be verified. Native helper/privilege requirements for a portable bouncer implementation are **unknown** in this research. |
| Time Machine local snapshot | Apple says local snapshots are approximately hourly, retained for 24 hours, and automatically deleted as they age or space is needed. [S28] | Existing local snapshots are **not** a sufficient pre-delete guarantee: a newly moved-in file may postdate the snapshot and retention is not under the bouncer's control. |
| btrfs snapshot | A subvolume snapshot initially shares extents but modifications do not affect the original. Snapshots are **not recursive across nested subvolumes**, which appear as empty stubs. [S18] | Good Linux-native basis where supported; must enumerate mount/subvolume boundaries. Snapshotting the parent alone does not cover all recursively deleted descendants. |
| ZFS snapshot | Dataset snapshots are atomic; `-r` snapshots descendant datasets at the same time. [S29] | Strong retention basis on deployments already using ZFS. Not a generic Linux filesystem feature or stock-macOS answer. Dataset mapping and snapshot permissions still need integration. |
| OverlayFS workspace | Lower-layer deletions become upper-layer whiteouts rather than changing the lower filesystem. OpenHands documents an agent integration. [S11, S20] | Strong isolation if the base is immutable to the agent, other mounts are not writable, and changes are explicitly exported. **New unique upper-layer data can still be deleted**; retaining only the original lower layer does not preserve everything created during the task. |
| Disposable copied/cloned workspace | APFS clones and btrfs snapshots make independent writable views practical. [S18, S19] | Preserves the original baseline if the original is inaccessible, but requires an explicit hand-back/review workflow. It changes the execution environment rather than merely adding a bouncer check. |

Snapshots and clones need not be separate physical storage to protect against a logical `rm`; they are not substitutes for independent backups against disk loss. btrfs explicitly distinguishes its snapshots from backups for this reason. [S18]

## 4. Are package-manager or origin signals trustworthy?

### npm: packing dates do not establish installation dates

At pacote 22.0.1, `lib/util/tar-create-options.js` explicitly sets:

```js
mtime: new Date('1985-10-26T08:15:00.000Z')
```

The comment says this is a 1980s date for zip's benefit, because zip is confused by Unix epoch zero. However, the **same pinned source** calls `tar.x(this.#tarxOptions(...))` and returns **`noMtime: true`** in the extraction options (`lib/fetcher.js:388–430`). npm CLI 12.2.1 declares a compatible pacote dependency. Therefore the general claim that current ordinary npm package extraction restores that 1985 archive mtime is contradicted by the extraction path. Install scripts, alternative extractors, local dependencies, and old versions can behave differently; their resulting file dates are **unknown** here. No live `npm install` benchmark was performed. [S2]

This distinction is actionable before changing policy: measure actual date and item-limit failures separately. npm installations may still exceed the existing walk budget even when no files fail the date check. The reported ~85,000-file example is task context, not independently measured in this report. [S1]

### pnpm: inspect actual links, not the package-manager name

The pnpm conceptual layout page says every package file is a hardlink to the content-addressed store. Its pinned pnpm 11 importer is more precise: `PackageImportMethod` accepts `auto`, `hardlink`, `copy`, `clone`, and `clone-or-copy`; `auto` probes cloning first, then hardlinking, and can fall back to copying. On macOS it uses native reflink support. Even the hardlink path has cases that copy individual files instead. Consequently, “pnpm installed it” does not establish `nlink > 1`, including on APFS. The current pnpm 12 Rust implementation was not fully audited; its exact behavior remains **unknown** here. [S3]

A `.modules.yaml` records installation state, not a signed statement that every descendant has a surviving copy. The pinned modules-yaml implementation calls that filename out explicitly. npm likewise documents `.package-lock.json` as a performance cache and explicitly warns that modifying a nested file can leave package-directory mtimes unchanged. Neither marker warrants bypassing a recursive content check. [S3, S30]

### Archives, hashes, xattrs, and “origin”

- GNU tar normally restores archive modification times; `--touch` changes that behavior. Thus old dates are expected for fresh extraction. Apple's pinned distribution of the Info-ZIP 6.0 manual describes `-DD` as suppressing file and directory timestamp restoration, confirming the normal restoration behavior. This is older version-specific evidence, not a guarantee for every unzip implementation. [S4, S31]
- If a retained archive or content-addressed store object can be matched against **every target file's current contents**, that is evidence of another copy. A package name, integrity field for the original tarball, or presence of a cache directory alone does not establish that installed files have not been patched or supplemented. npm's documented hidden-lockfile limitation is a concrete example. Full verification requires trusted retained objects plus complete tree coverage, including extra files. This is a proposed technique, not an off-the-shelf verified-delete library found by this survey. [S30]
- An arbitrary `user.*` xattr is writable according to file permissions on Linux. A prompt-injected agent with the same file permissions can forge or remove such a marker. Linux has privileged `trusted.*` and security namespaces, but employing them requires a separate trusted writer/enforcement design. [S32]
- `com.apple.quarantine` is not evidence of a surviving download or regenerable content. A particularly concrete counterexample is pnpm's pinned importer: it documents quarantine propagation through copying/reflinking, shared xattrs for hardlinks, and explicitly removes quarantine from selected imported native binaries. Presence and absence are both insufficient provenance evidence. [S3]

**Trust model:** a marker written by the same principal that wants permission to delete is not an authorization proof. Even a genuine “created by the agent” record establishes origin, not the user's lack of interest in retaining the result. Existing recent-date logic, package markers, names, and command-history labels should be described as guard rails; a hostile process needs an enforced boundary or a protected retained copy. [S1, S5, S17, S32]

## 5. Hardlink accounting: useful theorem, strict assumptions

### The narrowly valid inference

For a **regular file** on a filesystem with trustworthy POSIX-style identity/link counts, let:

- `i = (st_dev, st_ino)` identify its inode;
- `D(i)` be the number of **distinct directory entries for that inode that this entire command will unlink**, across all operands, after accounting for overlap and aliases;
- `L(i) = st_nlink` be the actual link count.

Then **`L(i) > D(i)` means at least one link remains after this command**—provided neither the namespace nor metadata changes between observation and deletion. This follows from `unlink` removing a name and reclaiming the file only after the final link and final open reference disappear. It is not necessary to search the entire filesystem to establish existence of an external link. [S12]

This proves preservation of the inode/content through another link at that moment, **not** that the other path is known, accessible to the user, permanent, or protected against later removal. Open descriptors are not a durable alternative: after the final name is gone they keep data alive only until they close. [S12]

For the bouncer, use this as a reason an **old regular file** need not fail solely on age, while preserving its directory-creation/path rules and continuing to ask on unsupported cases. Directory metadata, symlink text, special files, and non-hardlinked old files are separate cases; this theorem does not license skipping them. Preserving every filename, empty directory, permission, ACL, and xattr is also a stronger requirement than retaining file bytes. [S1, S12, S32]

### Pitfalls that matter in implementation

1. **Count across all operands, not one tree.** Two hardlinks both removed by the same command are not an external copy. Include a literal individual-file operand as well as recursive operands. Descendant/ancestor operands and repeated operands must not cause dangerous undercounting. This is a direct consequence of the definition of `D(i)`. [S12]
2. **Do not count symlink aliases as hardlinks or traverse them as extra data.** Unlinking a symlink removes the symlink, not its target. Directory link counts are not counts of interchangeable backup directories. The existing walk uses `lstat`, which is the correct starting point. [S1, S12]
3. **Identity must include device and preserve full integer precision.** On overlay filesystems both `st_dev` and `st_ino` may vary, and inode numbers are only unique in the documented scope. Node offers bigint stats to avoid precision loss in large identifiers. [S20, S33]
4. **APFS clones and other reflinks are not hardlinks.** They preserve an independently writable copy by sharing blocks, not by adding a name to the same file. `nlink == 1` cannot be read as “unique bytes.” Conversely, shared extents are not a practical reference to a known surviving pathname. This is a safe false negative for hardlink recognition, not permission to infer backup from allocated blocks. [S18, S19]
5. **FUSE metadata is supplied by the userspace filesystem.** libfuse 3.17.1 even documents that a filesystem using `use_ino` need not guarantee uniqueness. A `(dev, ino)` grouping algorithm must not assume an arbitrary FUSE implementation gives trustworthy POSIX identity. Exact `st_nlink` correctness depends on the implementation; a universal guarantee is **unknown**. [S25]
6. **Network filesystems have additional identity and freshness assumptions.** Linux CIFS documents that server inode IDs may not be unique when a share exports multiple server-side mounts; client-generated inode IDs have different behavior. That is enough to reject a universal identity/count proof across arbitrary SMB mounts. A primary-source universal guarantee of accurate live `st_nlink` for NFS/SMB was **not established**. Do not claim all network link counts are wrong either. [S34]
7. **OverlayFS needs separate treatment.** Its versioned docs describe changing identity, copy-up, and broken hardlink relationships when indexing is disabled. Lower-layer names may be outside the agent's merged namespace. Its whiteout semantics are useful for recovery, but naive host-filesystem inode reasoning should not be transplanted into it. [S20]
8. **Mount aliases and races can invalidate the counted deletion set.** The proposed safe scope is a stable local tree with no nested mounts/aliases, failing closed when that cannot be established. A shell-level preflight cannot atomically reserve an external hardlink; another process can unlink it or replace traversed paths after the scan. The repository already acknowledges its corresponding race. A second `stat` narrows but does not eliminate that race. [S1, S12, S20]
9. **A surviving hardlink is not an independent immutable backup.** Writes through either name affect the same file; retaining a hardlink protects against unlinking one name, not content corruption through another. Link-based safety should be claimed only for this deletion operation. The pnpm importer supports independent clone/copy alternatives precisely as distinct operations. [S3, S12]

Recommendation within this approach: restrict any initial implementation to explicitly supported local filesystems on macOS/Linux, validate counts as positive integers, reject metadata/errors/unsupported mounts, and retain a complete all-operand walk. These are conservative proposed constraints, not a claim that filesystem type detection alone authenticates a filesystem. A giant tree still needs O(entries) discovery; a larger/time-bounded walk improves coverage but provides no new evidence of replaceability. [S1, S12, S20, S25]

## 6. Can auditing or provenance tracking avoid scanning?

| Mechanism | What primary sources establish | What remains missing for safe deletion |
| --- | --- | --- |
| inotify | Events can be used to cache filesystem state, but the manual warns about races/inconsistent caches; overflow drops events and requires recovery. [S35] | A loss-free history of outside-tree moves/copies and surviving source names; watching only the destination cannot establish those. |
| fanotify | Provides notifications and some permission interception; create/delete/move events were added in Linux 5.1. Its queue also has overflow handling. [S36] | Notifications are not a retained copy or a universal synchronous deny hook for every unlink. Full-system provenance/enforcement remains a separate service. |
| FSEvents | Apple's archived guide explicitly says events are **advisory rather than definitive**; coalesced or dropped events require rescanning. [S37] | A provenance certificate or a reliable no-scan ownership proof. |
| eBPF / BPF LSM | Linux 6.18 documents privileged instrumentation of LSM hooks for audit and mandatory access control. [S38] | Recording “process A wrote this file” still does not prove whether the source survives or whether the user values the output; implementing that policy is substantial Linux-only infrastructure. |
| macOS Endpoint Security | Apple's sample supports post-event notification or authorization of in-flight events; distribution requires an entitlement, signing, installation approval, and Full Disk Access. [S39] | Far beyond a portable TypeScript extension. Whether a particular unlink-authorization design can provide all required retention semantics is **unknown** here. |
| CamFlow | First-party project docs describe a Linux Security Module for whole-system provenance, with kernel/userspace installation and a limited tested platform set. [S40] | This is genuine existing provenance infrastructure, not a drop-in “is it safe to delete?” predicate, and has no macOS equivalent in that project. |

A trusted service could observe creation/import/rename/delete events and maintain provenance, invalidating permissions on gaps. But a cross-device move is a sequence of reads/writes/deletes; recognizing a destination creation does not tell whether a source copy remains. Even perfect provenance needs a policy about retained copies and intent. For this bouncer's scope, external snapshots or reversible removal are a simpler way to **create the evidence** than reconstructing it from an event history. This is a design judgment based on the mechanisms above, not a measured implementation-cost comparison. [S12, S35–S40]

## Sources

All URLs below were inspected as page text or raw source unless explicitly labeled otherwise.

- **S1 — local baseline:** [`src/agent-made.ts`](https://github.com/gvanderclay/pi-bouncer/blob/55a92e8170b3c27cc1afaf5443ff22e0f061bfca/src/agent-made.ts), [`src/agent-made-check.ts`](https://github.com/gvanderclay/pi-bouncer/blob/55a92e8170b3c27cc1afaf5443ff22e0f061bfca/src/agent-made-check.ts), and [`docs/behaviour.md`](https://github.com/gvanderclay/pi-bouncer/blob/55a92e8170b3c27cc1afaf5443ff22e0f061bfca/docs/behaviour.md), read locally at that commit.
- **S2 — npm/pacote:** [npm 12.2.1 package.json](https://github.com/npm/cli/blob/ae98c62586b6fea44114f72e249e246a2981de70/package.json); [pacote 22.0.1 package.json](https://github.com/npm/pacote/blob/453a0adac3592e5f93c8f782fb1b1b320ac95009/package.json); [packing options](https://github.com/npm/pacote/blob/453a0adac3592e5f93c8f782fb1b1b320ac95009/lib/util/tar-create-options.js); [extractor, especially lines 388–430](https://github.com/npm/pacote/blob/453a0adac3592e5f93c8f782fb1b1b320ac95009/lib/fetcher.js#L388-L430). Read with `gh api ... -H 'Accept: application/vnd.github.raw'`.
- **S3 — pnpm:** [conceptual node_modules layout](https://pnpm.io/symlinked-node-modules-structure); [pinned pnpm 11 importer](https://github.com/pnpm/pnpm/blob/9c11ea9948f08243dd489ae0a8e5146f5e3939e7/pnpm11/fs/indexed-pkg-importer/src/index.ts), especially lines 21–115, 266–275, 345–360, and 435–450; [modules-yaml implementation](https://github.com/pnpm/pnpm/blob/9c11ea9948f08243dd489ae0a8e5146f5e3939e7/pnpm11/installing/modules-yaml/src/index.ts).
- **S4 — GNU tar 1.35.90:** [Data Modification Times](https://www.gnu.org/software/tar/manual/html_node/Data-Modification-Times.html).
- **S5 — Claude Code current official docs:** [Bash sandbox](https://code.claude.com/docs/en/sandboxing).
- **S6 — Claude Code current official docs:** [Checkpointing, “Bash command changes not tracked”](https://code.claude.com/docs/en/checkpointing#bash-command-changes-not-tracked).
- **S7 — Codex current official docs:** [Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security).
- **S8 — Gemini CLI current official docs:** [Sandboxing](https://geminicli.com/docs/cli/sandbox/).
- **S9 — Cline pinned docs:** [Checkpoints](https://github.com/cline/cline/blob/c441897f11f658f978a00678f045670c1ab2b60d/docs/core-workflows/checkpoints.mdx).
- **S10 — Cursor, older first-party article, 2026-02-18:** [Implementing a secure sandbox for local agents](https://cursor.com/blog/agent-sandboxing). The attempted [old checkpoint documentation URL](https://docs.cursor.com/en/agent/chat/checkpoints) returned a generic landing page, not checkpoint evidence.
- **S11 — OpenHands pinned architecture docs:** [Runtime Architecture, lines 123–135](https://github.com/OpenHands/docs/blob/cdeae6147fd6ca9bab1df9d62511850c917d1dff/openhands/usage/architecture/runtime.mdx#L123-L135).
- **S12 — Linux man-pages:** [unlink(2)](https://man7.org/linux/man-pages/man2/unlink.2.html), description of names, last link, and open references.
- **S13 — trash-cli:** [pinned README](https://github.com/andreafrancia/trash-cli/blob/bfb1595b8520fc7b6eba905d81ef4c228d705aba/README.rst); supported in this research by the project's command descriptions and the XDG specification, S26.
- **S14 — rip:** [pinned README](https://github.com/nivekuil/rip/blob/11f0b8d018975f78d922038efc7f60bf9fffafd0/README.org).
- **S15 — gomi:** [pinned README](https://github.com/babarot/gomi/blob/1bf1f287880d21cdb305f99c9b22674a5b4f142f/README.md).
- **S16 — Aider current official docs:** [Git integration](https://aider.chat/docs/git.html).
- **S17 — Docker current official docs:** [Bind mounts, “Considerations and constraints”](https://docs.docker.com/engine/storage/bind-mounts/#considerations-and-constraints).
- **S18 — btrfs-progs official docs, version not pinned:** [btrfs-subvolume(8)](https://btrfs.readthedocs.io/en/latest/btrfs-subvolume.html), snapshot and nested-subvolume sections.
- **S19 — Apple older archived APFS documentation and local system manual:** [Features](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/Features/Features.html); [FAQ](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html). Also checked `man 2 clonefile | col -b` on macOS **27.0.1 (26A434)** (`sw_vers`): “shares its data blocks” but “has its own copy of attributes and extended attributes”; “Subsequent writes to either the original or cloned file are private to the file being modified (copy-on-write).”
- **S20 — Linux 6.18:** [Overlay Filesystem](https://docs.kernel.org/6.18/filesystems/overlayfs.html), inode properties, whiteouts, and copy-up/hardlink behavior.
- **S21 — Roo Code official docs:** [Checkpoints](https://roocodeinc.github.io/Roo-Code/features/checkpoints/).
- **S22 — Goose official docs:** [Permission Modes](https://goose.vcorp.ai/docs/guides/managing-tools/goose-permissions/).
- **S23 — Amp first-party explanation:** [How We Think About Permissions](https://ampcode.com/notes/permissions).
- **S24 — safe-rm upstream manual republished by Debian:** [safe-rm(1)](https://manpages.debian.org/testing/safe-rm/safe-rm.1.en.html), authored by François Marier, copyright 2008–2020; older source.
- **S25 — libfuse 3.17.1:** [`include/fuse.h:187–198`, `getattr` contract](https://github.com/libfuse/libfuse/blob/fuse-3.17.1/include/fuse.h#L187-L198).
- **S26 — FreeDesktop Trash specification 1.0:** [Trash specification](https://specifications.freedesktop.org/trash/latest/), retention of files and original-path metadata.
- **S27 — sindresorhus/trash current README, unpinned:** [README and platform caveat](https://github.com/sindresorhus/trash#readme).
- **S28 — Apple, 2026-07-06, older than one month:** [About Time Machine local snapshots](https://support.apple.com/en-us/102154).
- **S29 — OpenZFS official manual, displayed date 2022-07-11, older:** [zfs-snapshot(8)](https://openzfs.github.io/openzfs-docs/man/master/8/zfs-snapshot.8.html).
- **S30 — npm CLI v11 docs (page identifies 11.21.1):** [package-lock.json, Hidden Lockfiles](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json#hidden-lockfiles).
- **S31 — Apple's pinned distribution of the older Info-ZIP 6.0 manual:** [`unzip/unzip60/man/unzip.1:290–303`](https://github.com/apple-oss-distributions/zip/blob/c8d52ed44169a71e362af3814988685aa39ee7b4/unzip/unzip60/man/unzip.1#L290-L303). Read as raw source; supersedes an initially inspected third-party manual mirror.
- **S32 — Linux man-pages:** [xattr(7)](https://man7.org/linux/man-pages/man7/xattr.7.html).
- **S33 — Node.js v22.23.4 official docs:** [`fs.stat` bigint option](https://nodejs.org/download/release/v22.23.4/docs/api/fs.html#fsstatpath-options-callback), inspected via the latest-v22.x documentation, which identified this version.
- **S34 — Linux v6.18:** [CIFS usage, `serverino` / `noserverino`](https://github.com/torvalds/linux/blob/v6.18/Documentation/admin-guide/cifs/usage.rst#L465-L484).
- **S35 — Linux man-pages:** [inotify(7)](https://man7.org/linux/man-pages/man7/inotify.7.html), caveats and `IN_Q_OVERFLOW`.
- **S36 — Linux man-pages:** [fanotify(7)](https://man7.org/linux/man-pages/man7/fanotify.7.html), event types, queue and `FAN_Q_OVERFLOW`.
- **S37 — Apple older archived documentation:** [Using the File System Events API](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html).
- **S38 — Linux 6.18:** [LSM BPF Programs](https://docs.kernel.org/6.18/bpf/prog_lsm.html).
- **S39 — Apple older WWDC 2020 sample:** [Monitoring System Events with Endpoint Security](https://developer.apple.com/documentation/endpointsecurity/monitoring-system-events-with-endpoint-security).
- **S40 — CamFlow first-party project documentation:** [CamFlow](https://camflow.org/), project description and installation/support limitations.

## Ranked options for pi-bouncer

These rankings are design recommendations, not measured performance results; cost is relative to the present TypeScript bouncer.

1. **Add narrow all-operand hardlink accounting, and use an explicit larger/time-bounded scan budget rather than bypassing traversal.** Cost: low-to-medium, no new service; safety: a defensible old-file exception under stable, trustworthy filesystem assumptions, but still a preflight guard rail; coverage: macOS and Linux local hardlink-supporting filesystems. Keep the current age/path fallback and ask on errors, mounts, special files, unsupported identity, or incomplete scans. This will help genuine hardlinked stores, **not all pnpm/APFS clones or archives**, and the scan-budget policy must be measured separately. [S1, S3, S12, S20, S25, S34]
2. **Prefer explicit reversible removal when proof is unavailable.** Cost: low integration because trash steering already exists, plus dependency/platform and retention evaluation; safety: retains unique data rather than guessing its origin, but same-user trash is not adversary-proof and must never degrade to permanent deletion on failure; coverage: macOS and Linux with a deliberately selected backend. This is the best broad answer for old-dated archive trees and huge ordinary dependency trees. [S1, S13–S15, S26, S27]
3. **Offer opt-in isolated copied/cloned/overlay workspaces with a protected baseline and explicit export.** Cost: high and outside a small exemption change; safety: strongest protection for original user data when the original and recovery state are not writable by the agent, but still requires recovery for valuable new task outputs; coverage: native Linux OverlayFS/btrfs, native macOS APFS or Linux containers/VMs. OpenHands is a concrete implementation to study. [S11, S17–S20]
4. **Consider verified retained-copy comparison only for a tightly scoped future integration.** Cost: medium-to-high O(total bytes) hashing/comparison plus trusted manifests/storage; safety: stronger than names, dates, or installer markers if complete and protected; coverage: both platforms. It could recognize APFS clones or extracted archives by content, but package lifecycle scripts, extra files, missing originals, and races make it substantially more work than hardlink accounting. [S2–S4, S12, S30]
5. **Do not default to directory-name/marker allowlists or filesystem-watcher provenance.** Cost: names are cheap but untrustworthy; comprehensive provenance is high-cost and platform-specific. Neither establishes a surviving copy merely from origin; xattrs and package markers are forgeable by the same principal, and advisory event streams have gaps. Keep these as diagnostics or explicit user policy, not automatic deletion evidence. [S1, S3, S30, S32, S35–S40]
