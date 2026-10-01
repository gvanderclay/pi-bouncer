/**
 * Bouncer: catches a short, fixed list of dangerous bash actions for
 * the scratch route and lets every other tool call run untouched. Each rule's
 * built-in level lives in `rules/built-in-policy.ts`:
 * recoverable-if-intended actions ask the user (Allow once, Allow for this
 * session, Deny, Deny with reason, Deny and stop, 🤖 Auto mode, ⚠️ Allow all
 * (YOLO)), and
 * catastrophic or unreadable ones are denied with a warning, among them
 * `rm-root`: a recursive rm of `/`, a system directory, the home directory or
 * an important folder in it. A deny anywhere on a line wins; without a UI
 * every match denies. Session allows are in memory and cleared on every
 * `session_start`.
 *
 * Steer rule: `grep` (`rules/grep.ts`) blocks every grep, egrep or fgrep
 * the scan finds and sends the model to `rg`, in every bouncer mode, with no
 * dialog, judge call or warning; each block is logged. Its level is fixed. A
 * real deny on the same line wins; the grep block wins over every ask. It
 * moves to a custom rule once the bouncer config supports them.
 *
 * Bouncer mode: off, auto or YOLO, one process-wide setting (`mode.ts`); turning
 * one on leaves the other. `mode-switch.ts` holds the one switch path, the
 * commands, the flags, the footer status and the judge's Pi wiring.
 *
 * YOLO mode: `/yolo` (toggle, `on`, `off`), the dialog's "Allow all (YOLO)"
 * and `pi --yolo` turn it on; it then answers every ask with allow, with or
 * without a UI, and no dialog opens. The always-deny set (`privilege`,
 * `power`, `disk-format`, `dd-device`, `rm-root`, fixed in
 * `rules/built-in-policy.ts`), the unreadable-command denies and the steer
 * rule still deny, whatever the bouncer config's levels say. It is process-wide and in memory
 * only (`mode.ts`, on `globalThis` so it survives `/reload`), survives every
 * `session_start`, and ends with the process; `--yolo` applies only at the
 * process's first `session_start`. The footer shows a bold red `🔥 YOLO`
 * while it is on.
 * The model is never told: a deny reads as any other hard deny.
 *
 * Auto mode: `/auto` (toggle, `on`, `off`, `status`), the dialog's "🤖 Auto
 * mode" and `pi --auto` turn it on, only when an entry of the route's judge
 * list (`auto.models` in the route's bouncer config; no default in code)
 * resolves in Pi's model registry; `--auto` with `--yolo` is an error.
 * Without either flag the route's `startMode: "auto"` turns it on at the
 * process's first `session_start`, refusing the same way. It
 * has YOLO mode's lifetime. Every ask no session allow covers goes, one call
 * per line, to the judge (`judge.ts`): the first list entry that answers,
 * each within 10 s and the line within 20 s. The route's
 * `auto.firstByProvider` moves the session model's provider's entry to the
 * front of the list for that call. It sees the command, the asks,
 * the cwd, git branch and remotes (`facts.ts`), the user's last message and
 * the route's `auto.environment` facts, never tool output. Allow runs the
 * line quietly; deny (or a provider's usage-policy refusal) blocks it in the
 * hard-deny form with the judge's reason;
 * a hand-off, or no judge answering, opens the dialog (blocks without a UI).
 * Rule-level denies, the always-deny set, the unreadable-command denies and
 * the steer rule are denied before any judge is asked, and the route's
 * `auto.alwaysAsk` prefixes (`always-ask.ts`) open the dialog unless the
 * steer rule blocks the line. Three judge denies in a
 * row, or 20 in a session, pause it: calls go to the dialog until one is
 * allowed. A mode switch while the judge is out drops its verdict and the
 * new mode decides. The footer shows `🤖 AUTO`, `🤖 AUTO (paused)` or
 * `🤖 judging…`. The bundled `auto-judge-list` skill picks the list.
 *
 * Bouncer config: at every `session_start`, `config.ts` reads the route's
 * `<agent dir>/bouncer.json` and the project's
 * `<cwd>/.pi/bouncer.json` (plain JSON; the project overrides the
 * route entry by entry). `levels` sets any built-in rule to ask or deny (the
 * unreadable-command denies and the steer rule stay deny); the route's `log`
 * sets the log's rotation size, generations kept and age pruning, and the route's `auto`
 * sets auto mode's `models`, `alwaysAsk`, `environment` and
 * `firstByProvider`, and the route's `startMode` (`off` or `auto`) the mode
 * a process starts in without a flag (all three are ignored,
 * with a warning, in a project file). An invalid part falls
 * back to its built-in value, and one warning lists every problem. Before
 * the first `session_start` the built-in levels apply.
 *
 * This file only translates the bouncer's outcome for Pi; `gate.ts` decides.
 *
 * Bouncer log: every call the bouncer does more than let through (a hard deny, a
 * no-UI deny, a dialog and its answers, a session-allow hit, a call YOLO
 * mode allowed, a call auto mode decided), every bouncer mode switch and every
 * session start append one
 * JSON line to the route's own `<agent dir>/bouncer/log.jsonl` (or
 * `$PI_BOUNCER_LOG_DIR`), written here in `tool_call`,
 * `session_start` and the mode switch through `log.ts`. Its location never
 * depends on the bouncer config. It rotates into gzipped
 * generations and prunes old ones at session start, within the config's
 * limits, and a write failure never changes a decision. The bundled
 * `bouncer-debug` skill (`skills/bouncer-debug/SKILL.md`)
 * explains how to read it, and `explain.ts` replays a command through the
 * bouncer under the same config, with a UI, without one, in YOLO mode and in
 * auto mode (without calling a judge).
 *
 * Requires: `pnpm install` in this directory, once per machine.
 *
 * History: the design notes (design.md and the spec*.md files) lived in
 * .scratch/permission-gate/ and are now in git history.
 */

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

/** The `call` record for a decision, or `undefined` when no rule matched. */
function callRecord(
	command: string,
	decision: Decision,
	ctx: ExtensionContext,
): object | undefined {
	const { trace } = decision;
	if (!trace) return undefined;
	const head = { ...recordHead("call", ctx), command, ui: trace.ui };
	const { matches, asks } = trace;
	// Only a decision YOLO or auto mode made carries its fields.
	const mode = {
		...(trace.yolo && { yolo: true, withoutYolo: trace.yolo.withoutYolo }),
		...(trace.auto && { auto: trace.auto }),
		...(trace.withoutAuto && { withoutAuto: trace.withoutAuto }),
	};
	if (decision.kind === "allow") {
		return { ...head, outcome: "allowed", matches, asks, ...mode };
	}
	const outcome = decision.stop ? "stopped" : "blocked";
	const { reason } = decision;
	return { ...head, outcome, reason, matches, asks, ...mode };
}

/**
 * Pi records a call aborted after `tool_call` as "Operation aborted" and
 * drops the block reason, so the stopped call's result is rewritten as it is
 * finalized: the model then reads why the turn ended.
 */
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

/** One warning listing every bouncer config problem, when a UI can show it. */
function warnAboutConfig(config: GateConfig, ctx: ExtensionContext): void {
	if (config.problems.length === 0 || !ctx.hasUI) return;
	const lines = config.problems.map((problem) => `- ${problem}`);
	ctx.ui.notify(
		`Bouncer config problems; these parts are ignored:\n${lines.join("\n")}`,
		"warning",
	);
}

/** Everything one bouncer runtime shares between its handlers. */
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
	/** Stopped calls whose recorded result still needs the bouncer's reason. */
	readonly stopped: Map<string, string>;
};

// Nothing outlives a session but the bouncer mode: startup, reload, new, resume,
// fork. A reloaded runtime starts with no status, so it is set again.
function startSession(
	rt: Runtime,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): void {
	const { holder, logging, logDir } = rt;
	logging.restart();
	resetPause(rt.session);
	// The flags need the config: `--auto` checks the judge list.
	const config = loadConfig(rt.agentDir, ctx.cwd);
	rt.session.config = config;
	applyStartFlags(rt.pi, holder, rt.switchMode, config, ctx);
	showMode(holder, rt.session, ctx);
	rt.session.reported.clear();
	rt.session.lastFailure.clear();
	// Only a route with a judge list can use the snapshot.
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

/**
 * The dialog's auto-mode choice: offered when the judge list has an entry
 * that resolves, labelled as resuming while auto mode is paused, and hidden
 * while auto mode is on and not paused.
 */
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

/**
 * The call in the bouncer mode now in force. A mode switch while its judge is
 * out has the bouncer decide it again, in the new mode.
 */
function callIn(rt: Runtime, command: string, ctx: ExtensionContext): Call {
	const { mode } = rt.holder;
	const judge =
		mode === "auto" ? judgeFor(command, ctx, rt.holder, rt.session) : undefined;
	const alwaysAsk = rt.session.config?.auto?.alwaysAsk ?? [];
	const { paused } = rt.session.pause;
	const autoChoice = autoChoiceFor(mode, paused, rt.session, ctx);
	const redecide = (): Promise<Decision> | undefined =>
		rt.holder.mode === mode
			? undefined
			: rt.gate.decide(command, callIn(rt, command, ctx));
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
	const outcome = await rt.gate.decide(command, callIn(rt, command, ctx));
	rt.logging.write(ctx, () => {
		const record = callRecord(command, outcome, ctx);
		if (record) appendRecord(rt.logDir, record);
	});
	trackPause(outcome, rt.holder, rt.session, ctx);
	if (outcome.yoloOn) rt.switchMode("yolo", "dialog", "yolo", ctx);
	// While paused, picking the choice resumed auto mode through trackPause.
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
	// A launched child session takes the current bouncer mode through this hook.
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
}
