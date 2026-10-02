import assert from "node:assert/strict";
import { test } from "node:test";
import { processModeHolder } from "./mode.ts";

test("the process mode holder is one object on globalThis under pi-bouncer.mode", () => {
	const holder = processModeHolder();
	assert.equal(processModeHolder(), holder);
	const store = globalThis as Record<symbol, unknown>;
	assert.equal(store[Symbol.for("pi-bouncer.mode")], holder);
});
