// Prefixes match the argv the rules see, after the scan's unwrapping, so
// wrappers, chains and git's global options (`git -C repo push`) cannot hide them.
import type { Ask } from "./ask.ts";
import { gitCommand } from "./rules/git.ts";
import type { Invocation } from "./scan/walk.ts";

export const ALWAYS_ASK = "always-ask";

export function alwaysAskSummary(prefix: string): string {
	return `"${prefix}" is on the user's auto.alwaysAsk list`;
}

function argvOf(invocation: Invocation): readonly string[] {
	const git = gitCommand(invocation);
	if (git) return ["git", git.subcommand, ...git.args];
	return [invocation.name, ...invocation.args];
}

function startsWith(
	argv: readonly string[],
	words: readonly string[],
): boolean {
	return words.length > 0 && words.every((word, at) => argv[at] === word);
}

export function alwaysAskHits(
	invocations: readonly Invocation[],
	prefixes: readonly string[],
): Ask[] {
	const split = prefixes.map((prefix) => ({
		prefix,
		words: prefix.trim().split(/\s+/),
	}));
	const asks: Ask[] = [];
	for (const invocation of invocations) {
		const argv = argvOf(invocation);
		const hit = split.find(({ words }) => startsWith(argv, words));
		if (!hit) continue;
		const { source } = invocation;
		if (asks.some((ask) => ask.source === source)) continue;
		asks.push({
			rule: ALWAYS_ASK,
			summary: alwaysAskSummary(hit.prefix),
			source,
		});
	}
	return asks;
}
