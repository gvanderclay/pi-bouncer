// A launch while auto or YOLO mode is on gets that flag, so the child starts in
// the parent's mode. The bouncer only appends; there is no veto.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GateMode, ModeHolder } from "./mode.ts";

const LAUNCH = "session:launch";

export type LaunchPayload = {
	/** The child `pi`'s argument list; listeners may only append. */
	args: string[];
	/** The child's environment; listeners may only add keys. */
	env: Record<string, string>;
};

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

/**
 * Registers the bouncer as a `session:launch` consumer. Synchronous on purpose:
 * the emitter reads the result off the payload as soon as `emit` returns, so
 * nothing here may wait on an `await`.
 */
export function registerSessionLaunch(
	pi: ExtensionAPI,
	holder: ModeHolder,
): void {
	pi.events.on(LAUNCH, (payload) => {
		contributeMode(holder, payload);
	});
}
