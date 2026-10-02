// A launch while auto or YOLO mode is on gets that flag, so the child starts in
// the parent's mode. The bouncer only appends; there is no veto.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GateConfig } from "./config.ts";
import type { GateMode, ModeHolder } from "./mode.ts";
import type { SessionState } from "./mode-switch.ts";

const LAUNCH = "session:launch";

export type LaunchPayload = {
	/** The child `pi`'s argument list; listeners may only append. */
	args: string[];
	/** The child's environment; listeners may only add keys. */
	env: Record<string, string>;
	/** The delegate's agent name, when the launcher knows it. */
	agent?: unknown;
};

const AGENT_KEY = "PI_BOUNCER_AGENT";

const FLAG: Record<Exclude<GateMode, "off">, string> = {
	auto: "--auto",
	yolo: "--yolo",
};

// A malformed payload is ignored: a bad hook never becomes a launch failure.
export function contributeMode(holder: ModeHolder, payload: unknown): void {
	if (typeof payload !== "object" || payload === null) return;
	const { args } = payload as LaunchPayload;
	if (!Array.isArray(args)) return;
	if (holder.mode === "off") return;
	args.push(FLAG[holder.mode]);
}

// The child gets its own agent's profile, else the parent's; a launch that
// already sets the variable keeps it. Malformed payloads add nothing.
export function contributeAgent(
	config: GateConfig | undefined,
	payload: unknown,
): void {
	if (typeof payload !== "object" || payload === null || !config) return;
	const { env, agent } = payload as LaunchPayload;
	if (typeof env !== "object" || env === null || AGENT_KEY in env) return;
	if (typeof agent === "string" && config.profiledAgents.has(agent)) {
		env[AGENT_KEY] = agent;
	} else if (config.profile?.state === "profile") {
		env[AGENT_KEY] = config.profile.agent;
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
