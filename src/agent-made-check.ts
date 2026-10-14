// Why a recursive `rm` is not exempt, and the per-target detail behind it.
// The check runs once per decision: ranking, logging and the reason all read
// the same result, so the tree is never walked twice.
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import {
	type AgentMade,
	CLOCK_SLACK_MS,
	forgetGone,
	literalAbsolute,
	literalRelative,
	removalSafety,
	WALK_LIMIT,
} from "./agent-made.ts";
import { soleDirectInvocation } from "./agent-made-command.ts";
import { hasLongOption, hasShortFlag, parseArgs } from "./rules/argv.ts";
import type { Invocation, ParseFn } from "./scan/walk.ts";

/** Why a recursive `rm` is not covered by the agent-made exemption. */
export type AgentMadeReason =
	| "disabled"
	| "sibling-tool-calls"
	| "expansion"
	| "compound-command"
	| "wrapper"
	| "relative-cwd-ambiguous"
	| "nonliteral-path"
	| "untracked-or-preexisting"
	| "older-contents"
	| "tree-limit"
	| "filesystem-failure";

export type RmTarget = {
	readonly operand: string;
	readonly path?: string;
	readonly eligible: boolean;
	readonly reason?: AgentMadeReason;
	/** The item behind an old-date, budget or filesystem failure. */
	readonly at?: string;
};

export type RmCheck = {
	readonly source: string;
	readonly eligible: boolean;
	readonly reason?: AgentMadeReason;
	readonly targets: readonly RmTarget[];
};

/** One result per recursive-`rm` invocation, keyed by that invocation. */
export type RmChecks = ReadonlyMap<Invocation, RmCheck>;

const RM_NAMES = new Set(["rm", "grm"]);

// Typed as `rm` itself: a wrapper (`xargs`, `bash -c`, `timeout`) or a
// `NAME=value` prefix may add operands or change what runs.
const DIRECT_RM = /^\\?(?:\S*\/)?g?rm\s/;

/** A recursive `rm`, the only invocation the exemption reads. */
export function isRecursiveRm(invocation: Invocation): boolean {
	return (
		RM_NAMES.has(invocation.name) &&
		(hasShortFlag(invocation.args, "rR") ||
			hasLongOption(invocation.args, "recursive"))
	);
}

// The earliest time the agent made a directory holding `real`.
function madeSince(made: AgentMade, real: string): number | undefined {
	forgetGone(made);
	let since: number | undefined;
	for (const [dir, entry] of made) {
		const inside = real === dir || real.startsWith(`${dir}/`);
		if (inside && (since === undefined || entry.since < since)) {
			since = entry.since;
		}
	}
	return since;
}

type Walk =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: "older-contents" | "tree-limit" | "filesystem-failure";
			readonly at: string;
	  };

function statOr(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

function namesOr(path: string): string[] | undefined {
	try {
		return readdirSync(path);
	} catch {
		return undefined;
	}
}

// Moving keeps a file's dates, even across disks, so anything dated before
// the directory was made came from elsewhere: deleting it needs an ask. An
// unknown birth time reads as 0 on some Linux filesystems and is skipped.
function walkNewer(
	root: string,
	cutoff: number,
	budget: { left: number },
): Walk {
	const stack = [root];
	for (let path = stack.pop(); path !== undefined; path = stack.pop()) {
		budget.left -= 1;
		if (budget.left < 0) return { ok: false, reason: "tree-limit", at: path };
		const stat = statOr(path);
		if (!stat) return { ok: false, reason: "filesystem-failure", at: path };
		const born = stat.birthtimeMs;
		if (stat.mtimeMs < cutoff || (born > 0 && born < cutoff)) {
			return { ok: false, reason: "older-contents", at: path };
		}
		if (!stat.isDirectory()) continue;
		const names = namesOr(path);
		if (!names) return { ok: false, reason: "filesystem-failure", at: path };
		for (const name of names) stack.push(`${path}/${name}`);
	}
	return { ok: true };
}

function absoluteTarget(
	operand: string,
	path: string,
	made: AgentMade,
	budget: { left: number },
): RmTarget {
	let real: string;
	try {
		real = realpathSync(path);
	} catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
		return {
			operand,
			path,
			eligible: false,
			reason: missing ? "untracked-or-preexisting" : "filesystem-failure",
		};
	}
	const since = madeSince(made, real);
	if (since === undefined) {
		return {
			operand,
			path: real,
			eligible: false,
			reason: "untracked-or-preexisting",
		};
	}
	const walk = walkNewer(real, since - CLOCK_SLACK_MS, budget);
	if (!walk.ok) {
		return {
			operand,
			path: real,
			eligible: false,
			reason: walk.reason,
			at: walk.at,
		};
	}
	return { operand, path: real, eligible: true };
}

function targetOf(
	operand: string,
	shape: { readonly typed: boolean; readonly direct: boolean },
	made: AgentMade,
	cwd: string,
	budget: { left: number },
): RmTarget {
	if (!shape.typed) return { operand, eligible: false, reason: "wrapper" };
	if (literalAbsolute(operand)) {
		return absoluteTarget(operand, posix.normalize(operand), made, budget);
	}
	if (!literalRelative(operand)) {
		return { operand, eligible: false, reason: "nonliteral-path" };
	}
	if (!shape.direct || !cwd.startsWith("/")) {
		return { operand, eligible: false, reason: "relative-cwd-ambiguous" };
	}
	return absoluteTarget(operand, posix.resolve(cwd, operand), made, budget);
}

function checkRm(
	invocation: Invocation,
	direct: boolean,
	made: AgentMade,
	cwd: string,
): RmCheck {
	const { operands, afterDashDash = [] } = parseArgs(invocation.args);
	const budget = { left: WALK_LIMIT };
	const shape = { typed: DIRECT_RM.test(invocation.source), direct };
	const targets = [...operands, ...afterDashDash].map((operand) =>
		targetOf(operand, shape, made, cwd, budget),
	);
	const failed = targets.find((target) => !target.eligible);
	return {
		source: invocation.source,
		eligible: targets.length > 0 && targets.every((target) => target.eligible),
		targets,
		...(failed?.reason && { reason: failed.reason }),
	};
}

/** One check per recursive `rm`, computed once for rule matching and the log. */
export function checkRms(
	parse: ParseFn | undefined,
	command: string,
	invocations: readonly Invocation[],
	made: AgentMade,
	cwd: string,
): RmChecks {
	const direct = parse
		? soleDirectInvocation(parse, command, invocations)
		: undefined;
	const checks = new Map<Invocation, RmCheck>();
	for (const invocation of invocations) {
		if (!isRecursiveRm(invocation)) continue;
		checks.set(
			invocation,
			checkRm(invocation, invocation === direct, made, cwd),
		);
	}
	return checks;
}

/** True when this `rm` invocation is covered by the agent-made exemption. */
export function rmExempt(
	invocation: Invocation,
	made: AgentMade | undefined,
	checks: RmChecks | undefined,
): boolean {
	if (checks) return checks.get(invocation)?.eligible ?? false;
	if (made === undefined) return false;
	// No precomputed check (a rule called on its own): relative operands are
	// ambiguous without the line, so only absolute ones can qualify.
	return checkRm(invocation, false, made, "/").eligible;
}

export type AgentMadeUse = {
	readonly agentMade?: AgentMade;
	readonly agentMadeChecks?: RmChecks;
	readonly diagnostics?: readonly RmCheck[];
};

function failed(
	rms: readonly Invocation[],
	reason: AgentMadeReason,
): readonly RmCheck[] {
	return rms.map((invocation) => {
		const { operands, afterDashDash = [] } = parseArgs(invocation.args);
		return {
			source: invocation.source,
			eligible: false,
			reason,
			targets: [...operands, ...afterDashDash].map((operand) => ({
				operand,
				eligible: false,
				reason,
			})),
		};
	});
}

/**
 * What the exemption gives one line: the eligible set for the rules, and the
 * failures for the log. Precedence is disabled, sibling calls, unsafe syntax,
 * then per-target ownership. `undefined` diagnostics mean nothing failed.
 */
export function agentMadeFor(
	parse: ParseFn | undefined,
	command: string,
	invocations: readonly Invocation[],
	made: AgentMade | undefined,
	lone: boolean,
	cwd: string,
): AgentMadeUse {
	const rms = invocations.filter(isRecursiveRm);
	if (rms.length === 0) return {};
	if (made === undefined) return { diagnostics: failed(rms, "disabled") };
	if (!lone) return { diagnostics: failed(rms, "sibling-tool-calls") };
	const safety = removalSafety(command, invocations);
	if (!safety.ok) return { diagnostics: failed(rms, safety.reason) };
	const agentMadeChecks = checkRms(parse, command, invocations, made, cwd);
	const list = [...agentMadeChecks.values()];
	const diagnostics = list.some((check) => !check.eligible) ? list : undefined;
	return {
		agentMade: made,
		agentMadeChecks,
		...(diagnostics && { diagnostics }),
	};
}
