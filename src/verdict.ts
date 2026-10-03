import { dirname } from "node:path";

export type VerdictLevel = "deny" | "ask";

// A level a config can set: "off" drops the rule from the policy.
export type ConfigLevel = VerdictLevel | "off";

// A built-in rule's name, a custom rule's name, or "always-ask".
export type RuleName = string;

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

/** A hard block's last sentences: no retry, hand the choice to the user. */
export const DO_NOT_RETRY =
	"Do not retry this action through another command, script, or tool. Tell the user what was blocked and why, and let them decide.";

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function clip(command: string): string {
	return truncate(command, REASON_LIMIT);
}

// The package root, one level above this file in src/.
const PACKAGE_DIR = dirname(import.meta.dirname);

export function parserUnavailable(command: string): Verdict {
	return {
		level: "deny",
		rule: "parser-unavailable",
		reason: `${PREFIX} (rule: parser-unavailable): the bouncer could not load its bash parser (unbash), so every bash command is blocked. Tell the user to reinstall the package (\`pi install npm:pi-bouncer\`), or for a local checkout to run \`npm install\` in ${PACKAGE_DIR}.`,
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
		reason: `${PREFIX} (rule: ${rule.name}): ${rule.summary}. Command: \`${truncate(command, REASON_LIMIT)}\`. None of the command ran. ${DO_NOT_RETRY}`,
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

// The text never says who wrote the sentence.
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
		reason: `${PREFIX} (rule: ${rules.join(", ")}): ${said}. Command: \`${truncate(command, REASON_LIMIT)}\`. None of the command ran. ${DO_NOT_RETRY}`,
		command,
	};
}

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
