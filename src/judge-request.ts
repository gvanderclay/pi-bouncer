// Jev sees what the judge sees: both are rendered from the one request built here.
import type { GitState, RemoteFact } from "./facts.ts";
import { type HistoryEntry, newestWithin } from "./history.ts";

const EARLIER_CHARS = 4_000;

const HISTORY_CHARS = 8_000;

export type JudgeAsk = {
	readonly rule: string;
	readonly summary: string;
	readonly source: string;
};

/** Marks a request only `judgeRequest` made. It exists in types alone. */
declare const built: unique symbol;

// Never tool output, file contents, the agent's own messages or AGENTS.md.
export type JudgeFields = {
	readonly command: string;
	readonly asks: readonly JudgeAsk[];
	readonly cwd: string;
	readonly git?: GitState;
	readonly remotes?: readonly RemoteFact[];
	readonly earlierUserMessages?: readonly string[];
	readonly history?: readonly HistoryEntry[];
	readonly userMessage?: string;
	readonly environment?: readonly string[];
};

// The type keeps a hand-made request out of the renderers.
export type JudgeRequest = JudgeFields & { readonly [built]: true };

// Applies no other cap: the caller's own caps come first.
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

function escaped(text: string): string {
	return text.replace(CLOSING_TAG, "<\\/$1");
}

function block(tag: string, lines: readonly string[]): string[] {
	return lines.length === 0 ? [] : [`<${tag}>`, ...lines, `</${tag}>`];
}

function messageBody(text: string): string {
	return escaped(text).replaceAll("\n", "\n    ");
}

function earlierWithinBudget(messages: readonly string[]): string[] {
	const overhead = `[${messages.length}] `.length + 1;
	const cost = (text: string): number => messageBody(text).length + overhead;
	return newestWithin(messages, cost, EARLIER_CHARS + 1);
}

function earlierLines(messages: readonly string[] = []): string[] {
	return messages.map((text, i) => `[${i + 1}] ${messageBody(text)}`);
}

// The cwd shows only when it differs from the call's. A command's later lines
// are indented so none can pass for an entry of its own.
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

function historyWithinBudget(
	entries: readonly HistoryEntry[],
	cwd: string,
): HistoryEntry[] {
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
