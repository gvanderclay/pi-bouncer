// The bouncer's side of the `session:launch` hook (a launcher emits it just
// before it starts a child Pi process). A launch while auto or YOLO mode is
// on gets that flag, so the child comes up in the parent's mode. The bouncer
// only appends: the launcher owns the launch and there is no veto. Nothing
// here is Pi-specific beyond the registration.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GateMode, ModeHolder } from "./mode.ts";

/** The hook a launcher emits just before it starts a child process. */
const LAUNCH = "session:launch";

/** The payload, declared here so the bouncer imports nothing from the launcher. */
export type LaunchPayload = {
	/** The child `pi`'s argument list; listeners may only append. */
	args: string[];
	/** The child's environment; listeners may only add keys. */
	env: Record<string, string>;
};

/** The flag each mode gives a launched child process. */
const FLAG: Record<Exclude<GateMode, "off">, string> = {
	auto: "--auto",
	yolo: "--yolo",
};

/**
 * Appends the holder's mode flag to a launch payload, in place. A payload
 * that is not an object, or whose `args` is not an array, is ignored: the
 * bouncer never turns a malformed hook into a launch failure.
 */
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
