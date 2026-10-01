// What auto mode's judge is told about the session beyond the call itself:
// the user's earlier messages, capped, and the session history, the
// bouncer's own record of the agent's executed bash commands and of the
// paths its `write` and `edit` calls touched. Free of Pi, so the judge, the
// bench and the tests can import it. How a block is rendered, and each
// block's character budget, live in `judge.ts`.
import { posix } from "node:path";

/** At most this many history entries are kept; the oldest go first. */
export const HISTORY_MAX = 50;
/** Each entry's command or path is cut to this many characters. */
export const ENTRY_CHARS = 1_000;

/** At most this many earlier user messages reach the judge. */
export const EARLIER_MAX = 10;
/** Each earlier message is cut to this many characters. */
export const MESSAGE_CHARS = 1_000;

/** Ends a text cut to its limit. */
export const CUT_MARKER = "… (cut)";

/** `text` cut to `limit` characters, marker included, keeping the start. */
export function cut(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - CUT_MARKER.length)}${CUT_MARKER}`;
}

/**
 * The newest of `items`, oldest first, whose costs sum to at most `budget`.
 * The scan stops at the first item that does not fit, so nothing older than
 * a dropped item is kept.
 */
export function newestWithin<T>(
	items: readonly T[],
	cost: (item: T) => number,
	budget: number,
): T[] {
	const kept: T[] = [];
	let used = 0;
	for (let i = items.length - 1; i >= 0; i -= 1) {
		const item = items[i] as T;
		used += cost(item);
		if (used > budget) break;
		kept.unshift(item);
	}
	return kept;
}

/**
 * One executed call: a bash command, or the absolute path a `write` or
 * `edit` touched, with the working directory it ran in. Never its output,
 * the written content or the edit text.
 */
export type HistoryEntry = {
	readonly tool: "bash" | "write" | "edit";
	/** The command, or the absolute path; cut to `ENTRY_CHARS`. */
	readonly text: string;
	readonly cwd: string;
	/** The call ran and ended in an error, such as a non-zero exit. */
	readonly failed?: true;
	/** A bash call started detached: it may still be running, or fail later. */
	readonly background?: true;
};

/** How much evidence a judge call was sent, for the log; never its content. */
export type JudgeSent = {
	readonly history: number;
	readonly earlierMessages: number;
};

/** The session history, oldest first. Cleared at every session start. */
export type ToolHistory = { readonly entries: HistoryEntry[] };

/** An empty session history. */
export function createHistory(): ToolHistory {
	return { entries: [] };
}

/** Empties `history`, as every session start does. */
export function clearHistory(history: ToolHistory): void {
	history.entries.length = 0;
}

/** Appends `entry`, cut to `ENTRY_CHARS`, keeping the newest `HISTORY_MAX`. */
export function recordEntry(history: ToolHistory, entry: HistoryEntry): void {
	history.entries.push({ ...entry, text: cut(entry.text, ENTRY_CHARS) });
	const over = history.entries.length - HISTORY_MAX;
	if (over > 0) history.entries.splice(0, over);
}

/**
 * `path` as Pi's `write` and `edit` resolve it: a leading `@` stripped, `~`
 * expanded to `home`, then made absolute against `cwd`.
 */
export function absolutePath(path: string, cwd: string, home: string): string {
	const bare = path.startsWith("@") ? path.slice(1) : path;
	if (bare === "~") return home;
	const expanded = bare.startsWith("~/") ? `${home}/${bare.slice(2)}` : bare;
	return posix.resolve(cwd, expanded);
}

/** The part of a session branch entry `userTexts` reads. */
type BranchEntry = {
	readonly type: string;
	readonly message?: {
		readonly role: string;
		readonly content?: string | readonly { type: string; text?: string }[];
	};
};

/**
 * The text of every user message on a session branch, oldest first: its
 * text parts joined, images left out. Every other entry is skipped.
 */
export function userTexts(branch: readonly BranchEntry[]): string[] {
	return branch.flatMap(({ type, message }) => {
		if (type !== "message" || message?.role !== "user") return [];
		const { content = "" } = message;
		if (typeof content === "string") return [content];
		return [content.map((p) => (p.type === "text" ? p.text : "")).join("")];
	});
}

/**
 * The newest `EARLIER_MAX` of `texts` (the user's messages before the
 * latest, oldest first), each cut to `MESSAGE_CHARS`. The judge input keeps
 * the newest of them within `EARLIER_CHARS` (`earlierWithinBudget` in
 * `judge.ts`).
 */
export function recentEarlier(texts: readonly string[]): string[] {
	return texts.slice(-EARLIER_MAX).map((t) => cut(t, MESSAGE_CHARS));
}
