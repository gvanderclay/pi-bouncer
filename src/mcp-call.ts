import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { Decision } from "./gate.ts";
import { cut, type JudgeSent } from "./history.ts";
import { judgeFor } from "./judge-wiring.ts";
import { decideMcp, type McpCall } from "./mcp-gate.ts";
import type { ModeHolder } from "./mode.ts";
import { autoChoiceFor, callFrom, type SessionState } from "./mode-switch.ts";

const DESCRIPTION_CHARS = 2_000;

function wholeJson(input: unknown): string | undefined {
	try {
		return JSON.stringify(input) ?? "";
	} catch {
		return undefined;
	}
}

type McpRuntime = {
	readonly pi: ExtensionAPI;
	readonly holder: ModeHolder;
	readonly session: SessionState;
	readonly mcpAllowed: Set<string>;
};

/**
 * An MCP call as `decideMcp` takes it. Only when the judge will be asked is the
 * tool's description looked up; the judge gets the whole arguments.
 */
export function mcpCallIn(
	rt: McpRuntime,
	event: ToolCallEvent,
	ctx: ExtensionContext,
	onSent: (sent: JudgeSent) => void,
): McpCall {
	const { mode } = rt.holder;
	const { toolName, input } = event;
	const args = wholeJson(input);
	// Arguments that don't serialise can't be shown to the judge, so they get the dialog.
	const judging =
		mode === "auto" &&
		rt.session.config?.mcp?.judge !== false &&
		args !== undefined;
	let judge: McpCall["judge"];
	if (judging) {
		const found = rt.pi.getAllTools().find((tool) => tool.name === toolName);
		const description = found?.description
			? cut(found.description, DESCRIPTION_CHARS)
			: undefined;
		judge = judgeFor(args, ctx, rt.holder, rt.session, onSent, {
			mcp: { tool: toolName, ...(description && { description }) },
		});
	}
	const paused = judging && rt.session.pause.paused;
	const autoChoice = autoChoiceFor(mode, paused, rt.session, ctx);
	const redecide = (): Promise<Decision> | undefined =>
		rt.holder.mode === mode
			? undefined
			: decideMcp(mcpCallIn(rt, event, ctx, onSent));
	return {
		...callFrom(ctx, mode, judge),
		toolName,
		input,
		allow: rt.session.config?.mcp?.allow ?? [],
		allowed: rt.mcpAllowed,
		paused,
		redecide,
		...(autoChoice && { autoChoice }),
	};
}
