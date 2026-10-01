// What the judge and Jev are shown for one line, built once and rendered
// twice. `judgeRequest` is the one builder: it keeps the earlier messages and
// the session history within their budgets. `judgeInput` is the judge's text
// and `jevState` is Jev's state, so "Jev sees what the judge sees" is kept
// here, next to the one field list. Free of Pi.
import type { GitState, RemoteFact } from "./facts.ts";
import { type HistoryEntry, newestWithin } from "./history.ts";

/** The earlier-messages block stays within this many characters. */
export const EARLIER_CHARS = 4_000;

/** The session-history block stays within this many characters. */
export const HISTORY_CHARS = 8_000;

/** One uncovered ask, as the judge sees it. */
export type JudgeAsk = {
	readonly rule: string;
	readonly summary: string;
	readonly source: string;
};

/** Marks a request only `judgeRequest` made. It exists in types alone. */
declare const built: unique symbol;

/**
 * The fields a judge request is built from. Never tool output, file
 * contents, the agent's own messages or AGENTS.md.
 */
export type JudgeFields = {
	readonly command: string;
	readonly asks: readonly JudgeAsk[];
	readonly cwd: string;
	readonly git?: GitState;
	readonly remotes?: readonly RemoteFact[];
	/**
	 * The user's messages before the last on the session's branch, oldest
	 * first, each already cut (`recentEarlier` in `history.ts`). The input
	 * keeps the newest within `EARLIER_CHARS`.
	 */
	readonly earlierUserMessages?: readonly string[];
	/**
	 * The session history, oldest first: the agent's executed bash commands
	 * and `write`/`edit` paths since the session started. The input keeps the
	 * newest within `HISTORY_CHARS`.
	 */
	readonly history?: readonly HistoryEntry[];
	/** The text of the user's last message on the session's branch. */
	readonly userMessage?: string;
	/** The route's `auto.environment` facts, appended to the prompt. */
	readonly environment?: readonly string[];
};

/**
 * What the judge and Jev are shown: the fields with the earlier messages and
 * the session history within their budgets. The renderers render it as it
 * is, so the type keeps a request made by hand out of them.
 */
export type JudgeRequest = JudgeFields & { readonly [built]: true };

/**
 * The one builder of a judge request. The earlier messages and the session
 * history come out within their budgets, and an empty earlier list, an empty
 * history and an empty user message are left out. It applies no other cap:
 * the caller's own caps (`recentEarlier`, `recordEntry`) come first.
 * Building a request from a built request's own fields gives the same one.
 */
export function judgeRequest(fields: JudgeFields): JudgeRequest {
	const earlier = earlierWithinBudget(fields.earlierUserMessages ?? []);
	const history = historyWithinBudget(fields.history ?? [], fields.cwd);
	const request: JudgeFields = {
		command: fields.command,
		asks: fields.asks,
		cwd: fields.cwd,
		...(fields.git && { git: fields.git }),
		...(fields.remotes && { remotes: fields.remotes }),
		...(fields.environment && { environment: fields.environment }),
		...(earlier.length > 0 && { earlierUserMessages: earlier }),
		...(history.length > 0 && { history }),
		...(fields.userMessage && { userMessage: fields.userMessage }),
	};
	// The one place a request is made: the mark is not a runtime property.
	return request as JudgeRequest;
}

function gitLines(git: GitState | undefined): string[] {
	if (!git) return [];
	if (git.kind === "not-a-repo") return ["Git: not a git repository"];
	if (git.kind === "unknown") return ["Git branch: unknown"];
	const state = git.dirty ? "with uncommitted changes" : "clean";
	return [`Git branch: ${git.branch}, ${state}`];
}

function remoteLines(remotes: readonly RemoteFact[] | undefined): string[] {
	if (!remotes || remotes.length === 0) return [];
	const flag = " (added or changed this session)";
	const lines = remotes.map(
		({ name, url, changed }) => `- ${name} ${url}${changed ? flag : ""}`,
	);
	return ["Git remotes:", ...lines];
}

// Any block's closing tag, in any case: none may end a block early.
const CLOSING_TAG =
	/<\/(command|user_message|earlier_user_messages|session_history)\b/gi;

/** `text` with every block's literal closing tag escaped as `<\/tag`. */
function escaped(text: string): string {
	return text.replace(CLOSING_TAG, "<\\/$1");
}

/** `lines` between `<tag>` and `</tag>`, or nothing when there are none. */
function block(tag: string, lines: readonly string[]): string[] {
	return lines.length === 0 ? [] : [`<${tag}>`, ...lines, `</${tag}>`];
}

/** One earlier message without its number, later lines indented. */
function messageBody(text: string): string {
	return escaped(text).replaceAll("\n", "\n    ");
}

/**
 * The newest `messages` whose numbered lines (`[n] text`) fit
 * `EARLIER_CHARS`, oldest first.
 */
export function earlierWithinBudget(messages: readonly string[]): string[] {
	// `[n] ` and a newline per line, sized for the widest number.
	const overhead = `[${messages.length}] `.length + 1;
	const cost = (text: string): number => messageBody(text).length + overhead;
	return newestWithin(messages, cost, EARLIER_CHARS + 1);
}

function earlierLines(messages: readonly string[] = []): string[] {
	return messages.map((text, i) => `[${i + 1}] ${messageBody(text)}`);
}

/**
 * One history entry without its number: `bash (cwd /x; failed): command`.
 * The cwd shows only when it differs from the call's. A command's later
 * lines are indented, so none can pass for an entry of its own.
 */
function entryBody(entry: HistoryEntry, cwd: string): string {
	const notes = [
		...(entry.cwd === cwd ? [] : [`cwd ${entry.cwd}`]),
		...(entry.failed ? ["failed"] : []),
		...(entry.background ? ["started in background"] : []),
	];
	const label =
		notes.length === 0 ? entry.tool : `${entry.tool} (${notes.join("; ")})`;
	return `${label}: ${escaped(entry.text).replaceAll("\n", "\n   ")}`;
}

/**
 * The newest `entries` whose numbered lines, as a call in `cwd` renders
 * them, fit `HISTORY_CHARS`, oldest first: what the judge is sent.
 */
export function historyWithinBudget(
	entries: readonly HistoryEntry[],
	cwd: string,
): HistoryEntry[] {
	// `n. ` and a newline per line, sized for the widest number.
	const overhead = `${entries.length}. `.length + 1;
	const cost = (entry: HistoryEntry): number =>
		entryBody(entry, cwd).length + overhead;
	return newestWithin(entries, cost, HISTORY_CHARS + 1);
}

function historyLines(
	entries: readonly HistoryEntry[] = [],
	cwd: string,
): string[] {
	return entries.map((entry, i) => `${i + 1}. ${entryBody(entry, cwd)}`);
}

/** The judge input for one bash line. */
export function judgeInput(request: JudgeRequest): string {
	const flagged = request.asks.map(
		({ rule, summary, source }) => `- ${rule} (${summary}): ${source}`,
	);
	const said = request.userMessage;
	return [
		"Flagged by the bouncer:",
		...flagged,
		`Working directory: ${request.cwd}`,
		...gitLines(request.git),
		...remoteLines(request.remotes),
		...block(
			"earlier_user_messages",
			earlierLines(request.earlierUserMessages),
		),
		...block("session_history", historyLines(request.history, request.cwd)),
		...block("user_message", said ? [escaped(said)] : []),
		"<command>",
		escaped(request.command),
		"</command>",
	].join("\n");
}

/**
 * What Jev is shown: the fields `judgeInput` sends, the same lists, and
 * nothing else.
 */
export function jevState(request: JudgeRequest): Record<string, unknown> {
	const earlier = request.earlierUserMessages ?? [];
	const history = request.history ?? [];
	const remotes = request.remotes ?? [];
	return {
		flagged: request.asks.map(({ rule, summary, source }) => ({
			rule,
			summary,
			source,
		})),
		working_directory: request.cwd,
		...(request.git && { git: request.git }),
		...(remotes.length > 0 && {
			remotes: remotes.map(({ name, url, changed }) => ({
				name,
				url,
				changed,
			})),
		}),
		...(earlier.length > 0 && { earlier_user_messages: earlier }),
		...(history.length > 0 && {
			session_history: history.map(
				({ tool, text, cwd, failed, background }) => ({
					tool,
					text,
					cwd,
					...(failed && { failed }),
					...(background && { background }),
				}),
			),
		}),
		...(request.userMessage && { user_message: request.userMessage }),
		command: request.command,
	};
}
