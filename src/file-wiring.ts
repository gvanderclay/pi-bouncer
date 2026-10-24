import type {
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { FileTool } from "./file-call.ts";
import { decideFile, type FileCall } from "./file-gate.ts";
import type { Decision, Judge } from "./gate.ts";
import type { JudgeSent } from "./history.ts";
import type { FileJudged } from "./judge-request.ts";
import { judgeFor } from "./judge-wiring.ts";
import type { ModeHolder } from "./mode.ts";
import { autoChoiceFor, callFrom, type SessionState } from "./mode-switch.ts";
import { builtInPolicy } from "./rules/built-in-policy.ts";

type FileRuntime = {
	readonly holder: ModeHolder;
	readonly session: SessionState;
	readonly agentDir: string;
	readonly fileAllowed: Set<string>;
};

// In auto mode the judge reads the call's change, unless the path is in a
// secret group (`decideFile`).
export function fileCallIn(
	rt: FileRuntime,
	event: ToolCallEvent,
	tool: FileTool,
	ctx: ExtensionContext,
	onSent: (sent: JudgeSent) => void,
): FileCall {
	const { mode } = rt.holder;
	const { paused } = rt.session.pause;
	const autoChoice = autoChoiceFor(mode, paused, rt.session, ctx);
	const judgeFile: FileCall["judgeFile"] =
		mode === "auto"
			? (command: string, file: FileJudged): Judge =>
					judgeFor(command, ctx, rt.holder, rt.session, onSent, { file })
			: undefined;
	const redecide = (): Promise<Decision> | undefined =>
		rt.holder.mode === mode
			? undefined
			: decideFile(fileCallIn(rt, event, tool, ctx, onSent)).then(
					({ decision }) => decision,
				);
	return {
		...callFrom(ctx, mode, undefined),
		...(autoChoice && { autoChoice }),
		...(judgeFile && { judgeFile }),
		paused,
		redecide,
		tool,
		input: event.input,
		policy: rt.session.config?.policy ?? builtInPolicy,
		agentDir: rt.agentDir,
		allowed: rt.fileAllowed,
	};
}
