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

export function allowingRegistry(): FakeRegistry {
	return fakeRegistry({ [JUDGE]: { reply: verdict("allow", "routine") } });
}

export async function listedGate(
	models: readonly string[] = [JUDGE],
	auto: object = {},
): Promise<LoadedGate> {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ auto: { models, ...auto } });
	await gate.startSession("startup");
	return gate;
}

export function registryUI(fake: FakeRegistry): ReturnType<typeof uiContext> {
	const ui = uiContext();
	return { ...ui, ctx: withRegistry(ui.ctx, fake) };
}

export function modeRecords(
	records: readonly LogRecord[],
): (readonly [unknown, unknown, unknown])[] {
	return records
		.filter((record) => record.type === "auto" || record.type === "yolo")
		.map((record) => [record.type, record.on, record.how] as const);
}

export const HARD_DENY_TAIL =
	"None of the command ran. Do not retry this action through another command, script, or tool. Tell the user what was blocked and why, and let them decide.";

export async function judgedGate(
	script: ModelScript | ModelReply,
	auto: object = {},
	levels?: object,
	keys: Readonly<Record<string, string>> = {},
): Promise<{ gate: LoadedGate; fake: FakeRegistry }> {
	const models =
		typeof script === "object" && "reply" in script
			? { [JUDGE]: script }
			: { [JUDGE]: { reply: script } };
	const fake = fakeRegistry(models, keys);
	const gate = await listedGate([JUDGE], auto);
	if (levels) {
		gate.writeRouteConfig({ auto: { models: [JUDGE], ...auto }, levels });
		await gate.startSession("startup");
	}
	await gate.runCommand("auto", "", registryUI(fake).ctx);
	assert.equal(gate.mode.mode, "auto");
	return { gate, fake };
}

export function judgedUI(
	fake: FakeRegistry,
	answers: readonly (string | undefined)[] = [],
): ScriptedUI {
	const ui = scriptedUI(answers);
	return { ...ui, ctx: withRegistry(ui.ctx, fake) };
}

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

export function autoVerdict(record: LogRecord | undefined): unknown {
	return (record?.auto as { verdict?: unknown } | undefined)?.verdict;
}

export async function listGate(
	models: readonly string[],
	scripts: Readonly<Record<string, ModelScript>>,
	auto: object = {},
	keys: Readonly<Record<string, string>> = {},
): Promise<{ gate: LoadedGate; fake: FakeRegistry }> {
	const fake = fakeRegistry(scripts, keys);
	const gate = await listedGate(models, auto);
	await gate.runCommand("auto", "", registryUI(fake).ctx);
	assert.equal(gate.mode.mode, "auto");
	return { gate, fake };
}

/** Lets pending promise callbacks run; setImmediate is never mocked here. */
export function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
