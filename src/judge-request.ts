// Jev sees what the judge sees: both are rendered from the one request built here.
import type { GitState, RemoteFact } from "./facts.ts";
import type { Direction, FileChange, FileTool } from "./file-call.ts";
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

/** The MCP tool a request is about. */
export type McpJudged = {
	readonly tool: string;
	readonly description?: string;
};

/** The file call a request is about. */
export type FileJudged = {
	readonly tool: FileTool;
	readonly direction: Direction;
	/** The real path. */
	readonly path: string;
	readonly change?: FileChange;
	/** true when a secret group matched: the change was left out. */
	readonly redacted?: true;
};

// Never tool output, file contents read, the agent's own messages or
// AGENTS.md. A write or edit's own change is sent, unless a secret group
// matched its path.
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
	/** Set for an MCP call; `command` is then its JSON arguments. */
	readonly mcp?: McpJudged;
	/** Set for a file call; `command` is then "<tool> <real path>". */
	readonly file?: FileJudged;
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
		...(fields.mcp && { mcp: fields.mcp }),
		...(fields.file && { file: fields.file }),
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
	/<\/(command|user_message|earlier_user_messages|session_history|tool_description|arguments|content|old_text|new_text)\b/gi;

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

function mcpLines(mcp: McpJudged, args: string): string[] {
	const description = mcp.description ? [escaped(mcp.description)] : [];
	return [
		`MCP tool: ${escaped(mcp.tool)}`,
		...block("tool_description", description),
		...block("arguments", [escaped(args)]),
	];
}

function changeLines(file: FileJudged): string[] {
	if (file.redacted) {
		return ["Change: redacted (the path is in a group that holds secrets)"];
	}
	const { change } = file;
	if (!change) return [];
	if (change.kind === "write")
		return block("content", [escaped(change.content)]);
	return change.edits.flatMap(({ oldText, newText }) => [
		...block("old_text", [escaped(oldText)]),
		...block("new_text", [escaped(newText)]),
	]);
}

function fileLines(file: FileJudged): string[] {
	return [
		`File tool: ${file.tool}`,
		`Direction: ${file.direction}`,
		`Path: ${escaped(file.path)}`,
		...changeLines(file),
	];
}

function callLines(request: JudgeRequest): string[] {
	if (request.mcp) return mcpLines(request.mcp, request.command);
	if (request.file) return fileLines(request.file);
	return ["<command>", escaped(request.command), "</command>"];
}

/** What a size skip reports: a file call's change, else the command. */
export function judgedChars(request: JudgeRequest): number {
	const change = request.file?.change;
	if (!change) return request.command.length;
	if (change.kind === "write") return change.content.length;
	return change.edits.reduce(
		(sum, { oldText, newText }) => sum + oldText.length + newText.length,
		0,
	);
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
		...callLines(request),
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
