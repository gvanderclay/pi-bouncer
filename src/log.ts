import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentDir } from "./agent-dir.ts";
import type { AskAnswer } from "./ask.ts";
import type { ConfigRecord, GateConfig } from "./config.ts";
import { errorText } from "./error-text.ts";
import type { AutoTrace, Decision, WithoutYolo } from "./gate.ts";
import type { JudgeSent } from "./history.ts";
import type { Match } from "./rank.ts";

const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

export type RotationLimits = {
	readonly rotateAboveMiB: number;
	readonly generations: number;
};

// Never depends on the bouncer config.
export function defaultLogDir(): string {
	const { PI_BOUNCER_LOG_DIR } = process.env;
	return PI_BOUNCER_LOG_DIR || join(agentDir(), "bouncer");
}

export function logFile(dir: string): string {
	return join(dir, "log.jsonl");
}

export type How = "command" | "dialog" | "flag" | "config";

type RecordHead<T extends "call" | "session" | "yolo" | "auto"> = {
	readonly v: 1;
	readonly type: T;
	readonly time: string;
	readonly sessionId: string;
	readonly sessionFile: string | null;
	readonly cwd: string;
};

export type SessionRecord = RecordHead<"session"> & {
	readonly reason: string;
	readonly parser: boolean;
	readonly config: ConfigRecord;
	readonly yolo?: boolean;
	readonly auto?: boolean;
};

export type CallRecord = RecordHead<"call"> & {
	readonly command: string;
	readonly ui: boolean;
	readonly outcome: "allowed" | "blocked" | "stopped";
	readonly matches: readonly Match[];
	readonly asks: readonly AskAnswer[];
	readonly reason?: string;
	readonly agent?: string;
	readonly profile?: string;
	readonly yolo?: true;
	readonly withoutYolo?: WithoutYolo;
	readonly auto?: AutoTrace & { readonly sent?: JudgeSent };
	readonly withoutAuto?: WithoutYolo;
};

export type ModeRecord = RecordHead<"yolo" | "auto"> & {
	readonly on: boolean;
	readonly how: How;
};

export type LogRecord = SessionRecord | CallRecord | ModeRecord;

export function recordHead<T extends "call" | "session" | "yolo" | "auto">(
	type: T,
	ctx: ExtensionContext,
): RecordHead<T> {
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

export type Logging = ReturnType<typeof createLogging>;

export function callRecord(
	command: string,
	decision: Decision,
	ctx: ExtensionContext,
	sent: JudgeSent | undefined,
	profile: GateConfig["profile"],
): CallRecord | undefined {
	const { trace } = decision;
	if (!trace) return undefined;
	const who =
		profile?.state === "profile"
			? { agent: profile.agent.name, profile: profile.name }
			: {};
	const head = { ...recordHead("call", ctx), command, ui: trace.ui, ...who };
	const { matches, asks } = trace;
	// Only a decision YOLO or auto mode made carries its fields; only a call
	// a judge was asked about carries the counts of what it was sent.
	const mode = {
		...(trace.yolo && {
			yolo: true as const,
			withoutYolo: trace.yolo.withoutYolo,
		}),
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

export function appendRecord(dir: string, record: LogRecord): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	appendFileSync(logFile(dir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function generation(dir: string, n: number): string {
	return join(dir, `log.${n}.jsonl.gz`);
}

function sizeOf(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function generationsIn(dir: string): { n: number; path: string }[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return names.flatMap((name) => {
		const match = /^log\.(\d+)\.jsonl\.gz$/.exec(name);
		return match ? [{ n: Number(match[1]), path: join(dir, name) }] : [];
	});
}

function removeIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

// The first step renames the log to a name only this process uses, so of two
// processes starting at once only one rotates it.
export function rotateIfNeeded(dir: string, limits: RotationLimits): void {
	const log = logFile(dir);
	if (sizeOf(log) <= limits.rotateAboveMiB * MIB) return;
	const claimed = join(dir, `log.${process.pid}.${Date.now()}.rotating`);
	try {
		renameSync(log, claimed);
	} catch (error) {
		// Another process renamed it first.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const kept = limits.generations;
	for (const { n, path } of generationsIn(dir)) {
		if (n >= kept) removeIfPresent(path);
	}
	for (let n = kept - 1; n >= 1; n -= 1) {
		if (existsSync(generation(dir, n))) {
			renameSync(generation(dir, n), generation(dir, n + 1));
		}
	}
	if (kept > 0) {
		writeFileSync(generation(dir, 1), gzipSync(readFileSync(claimed)), {
			mode: 0o600,
		});
	}
	unlinkSync(claimed);
}

// `log.jsonl` is never pruned.
export function pruneByAge(dir: string, maxAgeDays: number | undefined): void {
	if (maxAgeDays === undefined) return;
	const oldest = Date.now() - maxAgeDays * DAY;
	for (const { path } of generationsIn(dir)) {
		let mtime: number;
		try {
			mtime = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		if (mtime < oldest) removeIfPresent(path);
	}
}
