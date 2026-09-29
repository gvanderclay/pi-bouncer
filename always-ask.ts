// The route's `auto.alwaysAsk` prefixes: command prefixes that always open the
// dialog in auto mode, even when no rule matched. Free of Pi. Prefixes match
// the argv the rules see, after the scan's unwrapping, so wrappers, chains
// and git's global options (`git -C repo push`) cannot hide them.
import type { Ask } from "./ask.ts";
import { gitCommand } from "./rules/git.ts";
import type { Invocation } from "./scan/walk.ts";

/** The pseudo-rule an alwaysAsk hit is asked under. */
export const ALWAYS_ASK = "always-ask";

/** What the dialog and the no-UI deny say about a hit on `prefix`. */
export function alwaysAskSummary(prefix: string): string {
	return `"${prefix}" is on the route's always-ask list`;
}

// The argv as the rules read it: git without its global options.
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

/** One ask per invocation that starts with a prefix: the first prefix it hits. */
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
