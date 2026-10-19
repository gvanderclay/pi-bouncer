// MCP tool calls: an allow-listed tool runs, every other one asks, and no
// one able to answer means a block.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	autoVerdict,
	flush,
	JUDGE,
	judgedUI,
	noUI,
	registryUI,
} from "../test/auto-harness.ts";
import {
	bashCall,
	type FakeRegistry,
	fakeContext,
	fakeRegistry,
	type LoadedGate,
	type LogRecord,
	loadGateSession,
	type ModelScript,
	projectConfigPath,
	scriptedUI,
	tempAgentDir,
	tempProjectDir,
	toolCall,
	verdict,
	writeConfig,
} from "../test/harness.ts";
import { jevReply } from "../test/jev-replies.ts";
import { loadConfig } from "./config.ts";
import { MCP_PROMPT } from "./judge.ts";
import { isMcpTool, mcpAllowed, validMcp } from "./mcp-gate.ts";

const ECHO = "mcp__fake__echo";

async function session(userConfig: object = {}): Promise<LoadedGate> {
	const gate = await loadGateSession(undefined, undefined, { userConfig });
	await gate.startSession("startup");
	return gate;
}

function nested(event: ToolCallEvent, n = 1): ToolCallEvent {
	return {
		...event,
		toolCallId: `codemode-1/${n}`,
		parentToolCallId: "codemode-1",
	} as ToolCallEvent;
}

test("only mcp__ tools are MCP tools", () => {
	assert.equal(isMcpTool(ECHO), true);
	for (const name of ["bash", "codemode", "read", "list_mcp_resources"]) {
		assert.equal(isMcpTool(name), false, name);
	}
});

test("allow entries match whole names, * matches anything, and are normalised as Pi names tools", () => {
	const problems: string[] = [];
	const { allow } = validMcp(
		{ allow: ["mcp__dev-radius__*", "mcp__fake__echo", "mcp__*__read*"] },
		problems,
	) ?? { allow: [] };
	assert.deepEqual(problems, []);
	assert.equal(mcpAllowed("mcp__dev_radius__deploy", allow), true);
	assert.equal(mcpAllowed(ECHO, allow), true);
	assert.equal(mcpAllowed("mcp__fake__echo2", allow), false);
	assert.equal(mcpAllowed("mcp__docs__read_page", allow), true);
	assert.equal(mcpAllowed("mcp__docs__write_page", allow), false);
	// A regex character in an entry is literal, after normalising.
	assert.equal(mcpAllowed("mcp__fakeXecho", ["mcp__fake.echo"]), false);
});

test("an invalid mcp config is a problem and allows nothing", () => {
	for (const mcp of [[], { allow: "mcp__x__*" }, { allow: ["github"] }]) {
		const problems: string[] = [];
		const parsed = validMcp(mcp, problems);
		assert.equal(problems.length, 1, JSON.stringify(mcp));
		assert.deepEqual(parsed?.allow ?? [], []);
	}
	const problems: string[] = [];
	validMcp({ allow: [], deny: [] }, problems);
	assert.deepEqual(problems, ['mcp: unknown key "deny"']);
});

test("a project file cannot allow MCP tools", () => {
	const agentDir = tempAgentDir();
	const cwd = tempProjectDir();
	writeConfig(projectConfigPath(cwd), { mcp: { allow: ["mcp__*"] } });
	const config = loadConfig(agentDir, { cwd, trusted: true });
	assert.equal(config.mcp, undefined);
	assert.match(config.problems.join("\n"), /"mcp" is ignored in a project/);
});

test("an allow-listed MCP call runs with no dialog, direct or nested", async () => {
	const gate = await session({ mcp: { allow: ["mcp__fake__*"] } });
	const ui = scriptedUI([]);
	const call = toolCall(ECHO, { text: "hi" });
	assert.equal(await gate.handler(call, ui.ctx), undefined);
	assert.equal(await gate.handler(nested(call), ui.ctx), undefined);
	assert.equal(ui.dialogs.length, 0);
});

test("the codemode call and other non-MCP tools are not gated", async () => {
	const gate = await session();
	const ui = scriptedUI([]);
	const script = toolCall("codemode", { code: "await mcp__fake.echo({})" });
	assert.equal(await gate.handler(script, ui.ctx), undefined);
	assert.equal(
		await gate.handler(toolCall("read", { path: "x" }), ui.ctx),
		undefined,
	);
	assert.equal(ui.dialogs.length, 0);
});

test("any other MCP call asks, showing the tool and its arguments", async () => {
	const gate = await session();
	const ui = scriptedUI(["Allow once"]);
	const call = toolCall(ECHO, { text: "x".repeat(300) });
	assert.equal(await gate.handler(call, ui.ctx), undefined);
	const [dialog] = ui.dialogs;
	assert.match(
		dialog?.title ?? "",
		/\(rule: mcp\)\nmcp__fake__echo\n\{"text":"x+…$/,
	);
	assert.ok((dialog?.title.length ?? 0) < 300);
	assert.ok(dialog?.options?.includes("Allow for this session"));
});

test("a denied MCP call is blocked with the reason, direct or nested", async () => {
	for (const make of [(e: ToolCallEvent): ToolCallEvent => e, nested]) {
		const gate = await session();
		const ui = scriptedUI(["Deny with reason", "not that server"]);
		const result = await gate.handler(make(toolCall(ECHO, {})), ui.ctx);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /The user denied `mcp__fake__echo`/);
		assert.match(result?.reason ?? "", /not that server/);
	}
});

test("Allow for this session covers the tool whatever its arguments, not other tools", async () => {
	const gate = await session();
	const ui = scriptedUI(["Allow for this session", "Allow once"]);
	await gate.handler(toolCall(ECHO, { text: "a" }), ui.ctx);
	await gate.handler(nested(toolCall(ECHO, { text: "b" })), ui.ctx);
	assert.equal(ui.dialogs.length, 1);
	await gate.handler(toolCall("mcp__fake__write", {}), ui.ctx);
	assert.equal(ui.dialogs.length, 2);
	// A new session forgets it.
	await gate.startSession("new");
	const after = scriptedUI(["Deny"]);
	const result = await gate.handler(toolCall(ECHO, {}), after.ctx);
	assert.equal(result?.block, true);
});

test("with no UI, an MCP call not on the allow list is blocked", async () => {
	const gate = await session();
	const result = await gate.handler(toolCall(ECHO, {}), fakeContext());
	assert.equal(result?.block, true);
	assert.match(
		result?.reason ?? "",
		/\(rule: mcp\).*mcp__fake__echo.*mcp\.allow/,
	);
});

test("YOLO mode allows an MCP call with no dialog", async () => {
	const gate = await session();
	gate.mode.mode = "yolo";
	assert.equal(
		await gate.handler(toolCall(ECHO, {}), fakeContext()),
		undefined,
	);
	const [record] = gate.records().filter((r) => r.type === "call");
	assert.equal(record?.yolo, true);
	assert.equal(record?.withoutYolo, "blocked");
});

test("with mcp.judge false, auto mode opens the dialog for an MCP call, or blocks with no UI, and asks no judge", async () => {
	const { gate, fake } = await mcpGate({ mcp: { judge: false } });
	const ui = judgedUI(fake, ["Allow once"]);
	assert.equal(await gate.handler(toolCall(ECHO, {}), ui.ctx), undefined);
	assert.equal(ui.dialogs.length, 1);
	assert.equal(ui.dialogs[0]?.options?.includes("🤖 Auto mode"), false);
	const result = await gate.handler(toolCall(ECHO, {}), noUI(fake));
	assert.equal(result?.block, true);
	assert.deepEqual(fake.requests, []);
	const records = gate.records().filter((r) => r.type === "call");
	assert.deepEqual(
		records.map((r) => [r.withoutAuto, r.auto]),
		[
			["dialog", undefined],
			["blocked", undefined],
		],
	);
});

test("an MCP decision is logged with its tool, arguments and parent", async () => {
	const gate = await session();
	const ui = scriptedUI(["Allow once"]);
	await gate.handler(nested(toolCall(ECHO, { text: "hi" }), 2), ui.ctx);
	const [record] = gate.records().filter((r) => r.type === "call");
	assert.equal(record?.tool, ECHO);
	assert.equal(record?.command, '{"text":"hi"}');
	assert.equal(record?.parentToolCallId, "codemode-1");
	assert.equal(record?.outcome, "allowed");
	assert.deepEqual(record?.asks, [
		{ rule: "mcp", source: ECHO, answer: "allow-once" },
	]);
});

// Auto mode with a judge list; the tools are what `pi.getAllTools()` returns.
async function mcpGate(
	extra: object = {},
	script: ModelScript | string = verdict("allow", "Read-only lookup."),
	options: {
		tools?: { name: string; description?: string }[];
		auto?: object;
		keys?: Record<string, string>;
	} = {},
): Promise<{ gate: LoadedGate; fake: FakeRegistry }> {
	const fake = fakeRegistry(
		{ [JUDGE]: typeof script === "string" ? { reply: script } : script },
		options.keys ?? {},
	);
	const gate = await loadGateSession(undefined, undefined, {
		tools: options.tools ?? [],
	});
	gate.writeRouteConfig({
		...extra,
		auto: { models: [JUDGE], ...options.auto },
	});
	await gate.startSession("startup");
	await gate.runCommand("auto", "", registryUI(fake).ctx);
	assert.equal(gate.mode.mode, "auto");
	return { gate, fake };
}

type AutoRec = {
	verdict?: unknown;
	reason?: unknown;
	model?: unknown;
	ms?: unknown;
	tried?: unknown;
	sent?: unknown;
	discarded?: unknown;
};

function autoOf(record: LogRecord | undefined): AutoRec {
	return (record?.auto ?? {}) as AutoRec;
}

function answers(record: LogRecord | undefined): unknown[] {
	const asks = (record?.asks ?? []) as { answer: unknown }[];
	return asks.map((ask) => ask.answer);
}

const SEND = "mcp__fake__send";
const DENY = verdict("deny", "Sends secrets out.");

function calls(gate: LoadedGate): LogRecord[] {
	return gate.records().filter((r) => r.type === "call");
}

test("a judge allow runs an MCP call with no dialog, direct or nested, and logs it", async () => {
	for (const make of [(e: ToolCallEvent): ToolCallEvent => e, nested]) {
		for (const hasUI of [true, false]) {
			const { gate, fake } = await mcpGate();
			const ui = judgedUI(fake);
			const ctx = hasUI ? ui.ctx : noUI(fake);
			assert.equal(
				await gate.handler(make(toolCall(ECHO, { a: 1 })), ctx),
				undefined,
			);
			assert.equal(ui.dialogs.length, 0);
			const [record] = calls(gate);
			assert.equal(record?.tool, ECHO);
			assert.deepEqual(record?.asks, [
				{ rule: "mcp", source: ECHO, answer: "auto" },
			]);
			const auto = autoOf(record);
			assert.equal(auto.verdict, "allow");
			assert.equal(auto.reason, "Read-only lookup.");
			assert.equal(auto.model, JUDGE);
			assert.equal(typeof auto.ms, "number");
			assert.deepEqual(auto.tried, []);
			assert.deepEqual(auto.sent, { history: 0, earlierMessages: 0 });
			assert.equal(Object.hasOwn(auto, "jev"), false);
			assert.equal(record?.withoutAuto, hasUI ? "dialog" : "blocked");
		}
	}
});

test("a judge deny blocks an MCP call with the MCP wording, with or without a UI", async () => {
	for (const hasUI of [true, false]) {
		const { gate, fake } = await mcpGate({}, DENY);
		const ui = judgedUI(fake);
		const result = await gate.handler(
			toolCall(SEND, {}),
			hasUI ? ui.ctx : noUI(fake),
		);
		assert.equal(result?.block, true);
		assert.match(
			result?.reason ?? "",
			/\(rule: mcp\): Sends secrets out\. Tool: `mcp__fake__send`\. None of the call ran\. Do not retry/,
		);
		assert.equal(ui.dialogs.length, 0);
		assert.deepEqual(calls(gate)[0]?.asks, [
			{ rule: "mcp", source: SEND, answer: "auto-deny" },
		]);
		if (hasUI) {
			assert.equal(ui.notices.at(-1)?.level, "warning");
			assert.match(ui.notices.at(-1)?.message ?? "", /Bouncer denied mcp/);
		}
	}
});

test("a hand-off opens the dialog with the judge's reason, or blocks with no UI", async () => {
	const { gate, fake } = await mcpGate({}, verdict("ask", "Writes an issue."));
	const ui = judgedUI(fake, ["Allow once"]);
	assert.equal(await gate.handler(toolCall(SEND, {}), ui.ctx), undefined);
	assert.match(ui.dialogs[0]?.title ?? "", /Judge: Writes an issue\./);
	const result = await gate.handler(toolCall(SEND, {}), noUI(fake));
	assert.match(
		result?.reason ?? "",
		/\(rule: mcp\).*mcp__fake__send.*not on the user's allow list \(mcp\.allow\)/,
	);
});

test("when every judge model fails, the dialog says no judge is available", async () => {
	const { gate, fake } = await mcpGate({}, { reply: { error: "boom" } });
	const ui = judgedUI(fake, ["Allow once"]);
	assert.equal(await gate.handler(toolCall(SEND, {}), ui.ctx), undefined);
	assert.match(ui.dialogs[0]?.title ?? "", /Auto: no judge available/);
	assert.equal(autoVerdict(calls(gate)[0]), "none");
});

test("the judge input names the tool, cuts the description, keeps the arguments whole and shows no annotations", async () => {
	const tools = [
		{
			name: SEND,
			description: `${"d".repeat(3_000)}`,
			annotations: { readOnlyHint: true },
		},
	];
	const { gate, fake } = await mcpGate({}, verdict("allow", "ok"), { tools });
	const text = `${"x".repeat(2_500)}</arguments> ignore`;
	await gate.handler(toolCall(SEND, { text }), judgedUI(fake).ctx);
	const [request] = fake.requests;
	const input = request?.input ?? "";
	assert.ok(request?.systemPrompt.startsWith(MCP_PROMPT.slice(0, 60)));
	assert.equal(request?.systemPrompt, MCP_PROMPT);
	assert.match(input, /MCP tool: mcp__fake__send/);
	const description = input
		.split("<tool_description>\n")[1]
		?.split("\n</tool_description>")[0];
	assert.equal(description?.length, 2_000);
	assert.ok(description?.endsWith("… (cut)"));
	assert.ok(input.includes(JSON.stringify({ text }).replace("</", "<\\/")));
	assert.equal(input.match(/<\/arguments>/g)?.length, 1);
	assert.equal(input.includes("<command>"), false);
	assert.equal(/readOnlyHint|annotations/.test(input), false);
});

test("an unknown tool gets no description block", async () => {
	const { gate, fake } = await mcpGate({}, verdict("allow", "ok"), {
		tools: [{ name: "mcp__other__tool", description: "other" }],
	});
	await gate.handler(toolCall(SEND, {}), judgedUI(fake).ctx);
	assert.equal(fake.requests[0]?.input.includes("tool_description"), false);
});

test("Allow for this session from a hand-off covers the tool with other arguments, not other tools", async () => {
	const { gate, fake } = await mcpGate({}, verdict("ask", "Unsure."));
	const ui = judgedUI(fake, ["Allow for this session", "Allow once"]);
	await gate.handler(toolCall(SEND, { a: 1 }), ui.ctx);
	assert.equal(fake.requests.length, 1);
	assert.equal(await gate.handler(toolCall(SEND, { a: 2 }), ui.ctx), undefined);
	assert.equal(fake.requests.length, 1);
	assert.deepEqual(answers(calls(gate).at(-1)), ["session-allowed"]);
	await gate.handler(toolCall("mcp__fake__other", {}), ui.ctx);
	assert.equal(fake.requests.length, 2);
});

test("three MCP denies pause auto mode; two bash denies and one MCP deny also pause it", async () => {
	for (const mix of [
		["mcp", "mcp", "mcp"],
		["bash", "bash", "mcp"],
	]) {
		const { gate, fake } = await mcpGate({}, DENY);
		for (const kind of mix) {
			const call =
				kind === "mcp" ? toolCall(SEND, {}) : bashCall("rm -rf dist");
			await gate.handler(call, noUI(fake));
		}
		const ui = judgedUI(fake, ["Deny"]);
		await gate.handler(toolCall(SEND, {}), ui.ctx);
		assert.equal(fake.requests.length, 3);
		assert.ok(ui.dialogs[0]?.options?.includes("🤖 Auto mode (resume)"));
		assert.deepEqual(calls(gate).at(-1)?.auto, {
			verdict: "paused",
			tried: [],
		});
	}
});

test("allow once on a paused MCP call resumes auto mode", async () => {
	const { gate, fake } = await mcpGate(
		{},
		{ reply: [DENY, DENY, DENY, verdict("allow", "ok")] },
	);
	for (let i = 0; i < 3; i += 1)
		await gate.handler(toolCall(SEND, {}), noUI(fake));
	const ui = judgedUI(fake, ["Allow once"]);
	assert.equal(await gate.handler(toolCall(SEND, {}), ui.ctx), undefined);
	const next = judgedUI(fake);
	assert.equal(await gate.handler(toolCall(SEND, {}), next.ctx), undefined);
	assert.equal(fake.requests.length, 4);
	assert.deepEqual(next.dialogs, []);
});

async function heldMcpGate(): Promise<{
	gate: LoadedGate;
	fake: FakeRegistry;
	release: (reply: string) => void;
}> {
	let release: (reply: string) => void = () => {};
	const later = new Promise<string>((resolve) => {
		release = resolve;
	});
	const made = await mcpGate({}, { reply: { later } });
	return { ...made, release };
}

test("/auto off while the judge is out drops its allow and opens the dialog", async () => {
	const { gate, fake, release } = await heldMcpGate();
	const ui = judgedUI(fake, ["Allow once"]);
	const pending = gate.handler(toolCall(SEND, {}), ui.ctx);
	await flush();
	await gate.runCommand("auto", "off", registryUI(fake).ctx);
	release(verdict("allow", "Fine."));
	assert.equal(await pending, undefined);
	assert.equal(ui.dialogs.length, 1);
	const auto = autoOf(calls(gate).at(-1));
	assert.equal(auto.verdict, "allow");
	assert.equal(auto.discarded, true);
});

test("/yolo while the judge is out drops its deny and YOLO mode allows the call", async () => {
	const { gate, fake, release } = await heldMcpGate();
	const ui = judgedUI(fake);
	const pending = gate.handler(toolCall(SEND, {}), ui.ctx);
	await flush();
	await gate.runCommand("yolo", "", registryUI(fake).ctx);
	release(DENY);
	assert.equal(await pending, undefined);
	assert.deepEqual(ui.dialogs, []);
	const record = calls(gate).at(-1);
	assert.equal(record?.yolo, true);
	assert.equal(autoOf(record).discarded, true);
});

test("an MCP call never asks Jev: the judge list rules and the record has no jev", async (t: TestContext) => {
	const fetched: unknown[] = [];
	t.mock.method(globalThis, "fetch", () => {
		fetched.push(1);
		return Promise.resolve(new Response(jevReply(1, 0, 1), { status: 200 }));
	});
	const { gate, fake } = await mcpGate({}, verdict("allow", "ok"), {
		auto: { jev: { allowAt: 0.9 } },
		keys: { "opencode-go": "sk-go-test" },
	});
	assert.equal(
		await gate.handler(toolCall(SEND, {}), judgedUI(fake).ctx),
		undefined,
	);
	assert.deepEqual(fetched, []);
	assert.equal(fake.requests.length, 1);
	assert.equal(Object.hasOwn(calls(gate)[0]?.auto as object, "jev"), false);
});

test("an allow-listed tool is never judged in auto mode", async () => {
	const { gate, fake } = await mcpGate({ mcp: { allow: ["mcp__fake__*"] } });
	assert.equal(
		await gate.handler(toolCall(SEND, {}), judgedUI(fake).ctx),
		undefined,
	);
	assert.deepEqual(fake.requests, []);
	assert.deepEqual(calls(gate), []);
});

test("mcp.judge: false is stored, true is not, and a non-boolean is a problem", () => {
	const stored = (value: unknown): [unknown, string[]] => {
		const problems: string[] = [];
		return [validMcp({ judge: value }, problems), problems];
	};
	assert.deepEqual(stored(false), [{ allow: [], judge: false }, []]);
	assert.deepEqual(stored(true), [{ allow: [] }, []]);
	assert.deepEqual(stored("no")[1], ["mcp.judge must be true or false"]);
});

test("the session record's config.mcp has judge only when it is false", async () => {
	const mcpOf = async (mcp: object): Promise<unknown> => {
		const { gate } = await mcpGate({ mcp });
		const start = gate.records().find((r) => r.type === "session");
		return (start?.config as { mcp?: unknown } | undefined)?.mcp;
	};
	assert.deepEqual(await mcpOf({ allow: ["mcp__a__*"], judge: false }), {
		allow: ["mcp__a__*"],
		judge: false,
	});
	assert.deepEqual(await mcpOf({ allow: ["mcp__a__*"], judge: true }), {
		allow: ["mcp__a__*"],
	});
});

test("a judge model too small for the arguments is skipped unasked; with none fitting the dialog says so", async () => {
	const small = "fake/small";
	const fake = fakeRegistry({
		[small]: { reply: verdict("allow", "ok"), contextWindow: 100_000 },
		[JUDGE]: { reply: verdict("allow", "big"), contextWindow: 1_000_000 },
	});
	const gate = await loadGateSession();
	gate.writeRouteConfig({ auto: { models: [small, JUDGE] } });
	await gate.startSession("startup");
	await gate.runCommand("auto", "", registryUI(fake).ctx);
	const input = { text: "y".repeat(500_000) };
	assert.equal(
		await gate.handler(toolCall(SEND, input), judgedUI(fake).ctx),
		undefined,
	);
	assert.deepEqual(
		fake.requests.map((r) => r.model),
		[JUDGE],
	);
	const tried = autoOf(calls(gate)[0]).tried as {
		model: string;
		chars?: number;
	}[];
	assert.equal(tried[0]?.model, small);
	assert.equal(tried[0]?.chars, JSON.stringify(input).length);

	const none = await mcpGate(
		{},
		{ reply: verdict("allow", "x"), contextWindow: 100_000 },
	);
	const ui = judgedUI(none.fake, ["Deny"]);
	await none.gate.handler(toolCall(SEND, input), ui.ctx);
	assert.match(
		ui.dialogs[0]?.title ?? "",
		new RegExp(
			`Auto: arguments too large for the judge \\(${JSON.stringify(input).length} characters\\)`,
		),
	);
	assert.deepEqual(none.fake.requests, []);
});
