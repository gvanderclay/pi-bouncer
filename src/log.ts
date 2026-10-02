// The bouncer log's files: where it lives and how a record is appended. Only
// index.ts uses it; every failure is the caller's to handle.
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
import { agentDir } from "./agent-dir.ts";

const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

/** How big `log.jsonl` may grow, and how many gzipped generations stay. */
export type RotationLimits = {
	readonly rotateAboveMiB: number;
	readonly generations: number;
};

/**
 * `$PI_BOUNCER_LOG_DIR`, or the route's own `<agent dir>/bouncer`.
 * It never depends on the bouncer config.
 */
export function defaultLogDir(): string {
	const { PI_BOUNCER_LOG_DIR } = process.env;
	return PI_BOUNCER_LOG_DIR || join(agentDir(), "bouncer");
}

export function logFile(dir: string): string {
	return join(dir, "log.jsonl");
}

/** Appends one JSON line, creating the directory (0700) and file (0600). */
export function appendRecord(dir: string, record: object): void {
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

// Every `log.N.jsonl.gz` in `dir` with its N; none when `dir` is missing.
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

// Deletes a file another process may already have deleted.
function removeIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/**
 * Past `rotateAboveMiB`, `log.jsonl` becomes `log.1.jsonl.gz` and older
 * generations shift up, keeping `generations` of them (none: the old log is
 * deleted). The first step renames the log to a name only this process uses:
 * of two processes starting at once, only one rotates it.
 */
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

/**
 * Deletes every gzipped generation last modified more than `maxAgeDays` days
 * ago; `undefined` prunes nothing. `log.jsonl` is never pruned.
 */
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
