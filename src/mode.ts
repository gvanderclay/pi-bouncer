// The bouncer mode's state, free of Pi. `/reload` replaces the extension runtime
// and its module state (Pi docs/extensions.md), so the process-wide holder
// lives on globalThis under a Symbol.for key and holds plain data only: a
// reloaded runtime reads the same object through its own copy of this module.

/** The process-wide bouncer mode: normal (`off`), auto mode or YOLO mode. */
export type GateMode = "off" | "auto" | "yolo";

/** The bouncer mode, in memory only: gone when the process exits. */
export type ModeHolder = {
	/** Turning one mode on leaves the other. */
	mode: GateMode;
	/** Whether the start flags have already been applied in this process. */
	flagsApplied: boolean;
};

const KEY = Symbol.for("dotfiles.bouncer.mode");

/** A fresh holder: the bouncer mode off, the start flags not yet applied. */
export function createModeHolder(): ModeHolder {
	return { mode: "off", flagsApplied: false };
}

/** The one holder every bouncer runtime in this process shares. */
export function processModeHolder(): ModeHolder {
	const store = globalThis as { [KEY]?: ModeHolder };
	store[KEY] ??= createModeHolder();
	return store[KEY];
}
