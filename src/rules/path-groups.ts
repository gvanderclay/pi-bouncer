// The built-in path groups, in evaluation order, each at its shipped levels.
import { compilePattern, type PathPattern } from "./path-patterns.ts";
import type { PathEntry } from "./rule.ts";

function pattern(source: string): PathPattern {
	const compiled = compilePattern(source);
	if (!compiled) throw new Error(`bad built-in path pattern: ${source}`);
	return compiled;
}

export const pathGroups: readonly PathEntry[] = [
	{
		kind: "path",
		rule: {
			name: "path-ssh",
			summary: "~/.ssh holds SSH keys and their settings",
			patterns: [pattern("~/.ssh/**")],
		},
		levels: { read: "deny", write: "deny" },
	},
];
