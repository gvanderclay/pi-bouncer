// MCP tool calls (`mcp__<server>__<tool>`) have no shell string to rule on:
// an allow-listed tool runs, every other one asks. Tool annotations
// (readOnlyHint and the rest) are the server's unverified claims, so they
// never allow a call.
import {
	type Ask,
	type Asking,
	type AskUI,
	allSessionAllowed,
	askUser,
	yoloAnswers,
} from "./ask.ts";
import type { Decision, Trace, WithoutYolo } from "./gate.ts";
import { isObject } from "./json.ts";
import type { GateMode } from "./mode.ts";
import { clip } from "./verdict.ts";

const MCP_RULE = "mcp";

export type McpSettings = {
	/** Tool-name patterns, normalised as Pi names MCP tools; `*` matches anything. */
	readonly allow: readonly string[];
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

export function validMcp(
	value: unknown,
	problems: string[],
): McpSettings | undefined {
	if (!isObject(value)) {
		problems.push('"mcp" is not an object');
		return undefined;
	}
	let allow: string[] = [];
	for (const [key, list] of Object.entries(value)) {
		if (key !== "allow") problems.push(`mcp: unknown key "${key}"`);
		else if (
			Array.isArray(list) &&
			list.every((p) => typeof p === "string" && p.startsWith("mcp__"))
		) {
			allow = list.map(normalised);
		} else {
			problems.push(
				'mcp.allow must be a list of tool names starting with "mcp__", such as "mcp__github__*"',
			);
		}
	}
	return { allow };
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

export type McpCall = {
	readonly toolName: string;
	readonly input: unknown;
	readonly cwd: string;
	readonly mode: GateMode;
	readonly allow: readonly string[];
	/** Session allows, keyed per tool; cleared at each session start. */
	readonly allowed: Set<string>;
	readonly ui?: AskUI;
	readonly signal?: AbortSignal;
	readonly autoChoice?: string;
};

/** An MCP call's arguments as the dialog and the log show them: JSON, cut to 200 characters. */
export function mcpArgs(input: unknown): string {
	try {
		return clip(JSON.stringify(input) ?? "");
	} catch {
		return clip(String(input));
	}
}

/** The block when no one can answer the dialog. */
function unansweredMcp(toolName: string): string {
	return `Blocked by the user's bouncer (rule: ${MCP_RULE}): the MCP tool \`${toolName}\` is not on the user's allow list (mcp.allow), and no one can answer the dialog. None of the call ran. Do not retry it through another tool. Tell the user what was blocked and why, and let them decide.`;
}

/** The ask's `source` is the tool name, so a session allow covers the tool whatever its arguments. */
function mcpAsk(toolName: string, input: unknown): Ask {
	return {
		rule: MCP_RULE,
		summary: "an MCP tool not on mcp.allow",
		source: toolName,
		detail: mcpArgs(input),
	};
}

export async function decideMcp(call: McpCall): Promise<Decision> {
	const { toolName, mode, ui } = call;
	if (mcpAllowed(toolName, call.allow)) return { kind: "allow" };
	const ask = mcpAsk(toolName, call.input);
	const asking: Asking = {
		command: toolName,
		cwd: call.cwd,
		allowed: call.allowed,
		...(call.signal && { signal: call.signal }),
		...(call.autoChoice && { autoChoice: call.autoChoice }),
	};
	let without: WithoutYolo = "blocked";
	if (ui) without = allSessionAllowed([ask], asking) ? "allowed" : "dialog";
	const trace: Trace = {
		matches: [],
		ui: ui !== undefined,
		asks: [],
		...(mode === "yolo" && { yolo: { withoutYolo: without } }),
		// Auto mode asks no judge about an MCP call: like an auto.alwaysAsk
		// line, it opens the dialog.
		...(mode === "auto" && { withoutAuto: without }),
	};
	if (mode === "yolo") {
		return {
			kind: "allow",
			trace: { ...trace, asks: yoloAnswers([ask], asking) },
		};
	}
	if (!ui) {
		const reason = unansweredMcp(toolName);
		return { kind: "block", reason, stop: false, trace };
	}
	const asked = await askUser([ask], ui, asking);
	return {
		...asked.outcome,
		trace: { ...trace, asks: asked.answers },
		...(asked.yoloOn && { yoloOn: true }),
		...(asked.autoOn && { autoOn: true }),
	};
}
