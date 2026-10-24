// MCP tool calls (`mcp__<server>__<tool>`) have no shell string to rule on:
// an allow-listed tool runs, and every other one goes through `decideToolAsk`.
// Tool annotations (readOnlyHint and the rest) are the server's unverified
// claims: they never allow a call and are never shown to the judge.
import type { Ask } from "./ask.ts";
import type { Call, Decision } from "./gate.ts";
import { isObject } from "./json.ts";
import { decideToolAsk } from "./tool-ask.ts";
import { clip, type Verdict } from "./verdict.ts";

const MCP_RULE = "mcp";

export type McpSettings = {
	/** Tool-name patterns, normalised as Pi names MCP tools; `*` matches anything. */
	readonly allow: readonly string[];
	/** false: auto mode opens the dialog instead of asking the judge. */
	readonly judge?: false;
};

export function isMcpTool(toolName: string): boolean {
	return toolName.startsWith("mcp__");
}

// Pi replaces every character but letters, digits and `_` in an MCP tool's
// name with `_` (docs/mcp.md, "Configuration rules"), so `dev-radius` is
// written `dev_radius` in the name; an entry is normalised the same way.
function normalised(pattern: string): string {
	return pattern.replace(/[^A-Za-z0-9_*]/g, "_");
}

function allowList(list: unknown): string[] | undefined {
	if (!Array.isArray(list)) return undefined;
	if (!list.every((p) => typeof p === "string" && p.startsWith("mcp__"))) {
		return undefined;
	}
	return list.map(normalised);
}

/** One key's setting, or `undefined` after pushing its problem. */
function mcpEntry(
	key: string,
	entry: unknown,
	problems: string[],
): Partial<McpSettings> | undefined {
	if (key === "judge") {
		if (typeof entry === "boolean") return entry ? {} : { judge: false };
		problems.push("mcp.judge must be true or false");
	} else if (key === "allow") {
		const allow = allowList(entry);
		if (allow) return { allow };
		problems.push(
			'mcp.allow must be a list of tool names starting with "mcp__", such as "mcp__github__*"',
		);
	} else problems.push(`mcp: unknown key "${key}"`);
	return undefined;
}

export function validMcp(
	value: unknown,
	problems: string[],
): McpSettings | undefined {
	if (!isObject(value)) {
		problems.push('"mcp" is not an object');
		return undefined;
	}
	let settings: McpSettings = { allow: [] };
	for (const [key, entry] of Object.entries(value)) {
		settings = { ...settings, ...mcpEntry(key, entry, problems) };
	}
	return settings;
}

function matches(pattern: string, toolName: string): boolean {
	const parts = pattern
		.split("*")
		.map((s) => s.replace(/[\\^$.|?+()[\]{}]/g, "\\$&"));
	return new RegExp(`^${parts.join(".*")}$`).test(toolName);
}

export function mcpAllowed(
	toolName: string,
	allow: readonly string[],
): boolean {
	return allow.some((pattern) => matches(pattern, toolName));
}

export type McpCall = Call & {
	readonly toolName: string;
	readonly input: unknown;
	readonly allow: readonly string[];
	/** Session allows, keyed per tool; cleared at each session start. */
	readonly allowed: Set<string>;
};

/** An MCP call's whole arguments as JSON: what the judge reads. */
export function mcpJson(input: unknown): string {
	try {
		return JSON.stringify(input) ?? "";
	} catch {
		return String(input);
	}
}

/** The arguments as the dialog and the log show them: JSON, cut to 200 characters. */
export function mcpArgs(input: unknown): string {
	return clip(mcpJson(input));
}

/** The block when no one can answer the dialog, and the judge's fallback. */
function unansweredMcp(toolName: string): Verdict {
	return {
		level: "deny",
		rule: MCP_RULE,
		reason: `Blocked by the user's bouncer (rule: ${MCP_RULE}): the MCP tool \`${toolName}\` is not on the user's allow list (mcp.allow), and no one can answer the dialog. None of the call ran. Do not retry it through another tool. Tell the user what was blocked and why, and let them decide.`,
		command: toolName,
	};
}

/** The ask's `source` is the tool name, so a session allow covers the tool whatever its arguments. */
export function mcpAsk(toolName: string, input: unknown): Ask {
	return {
		rule: MCP_RULE,
		summary: "an MCP tool not on mcp.allow",
		source: toolName,
		detail: mcpArgs(input),
	};
}

export async function decideMcp(call: McpCall): Promise<Decision> {
	const { toolName } = call;
	if (mcpAllowed(toolName, call.allow)) return { kind: "allow" };
	return decideToolAsk({
		...call,
		command: toolName,
		asks: [mcpAsk(toolName, call.input)],
		fallback: unansweredMcp(toolName),
		judged: call.judge !== undefined,
	});
}
