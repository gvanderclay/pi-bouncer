// Pi's file tools: a file call's path, in every spelling, is ranked against
// the policy's path entries. A deny blocks, an ask goes through
// `decideToolAsk`, and no match allows. Anything that goes wrong while
// deciding blocks the call.
import { errorText } from "./error-text.ts";
import { type FileAccess, type FileTool, readFileCall } from "./file-call.ts";
import { fileDiff } from "./file-diff.ts";
import {
	autoDecided,
	type Call,
	type Decision,
	decided,
	yoloDecided,
} from "./gate.ts";
import { type Spellings, spellings } from "./path-spellings.ts";
import { rankFile } from "./rules/path-rank.ts";
import type { Policy } from "./rules/rule.ts";
import { decideToolAsk } from "./tool-ask.ts";
import { clip, notification, type Verdict } from "./verdict.ts";

export type FileCall = Call & {
	readonly tool: FileTool;
	readonly input: unknown;
	readonly policy: Policy;
	readonly agentDir: string;
	/** Session allows for file calls; cleared at each session start. */
	readonly allowed: Set<string>;
};

export type FileDecision = {
	readonly decision: Decision;
	readonly access?: FileAccess;
	readonly paths?: Spellings;
};

function blockedBy(verdict: Verdict, call: FileCall): Decision {
	const { rule, level, command: source } = verdict;
	return {
		kind: "block",
		reason: verdict.reason,
		warning: notification(verdict),
		stop: false,
		trace: {
			matches: [{ rule, level, source }],
			ui: call.ui !== undefined,
			asks: [],
		},
	};
}

function failed(access: FileAccess, error: unknown): Verdict {
	return {
		level: "deny",
		rule: "unparseable",
		reason: `Blocked by the user's bouncer (rule: unparseable): the bouncer could not resolve the path \`${clip(access.path)}\` (${errorText(error)}). None of the call ran. Tell the user what was blocked and why, and let them decide.`,
		command: access.path,
	};
}

// "<tool> <typed path> → <real path>", with the arrow only when a symlink or
// an unusual spelling led somewhere else.
function heading(access: FileAccess, paths: Spellings): string {
	const shown =
		paths.absolute === paths.real
			? paths.typed
			: `${paths.typed} → ${paths.real}`;
	return `${access.tool} ${shown}`;
}

async function decidedFor(
	access: FileAccess,
	paths: Spellings,
	call: FileCall,
): Promise<Decision> {
	const { policy, allowed, mode } = call;
	const where = {
		cwd: call.cwd,
		home: call.home,
		agentDir: call.agentDir,
	};
	// The session-allow key: one path, in one direction.
	const command = `${access.direction} ${paths.real}`;
	const ranking = rankFile(access, paths, policy, where, "normal");
	if (mode === "yolo") {
		const yolo = rankFile(access, paths, policy, where, "yolo");
		return yoloDecided(yolo, ranking, command, call, allowed);
	}
	const ranked =
		mode === "auto" ? rankFile(access, paths, policy, where, "auto") : ranking;
	if (ranked?.kind !== "ask") {
		return mode === "auto"
			? autoDecided(ranked, ranking, command, call, allowed)
			: decided(ranked, command, call, allowed);
	}
	// Until file calls get judge requests, auto mode hands their asks to the
	// dialog, or blocks them with no UI.
	const detail = fileDiff(access, paths.real);
	return decideToolAsk({
		...call,
		command,
		title: heading(access, paths),
		asks:
			detail === ""
				? ranked.asks
				: ranked.asks.map((ask) => ({ ...ask, detail })),
		fallback: ranked.fallback,
		judged: false,
	});
}

export async function decideFile(call: FileCall): Promise<FileDecision> {
	const given = readFileCall(call.tool, call.input);
	if (given.kind === "unreadable") {
		return { decision: blockedBy(given.verdict, call) };
	}
	const { access } = given;
	// shortcut: `grep`, `find` and `ls` run unchecked; their search scope comes
	// with ticket 04. Upgrade when the search tools get their path rules.
	if (access.search) return { decision: { kind: "allow" }, access };
	try {
		const paths = spellings(access, call.cwd, call.home);
		const decision = await decidedFor(access, paths, call);
		return { decision, access, paths };
	} catch (error) {
		return { decision: blockedBy(failed(access, error), call), access };
	}
}
