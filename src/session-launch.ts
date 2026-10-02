// A launch while auto or YOLO mode is on gets that flag, so the child starts in
// the parent's mode. The bouncer also sets PI_BOUNCER_AGENT for the child. It
// only appends and adds keys; there is no veto.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BOUNCER_AGENT_VARIABLE } from "./agent-env.ts";
import type { GateConfig } from "./config.ts";
import type { GateMode, ModeHolder } from "./mode.ts";
import type { SessionState } from "./mode-switch.ts";

const LAUNCH = "session:launch";

export type LaunchPayload = {
	/** The child `pi`'s argument list; listeners may only append. */
	args: string[];
	/** The child's environment; listeners may only add keys. */
	env: Record<string, string>;
	/** The agent name the launcher gives the child, when it knows it. */
	agent?: unknown;
};

const FLAG: Record<Exclude<GateMode, "off">, string> = {
	auto: "--auto",
	yolo: "--yolo",
};

// A malformed payload is ignored: a bad hook never becomes a launch failure.
function contributeMode(holder: ModeHolder, payload: unknown): void {
	if (typeof payload !== "object" || payload === null) return;
	const { args } = payload as LaunchPayload;
	if (!Array.isArray(args)) return;
	if (holder.mode === "off") return;
	args.push(FLAG[holder.mode]);
}

// The child gets its own agent's profile, else the parent's. A non-blank
// PI_BOUNCER_AGENT already in the launch env is kept; a blank one counts as
// unset. Never throws: a malformed or hostile payload adds nothing.
function contributeAgent(
	config: GateConfig | undefined,
	payload: unknown,
): void {
	if (typeof payload !== "object" || payload === null || !config) return;
	try {
		const { env, agent } = payload as LaunchPayload;
		if (typeof env !== "object" || env === null || Array.isArray(env)) return;
		const key = BOUNCER_AGENT_VARIABLE;
		if (Object.hasOwn(env, key) && String(env[key]).trim() !== "") return;
		if (typeof agent === "string" && config.profiledAgents.has(agent)) {
			env[key] = agent;
		} else if (config.profile?.state === "profile") {
			env[key] = config.profile.agent;
		}
	} catch {
		// A bad hook never becomes a launch failure.
	}
}

/**
 * Registers the bouncer as a `session:launch` consumer. Synchronous on purpose:
 * the emitter reads the result off the payload as soon as `emit` returns, so
 * nothing here may wait on an `await`.
 */
export function registerSessionLaunch(
	pi: ExtensionAPI,
	holder: ModeHolder,
	session: SessionState,
): void {
	pi.events.on(LAUNCH, (payload) => {
		contributeMode(holder, payload);
		contributeAgent(session.config, payload);
	});
}
