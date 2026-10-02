import { homedir } from "node:os";
import type {
	BashToolCallEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	MessageEndEventResult,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { agentDir as defaultAgentDir } from "./agent-dir.ts";
import { AUTO_CHOICE, RESUME_AUTO_CHOICE } from "./ask.ts";
import { configRecord, type GateConfig, loadConfig } from "./config.ts";
import { readRemotes } from "./facts.ts";
import {
	type Call,
	createGate,
	type Decision,
	type Judge,
	type ParseFn,
} from "./gate.ts";
import {
	absolutePath,
	clearHistory,
	createHistory,
	type HistoryEntry,
	type JudgeSent,
	recordEntry,
} from "./history.ts";
import {
	appendRecord,
	defaultLogDir,
	pruneByAge,
	rotateIfNeeded,
} from "./log.ts";
import { type GateMode, type ModeHolder, processModeHolder } from "./mode.ts";
import {
	applyStartFlags,
	autoRefusal,
	createLogging,
	createModeSwitch,
	judgeFor,
	type Logging,
	type ModeSwitch,
	recordHead,
	registerAuto,
	registerYolo,
	resetPause,
	type SessionState,
	showMode,
	trackPause,
} from "./mode-switch.ts";
import { builtInPolicy } from "./rules/built-in-policy.ts";
import { registerSessionLaunch } from "./session-launch.ts";

export type ParserLoader = () => Promise<ParseFn>;

async function loadUnbash(): Promise<ParseFn> {
	const { parse } = await import("unbash");
	return parse;
}

// Pi's isToolCallEventType is a runtime export; the bouncer imports Pi types only.
function isBash(event: ToolCallEvent): event is BashToolCallEvent {
	return event.toolName === "bash";
}

async function tryLoad(loadParser: ParserLoader): Promise<ParseFn | undefined> {
	try {
		return await loadParser();
	} catch {
		return undefined;
	}
}

// The UI and signal reach the bouncer only when someone can answer a dialog.
function callFrom(
	ctx: ExtensionContext,
	mode: GateMode,
	judge: Judge | undefined,
): Call {
	const where = {
		cwd: ctx.cwd,
		home: homedir(),
		mode,
		...(judge && { judge }),
	};
	if (!ctx.hasUI) return where;
	return ctx.signal
		? { ...where, ui: ctx.ui, signal: ctx.signal }
		: { ...where, ui: ctx.ui };
}

function callRecord(
	command: string,
	decision: Decision,
	ctx: ExtensionContext,
	sent: JudgeSent | undefined,
): object | undefined {
	const { trace } = decision;
	if (!trace) return undefined;
	const head = { ...recordHead("call", ctx), command, ui: trace.ui };
	const { matches, asks } = trace;
	// Only a decision YOLO or auto mode made carries its fields; only a call
	// a judge was asked about carries the counts of what it was sent.
	const mode = {
		...(trace.yolo && { yolo: true, withoutYolo: trace.yolo.withoutYolo }),
		...(trace.auto && { auto: { ...trace.auto, ...(sent && { sent }) } }),
		...(trace.withoutAuto && { withoutAuto: trace.withoutAuto }),
	};
	if (decision.kind === "allow") {
		return { ...head, outcome: "allowed", matches, asks, ...mode };
	}
	const outcome = decision.stop ? "stopped" : "blocked";
	const { reason } = decision;
	return { ...head, outcome, reason, matches, asks, ...mode };
}

// Pi records a call aborted after `tool_call` as "Operation aborted" and drops
// the block reason, so the result is rewritten to say why the turn ended.
function restoreStopReason(
	stopped: Map<string, string>,
	{ message }: MessageEndEvent,
): MessageEndEventResult | undefined {
	if (message.role !== "toolResult") return undefined;
	const reason = stopped.get(message.toolCallId);
	if (reason === undefined) return undefined;
	stopped.delete(message.toolCallId);
	return { message: { ...message, content: [{ type: "text", text: reason }] } };
}

function warnAboutConfig(config: GateConfig, ctx: ExtensionContext): void {
	if (config.problems.length === 0 || !ctx.hasUI) return;
	const lines = config.problems.map((problem) => `- ${problem}`);
	ctx.ui.notify(
		`Bouncer config problems; these parts are ignored:\n${lines.join("\n")}`,
		"warning",
	);
}

type Runtime = {
	readonly pi: ExtensionAPI;
	readonly gate: ReturnType<typeof createGate>;
	readonly parser: ParseFn | undefined;
	readonly holder: ModeHolder;
	readonly session: SessionState;
	readonly logging: Logging;
	readonly logDir: string;
	readonly agentDir: string;
	readonly switchMode: ModeSwitch;
	readonly stopped: Map<string, string>;
};

// Nothing outlives a session but the bouncer mode. A reloaded runtime starts
// with no status, so it is set again.
function startSession(
	rt: Runtime,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): void {
	const { holder, logging, logDir } = rt;
	logging.restart();
	resetPause(rt.session);
	// The flags need the config: `--auto` checks the judge list.
	const config = loadConfig(rt.agentDir, {
		cwd: ctx.cwd,
		trusted: ctx.isProjectTrusted(),
	});
	rt.session.config = config;
	applyStartFlags(rt.pi, holder, rt.switchMode, config, ctx);
	showMode(holder, rt.session, ctx);
	rt.session.reported.clear();
	rt.session.lastFailure.clear();
	clearHistory(rt.session.history);
	if (config.auto) rt.session.remotes = readRemotes(ctx.cwd);
	else delete rt.session.remotes;
	rt.gate.reset(config.policy);
	warnAboutConfig(config, ctx);
	rt.stopped.clear();
	logging.write(ctx, () => {
		rotateIfNeeded(logDir, config.log);
		pruneByAge(logDir, config.log.maxAgeDays);
		appendRecord(logDir, {
			...recordHead("session", ctx),
			reason: event.reason,
			parser: rt.parser !== undefined,
			config: configRecord(config),
			yolo: holder.mode === "yolo",
			auto: holder.mode === "auto",
		});
	});
}

function autoChoiceFor(
	mode: GateMode,
	paused: boolean,
	session: SessionState,
	ctx: ExtensionContext,
): string | undefined {
	if (!ctx.hasUI || (mode === "auto" && !paused)) return undefined;
	if (autoRefusal(session.config, ctx) !== undefined) return undefined;
	return mode === "auto" ? RESUME_AUTO_CHOICE : AUTO_CHOICE;
}

function callIn(
	rt: Runtime,
	command: string,
	ctx: ExtensionContext,
	onSent?: (sent: JudgeSent) => void,
): Call {
	const { mode } = rt.holder;
	const judge =
		mode === "auto"
			? judgeFor(command, ctx, rt.holder, rt.session, onSent)
			: undefined;
	const alwaysAsk = rt.session.config?.auto?.alwaysAsk ?? [];
	const { paused } = rt.session.pause;
	const autoChoice = autoChoiceFor(mode, paused, rt.session, ctx);
	const redecide = (): Promise<Decision> | undefined =>
		rt.holder.mode === mode
			? undefined
			: rt.gate.decide(command, callIn(rt, command, ctx, onSent));
	return {
		...callFrom(ctx, mode, judge),
		alwaysAsk,
		paused,
		redecide,
		...(autoChoice && { autoChoice }),
	};
}

async function decideCall(
	rt: Runtime,
	event: ToolCallEvent,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	if (!isBash(event)) return undefined;
	const { command } = event.input;
	let sent: JudgeSent | undefined;
	const onSent = (counts: JudgeSent): void => {
		sent = counts;
	};
	const call = callIn(rt, command, ctx, onSent);
	const outcome = await rt.gate.decide(command, call);
	rt.logging.write(ctx, () => {
		const record = callRecord(command, outcome, ctx, sent);
		if (record) appendRecord(rt.logDir, record);
	});
	trackPause(outcome, rt.holder, rt.session, ctx);
	if (outcome.yoloOn) rt.switchMode("yolo", "dialog", "yolo", ctx);
	if (outcome.autoOn && rt.holder.mode !== "auto") {
		rt.switchMode("auto", "dialog", "auto", ctx);
	}
	if (outcome.kind === "allow") return undefined;
	if (outcome.stop) {
		rt.stopped.set(event.toolCallId, outcome.reason);
		// Never awaited: abort() waits for idle, which cannot come while this
		// handler runs. `terminate` would be ignored unless the whole batch set it.
		ctx.abort();
	}
	if (outcome.warning && ctx.hasUI) ctx.ui.notify(outcome.warning, "warning");
	return { block: true, reason: outcome.reason };
}

// Reads only the command and path, never output or content.
function recordResult(
	rt: Runtime,
	event: ToolResultEvent,
	ctx: ExtensionContext,
): undefined {
	const { toolName } = event;
	const { command, path, background } = event.input as {
		readonly command?: unknown;
		readonly path?: unknown;
		readonly background?: unknown;
	};
	const { cwd } = ctx;
	const marks = event.isError ? { failed: true as const } : {};
	let entry: HistoryEntry | undefined;
	if (toolName === "bash" && typeof command === "string") {
		const detached = background === true && { background: true as const };
		entry = { tool: "bash", text: command, cwd, ...marks, ...detached };
	} else if (
		(toolName === "write" || toolName === "edit") &&
		typeof path === "string"
	) {
		const text = absolutePath(path, cwd, homedir());
		entry = { tool: toolName, text, cwd, ...marks };
	}
	if (entry) recordEntry(rt.session.history, entry);
	return undefined;
}

export default async function bouncer(
	pi: ExtensionAPI,
	loadParser: ParserLoader = loadUnbash,
	logDir: string = defaultLogDir(),
	agentDir: string = defaultAgentDir(),
	holder: ModeHolder = processModeHolder(),
): Promise<void> {
	const parser = await tryLoad(loadParser);
	const logging = createLogging(logDir);
	const session: SessionState = {
		reported: new Set(),
		lastFailure: new Map(),
		history: createHistory(),
		pause: { paused: false, inRow: 0, total: 0 },
	};
	const rt: Runtime = {
		pi,
		gate: createGate(parser, builtInPolicy),
		parser,
		holder,
		session,
		logging,
		logDir,
		agentDir,
		switchMode: createModeSwitch(holder, session, logging, logDir),
		stopped: new Map<string, string>(),
	};
	registerYolo(pi, holder, rt.switchMode);
	registerAuto(pi, holder, rt.switchMode, rt.session);
	registerSessionLaunch(pi, holder);
	pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) =>
		startSession(rt, event, ctx),
	);
	pi.on(
		"message_end",
		(event: MessageEndEvent): MessageEndEventResult | undefined =>
			restoreStopReason(rt.stopped, event),
	);
	pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) =>
		decideCall(rt, event, ctx),
	);
	pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) =>
		recordResult(rt, event, ctx),
	);
}
