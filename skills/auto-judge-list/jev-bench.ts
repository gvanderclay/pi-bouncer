// The Jev bench: asks Jev about every bench case a few times, through the
// bouncer's own Jev client, and works out the cutoffs at which Jev may
// decide. `bench.ts jev` dispatches here. It spends real quota.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { agentDir as defaultAgentDir } from "../../agent-dir.ts";
import { errorText } from "../../error-text.ts";
import { askJev, jevKey, NO_KEY, readReply } from "../../jev.ts";
import type { JudgeRegistry } from "../../judge.ts";
import type { BenchCase, requestFor } from "./bench.ts";

/**
 * One Jev answer to one case: `safety`'s P(safe), the deny score as
 * `unsafe`, or why it gave none.
 */
export type JevSample = {
	readonly id: string;
	/** Which sample of the case, from 1. */
	readonly sample: number;
	readonly safe?: number;
	readonly unsafe?: number;
	readonly confidence?: number;
	readonly error?: string;
	readonly ms: number;
};

/**
 * Asks Jev about each case `samples` times, one call at a time, with the
 * route's opencode-go key. Without a key it throws before any call.
 */
export async function runJevBench(
	cases: readonly BenchCase[],
	registry: JudgeRegistry,
	build: typeof requestFor,
	samples = 3,
	onSample: (sample: JevSample) => void = () => {},
): Promise<JevSample[]> {
	const key = await jevKey(registry);
	if (!key) throw new Error(NO_KEY);
	const results: JevSample[] = [];
	for (const c of cases) {
		const request = build(c);
		for (let sample = 1; sample <= samples; sample += 1) {
			const call = await askJev(request, key);
			const reading = "error" in call ? call.error : readReply(call.reply);
			const result: JevSample =
				typeof reading === "string"
					? { id: c.id, sample, error: reading, ms: call.ms }
					: {
							id: c.id,
							sample,
							safe: reading.safe,
							unsafe: reading.unsafe,
							confidence: reading.confidence,
							ms: call.ms,
						};
			results.push(result);
			onSample(result);
		}
	}
	return results;
}

/** At one candidate cutoff, what Jev would get wrong and decide. */
export type CutoffRow = {
	readonly cutoff: number;
	/** Cases that should not be allowed with a sample's safe probability at the cutoff. */
	readonly wrongAllows: number;
	/** Cases every sample of which is allowed. */
	readonly allowed: number;
	/** Cases that should not be denied with a sample's deny score at the cutoff. */
	readonly wrongDenies: number;
	/** Cases every sample of which is denied. */
	readonly denied: number;
	readonly cases: number;
};

/** The candidate cutoffs: 0.50 to 0.99 in steps of 0.01. */
const CANDIDATES: readonly number[] = Array.from(
	{ length: 50 },
	(_, at) => (50 + at) / 100,
);

/** Each case's samples' values of `side`; a failed sample is `undefined`. */
function values(
	samples: readonly JevSample[],
	id: string,
	side: "safe" | "unsafe",
): (number | undefined)[] {
	return samples.filter((s) => s.id === id).map((s) => s[side]);
}

function reaches(value: number | undefined, cutoff: number): boolean {
	return value !== undefined && value >= cutoff;
}

/**
 * The cutoff table: a case is a wrong allow (deny) when any sample reaches
 * the cutoff and its expected verdicts exclude allow (deny), and is decided
 * when every sample reaches it.
 */
export function cutoffTable(
	samples: readonly JevSample[],
	cases: readonly BenchCase[],
): CutoffRow[] {
	const count = (
		cutoff: number,
		side: "safe" | "unsafe",
		wrong: boolean,
	): number =>
		cases.filter((c) => {
			const all = values(samples, c.id, side);
			if (!wrong) return all.length > 0 && all.every((v) => reaches(v, cutoff));
			const verdict = side === "safe" ? "allow" : "deny";
			return (
				!c.expected.includes(verdict) && all.some((v) => reaches(v, cutoff))
			);
		}).length;
	return CANDIDATES.map((cutoff) => ({
		cutoff,
		wrongAllows: count(cutoff, "safe", true),
		allowed: count(cutoff, "safe", false),
		wrongDenies: count(cutoff, "unsafe", true),
		denied: count(cutoff, "unsafe", false),
		cases: cases.length,
	}));
}

/** The recommended cutoffs: the lowest with no wrong answer, or `null`. */
export type JevRecommendation = {
	readonly allowAt: number | null;
	readonly denyAt: number | null;
};

export function recommend(rows: readonly CutoffRow[]): JevRecommendation {
	return {
		allowAt: rows.find((row) => row.wrongAllows === 0)?.cutoff ?? null,
		denyAt: rows.find((row) => row.wrongDenies === 0)?.cutoff ?? null,
	};
}

function caseLine(c: BenchCase, samples: readonly JevSample[]): string {
	const mine = samples.filter((s) => s.id === c.id);
	const safe = mine.flatMap((s) => (s.safe === undefined ? [] : [s.safe]));
	const errors = mine.length - safe.length;
	const range =
		safe.length === 0
			? "no answer"
			: `safe ${Math.min(...safe).toFixed(2)}–${Math.max(...safe).toFixed(2)}`;
	const failed =
		errors === 0 ? "" : `, ${errors} error${errors > 1 ? "s" : ""}`;
	return `${c.id} (expects ${c.expected.join(", ")}): ${range}${failed}`;
}

function cutoffText(cutoff: number | null): string {
	return cutoff === null ? "null" : cutoff.toFixed(2);
}

/** The bench's output: each case's safe range, the cutoff table, the pair. */
export function jevReport(
	samples: readonly JevSample[],
	cases: readonly BenchCase[],
): string {
	const rows = cutoffTable(samples, cases);
	const table = rows.map(
		(row) =>
			`| ${cutoffText(row.cutoff)} | ${row.wrongAllows} | ${row.allowed}/${row.cases} | ${row.wrongDenies} | ${row.denied}/${row.cases} |`,
	);
	const failed = samples.filter((s) => s.error !== undefined).length;
	const { allowAt, denyAt } = recommend(rows);
	return [
		...cases.map((c) => caseLine(c, samples)),
		"",
		"| Cutoff | Wrong allows | Cases allowed | Wrong denies | Cases denied |",
		"| --- | --- | --- | --- | --- |",
		...table,
		"",
		failed > 0
			? `No recommendation: ${failed} of ${samples.length} Jev calls failed.`
			: `Recommended: allowAt ${cutoffText(allowAt)}, denyAt ${cutoffText(denyAt)}`,
	].join("\n");
}

const USAGE =
	"usage: node bench.ts jev [--agent-dir <route>] [--samples N]\n" +
	"Asks Jev about every bench case N times (default 3); spends real opencode-go quota.\n";

type JevArgs = { readonly route: string; readonly samples: number };

/** The parsed arguments, or the exit code after printing usage. */
function jevArgs(args: readonly string[]): JevArgs | number {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(args);
	} catch (error) {
		process.stderr.write(`${errorText(error)}\n${USAGE}`);
		return 2;
	}
	const { values, positionals } = parsed;
	if (values.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	const samples = Number(values.samples ?? "3");
	if (!Number.isInteger(samples) || samples < 1 || positionals.length > 0) {
		process.stderr.write(USAGE);
		return 2;
	}
	const route = resolve(values["agent-dir"] ?? defaultAgentDir());
	return { route, samples };
}

function parse(args: readonly string[]): {
	values: { "agent-dir"?: string; samples?: string; help?: boolean };
	positionals: string[];
} {
	return parseArgs({
		args: [...args],
		allowPositionals: true,
		options: {
			"agent-dir": { type: "string" },
			samples: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
}

/**
 * `bench.ts jev`: runs the Jev bench over every case with the route's
 * registry and prints the report. Usage and a missing key make no call.
 */
export async function jevMain(
	args: readonly string[],
	loadRegistry: (route: string) => Promise<JudgeRegistry>,
	cases: readonly BenchCase[],
	build: typeof requestFor,
): Promise<void> {
	const parsed = jevArgs(args);
	if (typeof parsed === "number") {
		process.exitCode = parsed;
		return;
	}
	const registry = await loadRegistry(parsed.route);
	let samples: JevSample[];
	try {
		samples = await runJevBench(cases, registry, build, parsed.samples, (s) => {
			const answer =
				s.error ?? `safe ${s.safe}, deny score ${s.unsafe?.toFixed(2)}`;
			process.stderr.write(`${s.id} #${s.sample}: ${answer} (${s.ms} ms)\n`);
		});
	} catch (error) {
		process.stderr.write(
			`jev: ${errorText(error)} for route ${parsed.route}\n`,
		);
		process.exitCode = 1;
		return;
	}
	process.stdout.write(`${jevReport(samples, cases)}\n`);
}
