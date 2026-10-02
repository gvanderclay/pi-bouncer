import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Ask } from "./ask.ts";
import type { GateConfig } from "./config.ts";
import { errorText } from "./error-text.ts";
import {
	type Remotes,
	readGitState,
	readRemotes,
	remoteFacts,
} from "./facts.ts";
import type { Decision, Judge } from "./gate.ts";
import {
	type JudgeSent,
	recentEarlier,
	type ToolHistory,
	userTexts,
} from "./history.ts";
import { jevStatus } from "./jev.ts";
import { NOT_FOUND, resolveEntry } from "./judge.ts";
import { judgeRequest } from "./judge-request.ts";
import { appendRecord, logFile } from "./log.ts";
import type { GateMode, ModeHolder } from "./mode.ts";
import {
	type Ruling,
	type RulingRegistry,
	ruleLine,
	rulingFailures,
} from "./ruling.ts";

export function recordHead(
	type: "call" | "session" | "yolo" | "auto",
	ctx: ExtensionContext,
): object {
	return {
		v: 1,
		type,
		time: new Date().toISOString(),
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile() ?? null,
		cwd: ctx.cwd,
	};
}

// Logging never changes a decision: a failure is caught and warns once.
export function createLogging(logDir: string): {
	write(ctx: ExtensionContext, writes: () => void): void;
	restart(): void;
} {
	let warned = false;
	return {
		write(ctx: ExtensionContext, writes: () => void): void {
			try {
				writes();
			} catch (error) {
				if (warned || !ctx.hasUI) return;
				warned = true;
				const message = errorText(error);
				ctx.ui.notify(
					`Bouncer could not write its log ${logFile(logDir)}: ${message}`,
					"warning",
				);
			}
		},
		restart(): void {
			warned = false;
		},
	};
}

const STATUS_KEY = "bouncer";
const YOLO_ON =
	"YOLO mode on: every ask is allowed; sudo, shutdown, disk wipes and rm of / or ~ are still denied.";
const YOLO_OFF = "YOLO mode off: the bouncer asks again.";
const YOLO_USAGE = "Usage: /yolo [on|off]";

const AUTO_ON =
	"Auto mode on: a model judges each ask; rule-level denies, sudo, shutdown, disk wipes and rm of / or ~ are still denied.";
const AUTO_OFF = "Auto mode off: the bouncer asks again.";
const AUTO_USAGE = "Usage: /auto [on|off|status]";
const SKILL = "auto-judge-list";

export function showMode(
	holder: ModeHolder,
	session: SessionState,
	ctx: ExtensionContext,
): void {
	if (!ctx.hasUI) return;
	const { theme } = ctx.ui;
	let text: string | undefined;
	if (holder.mode === "yolo") text = theme.bold(theme.fg("error", "🔥 YOLO"));
	if (holder.mode === "auto") {
		text = session.pause.paused
			? theme.fg("warning", "🤖 AUTO (paused)")
			: theme.fg("accent", "🤖 AUTO");
	}
	ctx.ui.setStatus(STATUS_KEY, text);
}

function showJudging(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", "🤖 judging…"));
}

function registryOf(ctx: ExtensionContext): RulingRegistry {
	const registry = (ctx as { modelRegistry?: unknown }).modelRegistry;
	if (registry) return registry as RulingRegistry;
	return {
		find: () => undefined,
		hasConfiguredAuth: () => false,
		streamSimple: () => {
			throw new Error("no model registry");
		},
	};
}

export function autoRefusal(
	config: GateConfig | undefined,
	ctx: ExtensionContext,
): string | undefined {
	const models = config?.auto?.models ?? [];
	if (models.length === 0) {
		return `Auto mode stays off: the route's bouncer config has no judge list (auto.models). The ${SKILL} skill can make one.`;
	}
	const registry = registryOf(ctx);
	const failures: string[] = [];
	for (const entry of models) {
		const resolved = resolveEntry(registry, entry);
		if (typeof resolved !== "string") return undefined;
		failures.push(`${entry}: ${resolved}`);
	}
	return `Auto mode stays off: no judge-list entry resolves (${failures.join("; ")}). The ${SKILL} skill can fix the list.`;
}

function notifyMode(
	mode: GateMode,
	left: GateMode,
	about: Exclude<GateMode, "off">,
	ctx: ExtensionContext,
): void {
	if (!ctx.hasUI) return;
	if (mode === "yolo") ctx.ui.notify(YOLO_ON, "warning");
	else if (mode === "auto") ctx.ui.notify(AUTO_ON, "info");
	else if ((left === "off" ? about : left) === "yolo") {
		ctx.ui.notify(YOLO_OFF, "info");
	} else ctx.ui.notify(AUTO_OFF, "info");
}

export type How = "command" | "dialog" | "flag" | "config";

function requestedOn(args: string, current: boolean): boolean | undefined {
	const arg = args.trim();
	if (arg === "") return !current;
	if (arg === "on") return true;
	if (arg === "off") return false;
	return undefined;
}

export type Logging = ReturnType<typeof createLogging>;

export type ModeSwitch = (
	mode: GateMode,
	how: How,
	about: Exclude<GateMode, "off">,
	ctx: ExtensionContext,
) => void;

// Setting the mode already in force only notifies.
export function createModeSwitch(
	holder: ModeHolder,
	session: SessionState,
	logging: Logging,
	logDir: string,
): ModeSwitch {
	return (
		mode: GateMode,
		how: How,
		about: Exclude<GateMode, "off">,
		ctx: ExtensionContext,
	): void => {
		const left = holder.mode;
		holder.mode = mode;
		if (left !== mode) {
			resetPause(session);
			showMode(holder, session, ctx);
		}
		notifyMode(mode, left, about, ctx);
		if (left === mode) return;
		const turned: (readonly [type: "yolo" | "auto", on: boolean])[] = [];
		if (left !== "off") turned.push([left, false]);
		if (mode !== "off") turned.push([mode, true]);
		logging.write(ctx, () => {
			for (const [type, on] of turned) {
				appendRecord(logDir, { ...recordHead(type, ctx), on, how });
			}
		});
	};
}

const BOTH_FLAGS =
	"Bouncer: --auto and --yolo cannot be used together; the bouncer starts with neither.";

// The flags set only the starting state: the first `session_start` applies them.
export function applyStartFlags(
	pi: ExtensionAPI,
	holder: ModeHolder,
	switchMode: ModeSwitch,
	config: GateConfig,
	ctx: ExtensionContext,
): void {
	if (holder.flagsApplied) return;
	holder.flagsApplied = true;
	const yolo = pi.getFlag("yolo") === true;
	const auto = pi.getFlag("auto") === true;
	if (yolo && auto) {
		if (ctx.hasUI) ctx.ui.notify(BOTH_FLAGS, "error");
		return;
	}
	if (yolo) switchMode("yolo", "flag", "yolo", ctx);
	else if (auto) turnAutoOn(config, "flag", switchMode, ctx);
	else if (config.startMode === "auto") {
		turnAutoOn(config, "config", switchMode, ctx);
	}
}

export function registerYolo(
	pi: ExtensionAPI,
	holder: ModeHolder,
	switchMode: ModeSwitch,
): void {
	pi.registerFlag("yolo", {
		description: "Start with the bouncer's YOLO mode on",
		type: "boolean",
		default: false,
	});
	pi.registerCommand("yolo", {
		description:
			"Bouncer YOLO mode: allow every ask except sudo, shutdown, disk wipes and rm of / or ~ (on, off, or toggle)",
		handler: async (args: string, ctx: ExtensionContext): Promise<void> => {
			const on = requestedOn(args, holder.mode === "yolo");
			if (on === undefined) {
				if (ctx.hasUI) ctx.ui.notify(YOLO_USAGE, "warning");
				return;
			}
			const left = holder.mode === "yolo" ? "off" : holder.mode;
			switchMode(on ? "yolo" : left, "command", "yolo", ctx);
		},
	});
}

export type SessionState = {
	config?: GateConfig;
	readonly history: ToolHistory;
	readonly reported: Set<string>;
	readonly lastFailure: Map<string, string>;
	remotes?: Promise<Remotes>;
	readonly pause: { paused: boolean; inRow: number; total: number };
};

const PAUSE_IN_ROW = 3;
const PAUSE_TOTAL = 20;

export function resetPause(session: SessionState): void {
	Object.assign(session.pause, { paused: false, inRow: 0, total: 0 });
}

export function trackPause(
	decision: Decision,
	holder: ModeHolder,
	session: SessionState,
	ctx: ExtensionContext,
): void {
	const { pause } = session;
	// A dropped verdict was never acted on: the switch reset the brakes.
	if (decision.trace?.auto?.discarded) return;
	const verdict = decision.trace?.auto?.verdict;
	if (verdict === "allow") pause.inRow = 0;
	if (verdict === "deny") {
		pause.inRow += 1;
		pause.total += 1;
		if (pause.inRow < PAUSE_IN_ROW && pause.total < PAUSE_TOTAL) return;
		pause.paused = true;
		showMode(holder, session, ctx);
	}
	if (verdict === "paused" && decision.kind === "allow") {
		pause.paused = false;
		pause.inRow = 0;
		showMode(holder, session, ctx);
	}
}

function notifyFailures(
	result: Ruling,
	session: SessionState,
	ctx: ExtensionContext,
): void {
	const tried = rulingFailures(result);
	for (const { model, error } of tried) session.lastFailure.set(model, error);
	const fresh = tried.filter(({ model }) => !session.reported.has(model));
	for (const { model } of fresh) session.reported.add(model);
	if (!ctx.hasUI || fresh.length === 0) return;
	if (result.kind === "none") {
		const all = tried.map(({ model, error }) => `${model}: ${error}`);
		ctx.ui.notify(
			`Auto: no judge available (${all.join("; ")}). The ${SKILL} skill can fix the list.`,
			"warning",
		);
		return;
	}
	for (const { model, error } of fresh) {
		const gone =
			error === NOT_FOUND
				? `; it is not in Pi's model catalogue. The ${SKILL} skill can fix the list.`
				: "";
		ctx.ui.notify(
			`Auto: ${model} unavailable, using ${result.model}${gone}`,
			"warning",
		);
	}
}

function listed(heading: string, items: readonly string[]): string[] {
	if (items.length === 0) return [`${heading}: none`];
	return [`${heading}:`, ...items.map((item) => `- ${item}`)];
}

async function autoStatus(
	holder: ModeHolder,
	session: SessionState,
	ctx: ExtensionContext,
): Promise<string> {
	const paused = holder.mode === "auto" && session.pause.paused;
	const auto = session.config?.auto;
	const models = auto?.models ?? [];
	const registry = registryOf(ctx);
	const entries = models.map((entry) => {
		const resolved = resolveEntry(registry, entry);
		return `${entry}: ${typeof resolved === "string" ? resolved : "resolves"}`;
	});
	const failures = [...session.lastFailure].map(
		([model, error]) => `${model}: ${error}`,
	);
	const provider = ctx.model?.provider;
	const firsts = Object.entries(auto?.firstByProvider ?? {}).map(
		([key, entry]) =>
			`${key}: ${entry}${key === provider ? " (this session)" : ""}`,
	);
	const alwaysAsk = auto?.alwaysAsk ?? [];
	const facts = auto?.environment.length ?? 0;
	return [
		`Bouncer auto mode: ${holder.mode} (paused: ${paused ? "yes" : "no"})`,
		await jevStatus(auto?.jev, registry),
		...(models.length === 0
			? [`Judge list: none. The ${SKILL} skill can make one.`]
			: listed("Judge list", entries)),
		...(firsts.length === 0 ? [] : listed("First by provider", firsts)),
		...listed("Last failures this session", failures),
		`Always ask: ${alwaysAsk.length === 0 ? "none" : alwaysAsk.join(", ")}`,
		`${facts} environment fact${facts === 1 ? "" : "s"}`,
	].join("\n");
}

function turnAutoOn(
	config: GateConfig | undefined,
	how: How,
	switchMode: ModeSwitch,
	ctx: ExtensionContext,
): void {
	const refusal = autoRefusal(config, ctx);
	if (refusal === undefined) switchMode("auto", how, "auto", ctx);
	else if (ctx.hasUI) ctx.ui.notify(refusal, "warning");
}

async function autoCommand(
	args: string,
	holder: ModeHolder,
	switchMode: ModeSwitch,
	session: SessionState,
	ctx: ExtensionContext,
): Promise<void> {
	if (args.trim() === "status") {
		const text = await autoStatus(holder, session, ctx);
		if (ctx.hasUI) ctx.ui.notify(text, "info");
		return;
	}
	const on = requestedOn(args, holder.mode === "auto");
	if (on === undefined) {
		if (ctx.hasUI) ctx.ui.notify(AUTO_USAGE, "warning");
	} else if (on) {
		turnAutoOn(session.config, "command", switchMode, ctx);
	} else {
		const left = holder.mode === "auto" ? "off" : holder.mode;
		switchMode(left, "command", "auto", ctx);
	}
}

export function registerAuto(
	pi: ExtensionAPI,
	holder: ModeHolder,
	switchMode: ModeSwitch,
	session: SessionState,
): void {
	pi.registerFlag("auto", {
		description: "Start with the bouncer's auto mode on",
		type: "boolean",
		default: false,
	});
	pi.registerCommand("auto", {
		description:
			"Bouncer auto mode: a model from the route's judge list rules on each ask (on, off, status, or toggle)",
		handler: async (args: string, ctx: ExtensionContext): Promise<void> =>
			autoCommand(args, holder, switchMode, session, ctx),
	});
}

export function judgeFor(
	command: string,
	ctx: ExtensionContext,
	holder: ModeHolder,
	session: SessionState,
	onSent: (sent: JudgeSent) => void = () => {},
): Judge {
	return async (asks: readonly Ask[]): Promise<Ruling> => {
		// A result that lands while Jev or the judge list is out reaches neither:
		// recording never changes an entry, so a shallow copy is a snapshot,
		// taken before the first await. `judgeRequest` applies the budgets.
		const history = [...session.history.entries];
		showJudging(ctx);
		try {
			const { cwd } = ctx;
			const [git, now, snapshot] = await Promise.all([
				readGitState(cwd),
				readRemotes(cwd),
				session.remotes ?? new Map<string, string>(),
			]);
			const texts = userTexts(ctx.sessionManager.getBranch?.() ?? []);
			// An empty last message gives no user_message: no fallback.
			const userMessage = texts.at(-1);
			const earlier = recentEarlier(
				texts.slice(0, -1).filter((text) => text !== ""),
			);
			const environment = session.config?.auto?.environment ?? [];
			const request = judgeRequest({
				command,
				asks,
				cwd,
				git,
				remotes: remoteFacts(snapshot, now),
				environment,
				earlierUserMessages: earlier,
				history,
				...(userMessage && { userMessage }),
			});
			onSent({
				history: request.history?.length ?? 0,
				earlierMessages: request.earlierUserMessages?.length ?? 0,
			});
			const run = {
				registry: registryOf(ctx),
				sessionId: ctx.sessionManager.getSessionId(),
				...(ctx.signal && { signal: ctx.signal }),
			};
			const auto = session.config?.auto;
			const result = await ruleLine(request, auto, ctx.model?.provider, run);
			notifyFailures(result, session, ctx);
			return result;
		} finally {
			showMode(holder, session, ctx);
		}
	};
}
