// Verdict types and the pure text shown to the model and the user.

export type VerdictLevel = "deny" | "ask";

export type RuleName =
	| "parser-unavailable"
	| "unparseable"
	| "inline-too-deep"
	| "rm-root"
	| "recursive-rm"
	| "find-delete"
	| "find-exec"
	| "fd-exec"
	| "rg-pre"
	| "disk-format"
	| "dd-device"
	| "power"
	| "privilege"
	| "git-clean"
	| "git-reset-hard"
	| "git-checkout-discard"
	| "git-restore-worktree"
	| "git-stash-destroy"
	| "git-push-force"
	| "git-push-delete"
	| "remote-script"
	| "publish"
	| "gh-delete"
	| "grep"
	/** Auto mode's pseudo-rule for the route's `auto.alwaysAsk` prefixes. */
	| "always-ask";

export type Verdict = {
	readonly level: VerdictLevel;
	readonly rule: RuleName;
	readonly reason: string;
	readonly command: string;
};

/** What the bouncer decided for one bash call. `stop` also ends the turn. */
export type Outcome =
	| { readonly kind: "allow" }
	| {
			readonly kind: "block";
			readonly reason: string;
			readonly warning?: string;
			readonly stop: boolean;
	  };

const PREFIX = "Blocked by the user's bouncer";
const REASON_LIMIT = 200;
const NOTIFY_LIMIT = 80;

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** A command as quoted to the model and in dialogs: at most 200 characters. */
export function clip(command: string): string {
	return truncate(command, REASON_LIMIT);
}

export function parserUnavailable(command: string): Verdict {
	return {
		level: "deny",
		rule: "parser-unavailable",
		reason: `${PREFIX} (rule: parser-unavailable): the bouncer could not load its bash parser, so every bash command is blocked. Tell the user to run \`pnpm install\` in pi/extensions/bouncer.`,
		command,
	};
}

export function unparseable(command: string, message: string): Verdict {
	return {
		level: "deny",
		rule: "unparseable",
		reason: `${PREFIX} (rule: unparseable): the command could not be parsed as bash (${message}). Command: \`${truncate(command, REASON_LIMIT)}\`. None of the command ran. Rewrite it as plain, valid bash.`,
		command,
	};
}

export function inlineTooDeep(command: string): Verdict {
	return {
		level: "deny",
		rule: "inline-too-deep",
		reason: `${PREFIX} (rule: inline-too-deep): the command nests inline scripts (sh -c, eval, env -S, trap) more than 3 levels deep. Command: \`${truncate(command, REASON_LIMIT)}\`. None of the command ran. Rewrite it without the nesting.`,
		command,
	};
}

export function ruleDenied(
	entry: {
		readonly rule: { readonly name: RuleName; readonly summary: string };
		readonly level: VerdictLevel;
	},
	command: string,
): Verdict {
	const { rule } = entry;
	return {
		level: entry.level,
		rule: rule.name,
		reason: `${PREFIX} (rule: ${rule.name}): ${rule.summary}. Command: \`${truncate(command, REASON_LIMIT)}\`. None of the command ran. Do not retry this action through another command, script, or tool. Tell the user what was blocked and why, and let them decide.`,
		command,
	};
}

/**
 * A steer rule's deny: it invites a retry with what `instead` names, so it
 * never says not to retry or to tell the user.
 */
export function steerDenied(
	rule: { readonly name: RuleName; readonly summary: string },
	instead: string,
	command: string,
): Verdict {
	return {
		level: "deny",
		rule: rule.name,
		reason: `${PREFIX} (rule: ${rule.name}): ${rule.summary}. Command: \`${truncate(command, REASON_LIMIT)}\`. None of the command ran. ${instead}`,
		command,
	};
}

/**
 * A deny whose reason is one sentence in place of a rule's summary, in
 * `ruleDenied`'s form, for every rule the line matched. The text never says
 * who wrote the sentence.
 */
export function reasonDenied(
	rules: readonly RuleName[],
	sentence: string,
	command: string,
): Verdict {
	const [rule = "unparseable"] = rules;
	const said = sentence.trim().replace(/[.\s]+$/, "");
	return {
		level: "deny",
		rule,
		reason: `${PREFIX} (rule: ${rules.join(", ")}): ${said}. Command: \`${truncate(command, REASON_LIMIT)}\`. None of the command ran. Do not retry this action through another command, script, or tool. Tell the user what was blocked and why, and let them decide.`,
		command,
	};
}

/** Why a call is blocked when the user denied it in the dialog. */
export function userDenied(
	rule: RuleName,
	source: string,
	answer: { readonly userReason?: string; readonly stop?: boolean } = {},
): string {
	const base = `The user denied \`${clip(source)}\` (rule: ${rule}). None of the command ran. Do not retry it or work around it. Ask the user how to proceed.`;
	const said = answer.userReason
		? ` The user's reason: ${answer.userReason}`
		: "";
	const stopped = answer.stop ? " The user stopped the turn." : "";
	return `${base}${said}${stopped}`;
}

export function notification(
	verdict: Verdict,
	rules: readonly RuleName[] = [verdict.rule],
): string {
	return `Bouncer denied ${rules.join(", ")}: ${truncate(verdict.command, NOTIFY_LIMIT)}`;
}
