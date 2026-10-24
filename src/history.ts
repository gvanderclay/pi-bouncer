import { posix } from "node:path";
import { fileURLToPath } from "node:url";

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

// Never its output, the written content, the edit text or an MCP call's arguments.
export type HistoryEntry = {
	readonly tool: "bash" | "write" | "edit" | "mcp";
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

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

// `path` as Pi's file tools resolve it: `resolveToCwd` in Pi's
// dist/core/tools/path-utils.js and `normalizePath` in dist/utils/paths.js,
// mirrored from @earendil-works/pi-coding-agent 1.0.0 (POSIX paths only).
export function absolutePath(path: string, cwd: string, home: string): string {
	const spaced = path.replace(UNICODE_SPACES, " ");
	const bare = spaced.startsWith("@") ? spaced.slice(1) : spaced;
	if (bare === "~") return home;
	let expanded = bare.startsWith("~/") ? posix.join(home, bare.slice(2)) : bare;
	if (/^file:\/\//.test(expanded)) {
		try {
			expanded = fileURLToPath(expanded);
		} catch {
			// A URL Pi cannot open either (a remote host): Pi's tool fails on it.
		}
	}
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
