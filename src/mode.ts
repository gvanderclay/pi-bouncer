// The bouncer mode's state, free of Pi. `/reload` replaces the extension runtime
// and its module state (Pi docs/extensions.md), so the process-wide holder
// lives on globalThis under a Symbol.for key and holds plain data only: a
// reloaded runtime reads the same object through its own copy of this module.

export type GateMode = "off" | "auto" | "yolo";

export type ModeHolder = {
	mode: GateMode;
	flagsApplied: boolean;
};

const KEY = Symbol.for("pi-bouncer.mode");

export function createModeHolder(): ModeHolder {
	return { mode: "off", flagsApplied: false };
}

export function processModeHolder(): ModeHolder {
	const store = globalThis as { [KEY]?: ModeHolder };
	store[KEY] ??= createModeHolder();
	return store[KEY];
}
