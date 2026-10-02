import { posix } from "node:path";

export const HISTORY_MAX = 50;
export const ENTRY_CHARS = 1_000;

export const EARLIER_MAX = 10;
export const MESSAGE_CHARS = 1_000;

export const CUT_MARKER = "… (cut)";

export function cut(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - CUT_MARKER.length)}${CUT_MARKER}`;
}

// Stops at the first item that does not fit, so nothing older than a dropped item is kept.
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

// Never its output, the written content or the edit text.
export type HistoryEntry = {
	readonly tool: "bash" | "write" | "edit";
	readonly text: string;
	readonly cwd: string;
	readonly failed?: true;
	/** A bash call started detached: it may still be running, or fail later. */
	readonly background?: true;
};

export type JudgeSent = {
	readonly history: number;
	readonly earlierMessages: number;
};

export type ToolHistory = { readonly entries: HistoryEntry[] };

export function createHistory(): ToolHistory {
	return { entries: [] };
}

export function clearHistory(history: ToolHistory): void {
	history.entries.length = 0;
}

export function recordEntry(history: ToolHistory, entry: HistoryEntry): void {
	history.entries.push({ ...entry, text: cut(entry.text, ENTRY_CHARS) });
	const over = history.entries.length - HISTORY_MAX;
	if (over > 0) history.entries.splice(0, over);
}

// `path` as Pi's `write` and `edit` resolve it.
export function absolutePath(path: string, cwd: string, home: string): string {
	const bare = path.startsWith("@") ? path.slice(1) : path;
	if (bare === "~") return home;
	const expanded = bare.startsWith("~/") ? `${home}/${bare.slice(2)}` : bare;
	return posix.resolve(cwd, expanded);
}

type BranchEntry = {
	readonly type: string;
	readonly message?: {
		readonly role: string;
		readonly content?: string | readonly { type: string; text?: string }[];
	};
};

export function userTexts(branch: readonly BranchEntry[]): string[] {
	return branch.flatMap(({ type, message }) => {
		if (type !== "message" || message?.role !== "user") return [];
		const { content = "" } = message;
		if (typeof content === "string") return [content];
		return [content.map((p) => (p.type === "text" ? p.text : "")).join("")];
	});
}

export function recentEarlier(texts: readonly string[]): string[] {
	return texts.slice(-EARLIER_MAX).map((t) => cut(t, MESSAGE_CHARS));
}
