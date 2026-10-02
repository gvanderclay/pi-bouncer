import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	bashCall,
	fakeContext,
	type LoadedGate,
	type LogRecord,
	loadGateSession,
	PREFER_RG,
	SESSION_FILE,
	SESSION_ID,
	type SessionReason,
	scriptedUI,
	tempLogDir,
	uiContext,
} from "../test/harness.ts";

const ON_NOTICE = {
	message:
		"YOLO mode on: every ask is allowed; sudo, shutdown, disk wipes and rm of / or ~ are still denied.",
	level: "warning",
};
// Bold, in the theme's error colour (red), behind an emoji.
const YOLO_STATUS = "<b><error>🔥 YOLO</error></b>";
const OFF_NOTICE = {
	message: "YOLO mode off: the bouncer asks again.",
	level: "info",
};

async function yoloGate(userConfig: object = {}): Promise<LoadedGate> {
	const gate = await loadGateSession(undefined, undefined, { userConfig });
	await gate.startSession("startup");
	await gate.runCommand("yolo", "", uiContext().ctx);
	return gate;
}

test("after /yolo, an ask is allowed with no dialog, with a UI", async () => {
	const { handler } = await yoloGate();
	const { ctx, dialogs, notices } = scriptedUI();
	assert.equal(await handler(bashCall("rm -rf dist"), ctx), undefined);
	assert.equal(dialogs.length, 0);
	assert.deepEqual(notices, []);
});

test("after /yolo, an ask is allowed without a UI", async () => {
	const { handler } = await yoloGate();
	assert.equal(
		await handler(bashCall("rm -rf dist"), fakeContext()),
		undefined,
	);
});

test("/yolo shows the YOLO status and notifies once", async () => {
	const gate = await loadGateSession();
	const { ctx, notices, statuses } = uiContext();
	await gate.runCommand("yolo", "", ctx);
	assert.deepEqual(statuses, { bouncer: YOLO_STATUS });
	assert.deepEqual(notices, [ON_NOTICE]);
	assert.equal(gate.mode.mode, "yolo");
});

for (const args of ["off", ""]) {
	test(`/yolo ${args || "(again)"} turns YOLO mode off: dialogs and no status`, async () => {
		const gate = await yoloGate();
		const { ctx, notices, statuses } = uiContext();
		await gate.runCommand("yolo", args, ctx);
		assert.deepEqual(statuses, { bouncer: undefined });
		assert.deepEqual(notices, [OFF_NOTICE]);
		const asked = scriptedUI(["Deny"]);
		const result = await gate.handler(bashCall("rm -rf dist"), asked.ctx);
		assert.equal(result?.block, true);
		assert.equal(asked.dialogs.length, 1);
	});
}

test("/yolo on while on only notifies", async () => {
	const gate = await yoloGate();
	const before = gate.records().length;
	const { ctx, notices, statuses } = uiContext();
	await gate.runCommand("yolo", "on", ctx);
	assert.deepEqual(notices, [ON_NOTICE]);
	assert.deepEqual(statuses, {});
	assert.equal(gate.mode.mode, "yolo");
	assert.equal(gate.records().length, before);
});

test("/yolo off while off only notifies", async () => {
	const gate = await loadGateSession();
	const { ctx, notices, statuses } = uiContext();
	await gate.runCommand("yolo", "off", ctx);
	assert.deepEqual(notices, [OFF_NOTICE]);
	assert.deepEqual(statuses, {});
	assert.equal(gate.mode.mode, "off");
	assert.deepEqual(gate.records(), []);
});

test("/yolo with an unknown argument warns and changes nothing", async () => {
	const gate = await loadGateSession();
	const { ctx, notices, statuses } = uiContext();
	await gate.runCommand("yolo", "maybe", ctx);
	assert.deepEqual(notices, [
		{ message: "Usage: /yolo [on|off]", level: "warning" },
	]);
	assert.deepEqual(statuses, {});
	assert.equal(gate.mode.mode, "off");
});

const HARD_DENY_TAIL =
	"None of the command ran. Do not retry this action through another command, script, or tool. Tell the user what was blocked and why, and let them decide.";

function hardDeny(rule: string, summary: string, source: string): string {
	return `Blocked by the user's bouncer (rule: ${rule}): ${summary}. Command: \`${source}\`. ${HARD_DENY_TAIL}`;
}

const alwaysDenied: readonly (readonly [
	command: string,
	rule: string,
	source: string,
])[] = [
	["sudo ls", "privilege", "sudo ls"],
	["shutdown -h now", "power", "shutdown -h now"],
	["mkfs.ext4 /dev/disk2", "disk-format", "mkfs.ext4 /dev/disk2"],
	["dd if=x of=/dev/disk2", "dd-device", "dd if=x of=/dev/disk2"],
	["rm -rf ~", "rm-root", "rm -rf ~"],
	["rm -rf x && sudo ls", "privilege", "sudo ls"],
];

for (const [command, rule, source] of alwaysDenied) {
	for (const [label, context] of [
		["with a UI", (): ReturnType<typeof scriptedUI> => scriptedUI()],
		["without a UI", undefined],
	] as const) {
		test(`YOLO mode still denies ${command} (${rule}) ${label}`, async () => {
			const { handler } = await yoloGate();
			const ui = context?.();
			const ctx: ExtensionContext = ui?.ctx ?? fakeContext();
			const result = await handler(bashCall(command), ctx);
			assert.equal(ui?.dialogs.length ?? 0, 0);
			assert.equal(result?.block, true);
			assert.match(result?.reason ?? "", new RegExp(`\\(rule: ${rule}\\)`));
			assert.ok(
				result?.reason?.endsWith(`Command: \`${source}\`. ${HARD_DENY_TAIL}`),
				String(result?.reason),
			);
			assert.ok(!/yolo/i.test(result?.reason ?? ""), String(result?.reason));
			if (ui) {
				assert.deepEqual(ui.notices, [
					{
						message: `Bouncer denied ${rule}: ${source}`,
						level: "warning",
					},
				]);
			}
		});
	}
}

test("YOLO mode's rm-root deny reads exactly like today's", async () => {
	const { handler } = await yoloGate();
	const result = await handler(bashCall("rm -rf ~"), fakeContext());
	assert.deepEqual(result, {
		block: true,
		reason: hardDeny(
			"rm-root",
			"recursive rm of the filesystem root, a system directory or your home directory",
			"rm -rf ~",
		),
	});
});

test("YOLO mode still denies an unparseable command", async () => {
	const { handler } = await yoloGate();
	const { ctx, notices } = uiContext();
	const result = await handler(bashCall('echo "unterminated'), ctx);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /\(rule: unparseable\)/);
	assert.equal(notices.length, 1);
});

test("YOLO mode still denies when the parser is missing", async () => {
	const gate = await loadGateSession(() => Promise.reject(new Error("gone")));
	await gate.runCommand("yolo", "on");
	const result = await gate.handler(bashCall("ls"), fakeContext());
	assert.match(result?.reason ?? "", /\(rule: parser-unavailable\)/);
});

test("YOLO mode denies sudo even when the route config lowers privilege to ask", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ levels: { privilege: "ask" } });
	await gate.startSession("startup");
	await gate.runCommand("yolo", "on");
	const { ctx, dialogs } = scriptedUI();
	const result = await gate.handler(bashCall("sudo ls"), ctx);
	assert.equal(dialogs.length, 0);
	assert.equal(
		result?.reason,
		hardDeny(
			"privilege",
			"the agent must not run anything with elevated privileges",
			"sudo ls",
		),
	);
});

test("YOLO mode allows pi --yolo, a rule-level deny", async () => {
	const { handler } = await yoloGate();
	assert.equal(await handler(bashCall("pi --yolo"), fakeContext()), undefined);
});

test("YOLO mode allows a rule the route config raised to deny", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ levels: { "git-push-force": "deny" } });
	await gate.startSession("startup");
	await gate.runCommand("yolo", "on");
	const { ctx, dialogs, notices } = scriptedUI();
	assert.equal(
		await gate.handler(bashCall("git push --force"), ctx),
		undefined,
	);
	assert.equal(dialogs.length, 0);
	assert.deepEqual(notices, []);
});

test("a raised deny before an always-deny match does not stop YOLO mode's check", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ levels: { "git-push-force": "deny" } });
	await gate.startSession("startup");
	await gate.runCommand("yolo", "on");
	const result = await gate.handler(
		bashCall("git push --force && sudo ls"),
		fakeContext(),
	);
	assert.match(result?.reason ?? "", /\(rule: privilege\)/);
});

test("a session allow from before /yolo still answers its ask", async () => {
	const gate = await loadGateSession();
	await gate.startSession("startup");
	const first = scriptedUI(["Allow for this session"]);
	await gate.handler(bashCall("rm -rf dist"), first.ctx);
	await gate.runCommand("yolo", "on");
	const { ctx, dialogs } = scriptedUI();
	assert.equal(await gate.handler(bashCall("rm -rf dist"), ctx), undefined);
	assert.equal(dialogs.length, 0);
	const asks = gate.records().at(-1)?.asks;
	assert.deepEqual(asks, [
		{ rule: "recursive-rm", source: "rm -rf dist", answer: "session-allowed" },
	]);
});

test("under YOLO mode an unallowed ask is answered yolo", async () => {
	const gate = await yoloGate();
	await gate.handler(bashCall("rm -rf a && git reset --hard"), fakeContext());
	assert.deepEqual(gate.records().at(-1)?.asks, [
		{ rule: "recursive-rm", source: "rm -rf a", answer: "yolo" },
		{ rule: "git-reset-hard", source: "git reset --hard", answer: "yolo" },
	]);
});

const reasons: readonly SessionReason[] = [
	"startup",
	"reload",
	"new",
	"resume",
	"fork",
];

for (const reason of reasons) {
	test(`YOLO mode survives a ${reason} session start, which re-applies the status`, async () => {
		const gate = await yoloGate();
		const { ctx, statuses } = uiContext();
		await gate.startSession(reason, ctx);
		assert.deepEqual(statuses, { bouncer: YOLO_STATUS });
		const asked = scriptedUI();
		assert.equal(
			await gate.handler(bashCall("rm -rf dist"), asked.ctx),
			undefined,
		);
		assert.equal(asked.dialogs.length, 0);
	});
}

test("a session start with YOLO mode off clears the status", async () => {
	const gate = await loadGateSession();
	const { ctx, statuses } = uiContext();
	await gate.startSession("startup", ctx);
	assert.deepEqual(statuses, { bouncer: undefined });
});

test("loading the bouncer again with the same holder, as /reload does, keeps YOLO mode on", async () => {
	const first = await yoloGate();
	const reloaded = await loadGateSession(undefined, first.logDir, {
		mode: first.mode,
	});
	const { ctx, statuses } = uiContext();
	await reloaded.startSession("reload", ctx);
	assert.deepEqual(statuses, { bouncer: YOLO_STATUS });
	const asked = scriptedUI();
	assert.equal(
		await reloaded.handler(bashCall("rm -rf dist"), asked.ctx),
		undefined,
	);
	assert.equal(asked.dialogs.length, 0);
});

test("a fresh load starts with YOLO mode off", async () => {
	const gate = await loadGateSession();
	assert.equal(gate.mode.mode, "off");
	const result = await gate.handler(bashCall("rm -rf dist"), fakeContext());
	assert.equal(result?.block, true);
});

const HEAD: Record<string, unknown> = {
	v: 1,
	sessionId: SESSION_ID,
	sessionFile: SESSION_FILE,
	cwd: "/work",
};

function timeless(record: LogRecord | undefined): object {
	const { time, ...rest } = record ?? {};
	assert.equal(typeof time, "string");
	return rest;
}

test("/yolo then /yolo off append two yolo records with how: command", async () => {
	const { runCommand, records } = await loadGateSession();
	await runCommand("yolo", "");
	await runCommand("yolo", "off");
	assert.deepEqual(records().map(timeless), [
		{ ...HEAD, type: "yolo", on: true, how: "command" },
		{ ...HEAD, type: "yolo", on: false, how: "command" },
	]);
});

test("a switch that changes nothing writes no record", async () => {
	const { runCommand, records } = await loadGateSession();
	await runCommand("yolo", "off");
	await runCommand("yolo", "maybe");
	assert.deepEqual(records(), []);
});

const RM_DIST = { rule: "recursive-rm", level: "ask", source: "rm -rf dist" };

test("an ask YOLO mode allowed with a UI logs withoutYolo: dialog", async () => {
	const gate = await yoloGate();
	await gate.handler(bashCall("rm -rf dist"), scriptedUI().ctx);
	assert.deepEqual(timeless(gate.records().at(-1)), {
		...HEAD,
		type: "call",
		command: "rm -rf dist",
		ui: true,
		outcome: "allowed",
		matches: [RM_DIST],
		asks: [{ rule: "recursive-rm", source: "rm -rf dist", answer: "yolo" }],
		yolo: true,
		withoutYolo: "dialog",
	});
});

test("an ask YOLO mode allowed without a UI logs withoutYolo: blocked", async () => {
	const gate = await yoloGate();
	await gate.handler(bashCall("rm -rf dist"), fakeContext());
	const record = gate.records().at(-1);
	assert.equal(record?.outcome, "allowed");
	assert.equal(record?.ui, false);
	assert.equal(record?.yolo, true);
	assert.equal(record?.withoutYolo, "blocked");
});

test("a session-allowed command under YOLO mode logs withoutYolo: allowed", async () => {
	const gate = await loadGateSession();
	await gate.startSession("startup");
	await gate.handler(
		bashCall("rm -rf dist"),
		scriptedUI(["Allow for this session"]).ctx,
	);
	await gate.runCommand("yolo", "on");
	await gate.handler(bashCall("rm -rf dist"), scriptedUI().ctx);
	const record = gate.records().at(-1);
	assert.equal(record?.withoutYolo, "allowed");
	assert.equal(record?.yolo, true);
});

test("one session-allowed ask beside a new one logs withoutYolo: dialog", async () => {
	const gate = await loadGateSession();
	await gate.startSession("startup");
	const command = "rm -rf dist && git reset --hard";
	await gate.handler(
		bashCall(command),
		scriptedUI(["Allow for this session", "Allow once"]).ctx,
	);
	await gate.runCommand("yolo", "on");
	await gate.handler(bashCall(command), scriptedUI().ctx);
	const record = gate.records().at(-1);
	assert.equal(record?.withoutYolo, "dialog");
	assert.deepEqual(record?.asks, [
		{ rule: "recursive-rm", source: "rm -rf dist", answer: "session-allowed" },
		{ rule: "git-reset-hard", source: "git reset --hard", answer: "yolo" },
	]);
});

test("sudo ls under YOLO mode logs a blocked call with withoutYolo: blocked", async () => {
	const gate = await yoloGate();
	await gate.handler(bashCall("sudo ls"), scriptedUI().ctx);
	const record = gate.records().at(-1);
	assert.equal(record?.outcome, "blocked");
	assert.equal(record?.yolo, true);
	assert.equal(record?.withoutYolo, "blocked");
});

test("a raised deny YOLO mode allowed logs withoutYolo: blocked", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ levels: { "git-push-force": "deny" } });
	await gate.startSession("startup");
	await gate.runCommand("yolo", "on");
	await gate.handler(bashCall("git push --force"), scriptedUI().ctx);
	const record = gate.records().at(-1);
	assert.equal(record?.outcome, "allowed");
	assert.equal(record?.withoutYolo, "blocked");
	assert.deepEqual(record?.matches, [
		{ rule: "git-push-force", level: "deny", source: "git push --force" },
	]);
});

test("the session record carries yolo beside config, not inside it", async () => {
	const gate = await yoloGate();
	await gate.startSession("new");
	const on = gate.records().at(-1);
	assert.equal(on?.type, "session");
	assert.equal(on?.yolo, true);
	const config = on?.config as { yolo?: unknown };
	assert.equal(config.yolo, undefined);
	await gate.runCommand("yolo", "off");
	await gate.startSession("new");
	assert.equal(gate.records().at(-1)?.yolo, false);
});

test("calls outside YOLO mode carry no yolo fields", async () => {
	const gate = await loadGateSession();
	await gate.handler(bashCall("rm -rf dist"), scriptedUI(["Allow once"]).ctx);
	await gate.handler(bashCall("sudo ls"), fakeContext());
	for (const record of gate.records()) {
		assert.equal("yolo" in record, false);
		assert.equal("withoutYolo" in record, false);
	}
});

test("an unwritable log leaves YOLO mode's decisions and switches unchanged", async () => {
	const logDir = tempLogDir();
	mkdirSync(dirname(logDir), { recursive: true });
	writeFileSync(logDir, "not a directory");
	const gate = await loadGateSession(undefined, logDir);
	await gate.runCommand("yolo", "on");
	assert.equal(gate.mode.mode, "yolo");
	assert.equal(
		await gate.handler(bashCall("rm -rf dist"), fakeContext()),
		undefined,
	);
	const denied = await gate.handler(bashCall("sudo ls"), fakeContext());
	assert.equal(denied?.block, true);
});

const ALLOW_ALL = "⚠️ Allow all (YOLO)";
const THREE_ASKS = "rm -rf a && git reset --hard && git clean -fd";

test("Allow all (YOLO) at 1 of 3 allows the line with no further dialog", async () => {
	const gate = await loadGateSession();
	const { ctx, dialogs, notices, statuses } = scriptedUI([ALLOW_ALL]);
	assert.equal(await gate.handler(bashCall(THREE_ASKS), ctx), undefined);
	assert.equal(dialogs.length, 1);
	assert.match(dialogs[0]?.title ?? "", / — 1 of 3\n/);
	assert.equal(gate.mode.mode, "yolo");
	assert.deepEqual(statuses, { bouncer: YOLO_STATUS });
	assert.deepEqual(notices, [ON_NOTICE]);
	const [call, yolo] = gate.records();
	assert.equal(call?.type, "call");
	assert.equal(call?.outcome, "allowed");
	assert.deepEqual(call?.asks, [
		{ rule: "recursive-rm", source: "rm -rf a", answer: "allow-all" },
		{ rule: "git-reset-hard", source: "git reset --hard", answer: "yolo" },
		{ rule: "git-clean", source: "git clean -fd", answer: "yolo" },
	]);
	assert.deepEqual(timeless(yolo), {
		...HEAD,
		type: "yolo",
		on: true,
		how: "dialog",
	});
	assert.equal(gate.records().length, 2);
});

test("after Allow all (YOLO), the next ask runs with no dialog", async () => {
	const gate = await loadGateSession();
	await gate.handler(bashCall("rm -rf a"), scriptedUI([ALLOW_ALL]).ctx);
	const next = scriptedUI();
	assert.equal(
		await gate.handler(bashCall("git reset --hard"), next.ctx),
		undefined,
	);
	assert.equal(next.dialogs.length, 0);
});

test("Allow all (YOLO) after an Allow once keeps the earlier answer", async () => {
	const gate = await loadGateSession();
	const { ctx, dialogs } = scriptedUI(["Allow once", ALLOW_ALL]);
	assert.equal(await gate.handler(bashCall(THREE_ASKS), ctx), undefined);
	assert.equal(dialogs.length, 2);
	const asks = gate.records()[0]?.asks as { answer: string }[] | undefined;
	assert.deepEqual(
		asks?.map((ask) => ask.answer),
		["allow-once", "allow-all", "yolo"],
	);
});

test("Allow all (YOLO) adds no session allow", async () => {
	const gate = await loadGateSession();
	await gate.handler(bashCall("rm -rf a"), scriptedUI([ALLOW_ALL]).ctx);
	await gate.runCommand("yolo", "off");
	const again = scriptedUI(["Deny"]);
	const result = await gate.handler(bashCall("rm -rf a"), again.ctx);
	assert.equal(result?.block, true);
	assert.equal(again.dialogs.length, 1);
});

test("a line with a hard deny never offers Allow all (YOLO)", async () => {
	const gate = await loadGateSession();
	const { ctx, dialogs } = scriptedUI();
	const result = await gate.handler(bashCall("rm -rf a && sudo ls"), ctx);
	assert.equal(result?.block, true);
	assert.equal(dialogs.length, 0);
	assert.equal(gate.mode.mode, "off");
});

const FLAG = { flags: { yolo: true } };

test("with --yolo, the first session start turns YOLO mode on", async () => {
	const gate = await loadGateSession(undefined, undefined, FLAG);
	const { ctx, statuses, notices } = uiContext();
	await gate.startSession("startup", ctx);
	assert.equal(gate.mode.mode, "yolo");
	assert.deepEqual(statuses, { bouncer: YOLO_STATUS });
	assert.deepEqual(notices, [ON_NOTICE]);
	const [yolo, session] = gate.records();
	assert.deepEqual(timeless(yolo), {
		...HEAD,
		type: "yolo",
		on: true,
		how: "flag",
	});
	assert.equal(session?.type, "session");
	assert.equal(session?.yolo, true);
	const asked = scriptedUI();
	assert.equal(
		await gate.handler(bashCall("rm -rf dist"), asked.ctx),
		undefined,
	);
	assert.equal(asked.dialogs.length, 0);
});

test("--yolo applies once: /yolo off then a reload stays off", async () => {
	const first = await loadGateSession(undefined, undefined, FLAG);
	await first.startSession("startup");
	await first.runCommand("yolo", "off");
	const reloaded = await loadGateSession(undefined, first.logDir, {
		...FLAG,
		mode: first.mode,
	});
	const { ctx, statuses } = uiContext();
	await reloaded.startSession("reload", ctx);
	assert.equal(reloaded.mode.mode, "off");
	assert.deepEqual(statuses, { bouncer: undefined });
	const flagged = reloaded.records().filter((r) => r.how === "flag");
	assert.equal(flagged.length, 1);
});

test("--yolo writes no second flag record at a later session start", async () => {
	const gate = await loadGateSession(undefined, undefined, FLAG);
	await gate.startSession("startup");
	await gate.startSession("new");
	const flagged = gate.records().filter((r) => r.type === "yolo");
	assert.equal(flagged.length, 1);
	assert.equal(gate.mode.mode, "yolo");
});

test("without --yolo, a session start leaves YOLO mode off", async () => {
	const gate = await loadGateSession(undefined, undefined, {
		flags: { yolo: false },
	});
	await gate.startSession("startup");
	assert.equal(gate.mode.mode, "off");
	assert.deepEqual(
		gate.records().map((r) => r.type),
		["session"],
	);
});

test("YOLO mode blocks grep x f with the steer reason and no notice", async () => {
	const { handler } = await yoloGate(PREFER_RG);
	const { ctx, dialogs, notices } = scriptedUI();
	const result = await handler(bashCall("grep x f"), ctx);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /\(rule: grep\)/);
	assert.match(result?.reason ?? "", /rg/);
	assert.deepEqual(dialogs, []);
	assert.deepEqual(notices, []);
});
