// Helpers shared by the auto-mode tests: statuses, notices, a judge list
// whose one model allows, and contexts holding a fake model registry.
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type FakeRegistry,
	fakeContext,
	fakeRegistry,
	type LoadedGate,
	type LogRecord,
	loadGateSession,
	type ModelReply,
	type ModelScript,
	type ScriptedUI,
	scriptedUI,
	uiContext,
	verdict,
	withRegistry,
} from "./harness.ts";

export const AUTO_STATUS = "<accent>🤖 AUTO</accent>";
export const YOLO_STATUS = "<b><error>🔥 YOLO</error></b>";
export const AUTO_ON = {
	message:
		"Auto mode on: a model judges each ask; rule-level denies, sudo, shutdown, disk wipes and rm of / or ~ are still denied.",
	level: "info",
};
export const AUTO_OFF = {
	message: "Auto mode off: the bouncer asks again.",
	level: "info",
};

export const JUDGE = "fake/judge";

/** A registry whose one model, `fake/judge`, allows every call. */
export function allowingRegistry(): FakeRegistry {
	return fakeRegistry({ [JUDGE]: { reply: verdict("allow", "routine") } });
}

/**
 * A bouncer whose route lists `models` as its judge list and whose session has
 * started; `/auto` is not yet run.
 */
export async function listedGate(
	models: readonly string[] = [JUDGE],
	auto: object = {},
): Promise<LoadedGate> {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ auto: { models, ...auto } });
	await gate.startSession("startup");
	return gate;
}

/** A UI context holding `fake` as its model registry. */
export function registryUI(fake: FakeRegistry): ReturnType<typeof uiContext> {
	const ui = uiContext();
	return { ...ui, ctx: withRegistry(ui.ctx, fake) };
}

/** The mode records in `records`, as `[type, on, how]`, in order. */
export function modeRecords(
	records: readonly LogRecord[],
): (readonly [unknown, unknown, unknown])[] {
	return records
		.filter((record) => record.type === "auto" || record.type === "yolo")
		.map((record) => [record.type, record.on, record.how] as const);
}

export const HARD_DENY_TAIL =
	"None of the command ran. Do not retry this action through another command, script, or tool. Tell the user what was blocked and why, and let them decide.";

/** A bouncer in auto mode whose judge list is `fake/judge`, scripted by `script`. */
export async function judgedGate(
	script: ModelScript | ModelReply,
	auto: object = {},
	levels?: object,
): Promise<{ gate: LoadedGate; fake: FakeRegistry }> {
	const models =
		typeof script === "object" && "reply" in script
			? { [JUDGE]: script }
			: { [JUDGE]: { reply: script } };
	const fake = fakeRegistry(models);
	const gate = await listedGate([JUDGE], auto);
	if (levels) {
		gate.writeRouteConfig({ auto: { models: [JUDGE], ...auto }, levels });
		await gate.startSession("startup");
	}
	await gate.runCommand("auto", "", registryUI(fake).ctx);
	assert.equal(gate.mode.mode, "auto");
	return { gate, fake };
}

/** A scripted dialog context that also holds `fake`. */
export function judgedUI(
	fake: FakeRegistry,
	answers: readonly (string | undefined)[] = [],
): ScriptedUI {
	const ui = scriptedUI(answers);
	return { ...ui, ctx: withRegistry(ui.ctx, fake) };
}

/** `ctx` whose session runs on `provider/id`, as `ctx.model` holds it. */
export function onModel(
	ctx: ExtensionContext,
	provider: string,
	id = "chat",
): ExtensionContext {
	return { ...(ctx as object), model: { provider, id } } as ExtensionContext;
}

export function noUI(fake: FakeRegistry): ExtensionContext {
	return withRegistry(fakeContext(), fake);
}

/** A call record's `auto.verdict`, if any. */
export function autoVerdict(record: LogRecord | undefined): unknown {
	return (record?.auto as { verdict?: unknown } | undefined)?.verdict;
}

/** A bouncer in auto mode whose judge list is `models`, scripted by `scripts`. */
export async function listGate(
	models: readonly string[],
	scripts: Readonly<Record<string, ModelScript>>,
	auto: object = {},
): Promise<{ gate: LoadedGate; fake: FakeRegistry }> {
	const fake = fakeRegistry(scripts);
	const gate = await listedGate(models, auto);
	await gate.runCommand("auto", "", registryUI(fake).ctx);
	assert.equal(gate.mode.mode, "auto");
	return { gate, fake };
}

/** Lets pending promise callbacks run; setImmediate is never mocked here. */
export function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
