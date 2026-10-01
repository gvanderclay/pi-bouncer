// The built-in policy: every built-in rule, steer rule and unreadable-command
// deny, in evaluation order, at the level the bouncer ships with. Only
// `config.ts` turns it into an effective policy.

import type { RuleName } from "../verdict.ts";
import { findDelete, recursiveRm, rmRoot } from "./filesystem.ts";
import {
	gitCheckoutDiscard,
	gitClean,
	gitResetHard,
	gitRestoreWorktree,
	gitStashDestroy,
} from "./git.ts";
import { gitPushDelete, gitPushForce } from "./git-push.ts";
import { grep, grepInstead } from "./grep.ts";
import { fdExec, findExec, rgPre } from "./hidden-exec.ts";
import { privilege } from "./privilege.ts";
import { ghDelete, publish } from "./publish.ts";
import { remoteScript } from "./remote-script.ts";
import { type Policy, type PolicyEntry, policyEntryName } from "./rule.ts";
import { ddDevice, diskFormat, power } from "./system.ts";

export const builtInPolicy: Policy = [
	{ kind: "unreadable", name: "parser-unavailable", level: "deny" },
	{ kind: "unreadable", name: "unparseable", level: "deny" },
	{ kind: "unreadable", name: "inline-too-deep", level: "deny" },
	{ kind: "rule", rule: rmRoot, level: "deny" },
	{ kind: "rule", rule: recursiveRm, level: "ask" },
	{ kind: "rule", rule: findDelete, level: "ask" },
	{ kind: "rule", rule: findExec, level: "ask" },
	{ kind: "rule", rule: fdExec, level: "ask" },
	{ kind: "rule", rule: rgPre, level: "ask" },
	{ kind: "rule", rule: diskFormat, level: "deny" },
	{ kind: "rule", rule: ddDevice, level: "deny" },
	{ kind: "rule", rule: power, level: "deny" },
	{ kind: "rule", rule: privilege, level: "deny" },
	{ kind: "rule", rule: gitClean, level: "ask" },
	{ kind: "rule", rule: gitResetHard, level: "ask" },
	{ kind: "rule", rule: gitCheckoutDiscard, level: "ask" },
	{ kind: "rule", rule: gitRestoreWorktree, level: "ask" },
	{ kind: "rule", rule: gitStashDestroy, level: "ask" },
	{ kind: "rule", rule: gitPushForce, level: "ask" },
	{ kind: "rule", rule: gitPushDelete, level: "ask" },
	{ kind: "rule", rule: remoteScript, level: "ask" },
	{ kind: "rule", rule: publish, level: "ask" },
	{ kind: "rule", rule: ghDelete, level: "ask" },
	{ kind: "steer", rule: grep, instead: grepInstead, level: "deny" },
];

/** Every built-in policy entry by its name (`policyEntryName`). */
export const builtInEntries: ReadonlyMap<string, PolicyEntry> = new Map(
	builtInPolicy.map((entry) => [policyEntryName(entry), entry]),
);

/**
 * The rules YOLO mode still denies, whatever the bouncer config's levels say:
 * fixed here, so no config can shrink or grow it. The unreadable-command
 * denies and the steer rules stay denied in YOLO mode by their kind, not by
 * this list.
 */
export const alwaysDenySet: ReadonlySet<RuleName> = new Set<RuleName>([
	"privilege",
	"power",
	"disk-format",
	"dd-device",
	"rm-root",
]);
