// Jev, which auto mode asks before the judge list, through the tool_call handler: the route's
// `auto.jev` opts in, a stubbed global `fetch` scripts Jev's replies and
// records each request, and the fake registry gives the opencode-go key. No
// test reaches the network or spends quota.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import {
	autoVerdict,
	flush,
	judgedGate,
	judgedUI,
	listedGate,
	listGate,
	noUI,
	registryUI,
} from "./auto-harness.ts";
import {
	bashCall,
	fakeRegistry,
	loadGateSession,
	type ModelReply,
	tempProjectDir,
	uiContext,
	verdict,
	writeProjectConfig,
} from "./harness.ts";

const KEY = "sk-go-test";
const KEYS: Readonly<Record<string, string>> = { "opencode-go": KEY };
const ZEN = "https://opencode.ai/zen/v1/systemone";
const JEV = "opencode-go/jev-1.13";

/** A SystemOne reply with these probabilities for the safety question. */
function jevReply(safe: number, unsafe: number, confidence = 0.8): string {
	return JSON.stringify({
		model: "jev-1.13",
		answers: {
			safety: {
				type: "choice",
				choice: safe >= unsafe ? "safe" : "unsafe",
				probabilities: { safe, unsafe },
				confidence,
			},
		},
	});
}

/** One request Jev's stubbed endpoint saw. */
type Sent = {
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: { readonly model: string; readonly state: object };
	readonly signal: AbortSignal | undefined;
};

/** What the stub answers: a 200 body, a status and body, or never. */
type Scripted =
	| string
	| { readonly status: number; readonly body: string }
	| "hang"
	| Promise<string>;

/**
 * Stubs the global `fetch` with Jev's endpoint: each call gets `reply()` and
 * is recorded. A hanging or pending reply rejects when its signal aborts.
 */
function stubJev(t: TestContext, reply: () => Scripted): Sent[] {
	const sent: Sent[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		(url: string, init: RequestInit): Promise<Response> => {
			const signal = init.signal ?? undefined;
			sent.push({
				url,
				headers: init.headers as Record<string, string>,
				body: JSON.parse(String(init.body)),
				signal,
			});
			const scripted = reply();
			return new Promise<Response>((resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
				if (scripted === "hang") return;
				if (typeof scripted === "string") {
					resolve(new Response(scripted, { status: 200 }));
				} else if (scripted instanceof Promise) {
					scripted.then((body) => resolve(new Response(body)), reject);
				} else {
					resolve(new Response(scripted.body, { status: scripted.status }));
				}
			});
		},
	);
	return sent;
}

type JevTrace = {
	readonly answer?: unknown;
	readonly safe?: unknown;
	readonly confidence?: unknown;
	readonly error?: unknown;
	readonly ms?: unknown;
};

type AutoRecord = {
	readonly verdict?: unknown;
	readonly model?: unknown;
	readonly tried?: unknown;
	readonly jev?: JevTrace;
	readonly discarded?: unknown;
};

function autoOf(gate: { records(): { auto?: unknown }[] }): AutoRecord {
	return (gate.records().at(-1)?.auto ?? {}) as AutoRecord;
}

/** A bouncer in auto mode with `auto.jev` set to `jev`, its judge `judge`. */
function jevGate(
	jev: unknown,
	judge: ModelReply = verdict("deny", "Not asked for."),
	auto: object = {},
	keys: Readonly<Record<string, string>> = KEYS,
): ReturnType<typeof judgedGate> {
	return judgedGate(judge, { ...auto, jev }, undefined, keys);
}

test("a safe answer at allowAt runs the line with no dialog and no judge-list call", async (t) => {
	const sent = stubJev(t, () => jevReply(0.95, 0.05, 0.9));
	const { gate, fake } = await jevGate({ allowAt: 0.9 });
	const ui = judgedUI(fake);
	assert.equal(await gate.handler(bashCall("rm -rf dist"), ui.ctx), undefined);
	assert.deepEqual(ui.dialogs, []);
	assert.deepEqual(ui.notices, []);
	assert.deepEqual(fake.requests, []);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.url, ZEN);
	assert.equal(sent[0]?.headers["Authorization"], `Bearer ${KEY}`);
	assert.equal(sent[0]?.body.model, "jev-1.13");
	const record = gate.records().at(-1);
	assert.equal(record?.outcome, "allowed");
	assert.equal(autoVerdict(record), "allow");
	const auto = autoOf(gate);
	assert.equal(auto.model, JEV);
	assert.deepEqual(auto.tried, []);
	assert.equal(auto.jev?.answer, "safe");
	assert.equal(auto.jev?.safe, 0.95);
	assert.equal(auto.jev?.confidence, 0.9);
	assert.equal(typeof auto.jev?.ms, "number");
});

const BELOW_OR_UNSAFE: readonly (readonly [label: string, reply: string])[] = [
	["a safe answer below allowAt", jevReply(0.8, 0.2)],
	["an unsafe answer", jevReply(0.03, 0.97, 0.95)],
];

for (const [label, reply] of BELOW_OR_UNSAFE) {
	test(`${label} goes to the judge list, whose verdict takes effect`, async (t) => {
		const sent = stubJev(t, () => reply);
		const { gate, fake } = await jevGate(
			{ allowAt: 0.9, denyAt: 0.9 },
			verdict("deny", "Not asked for."),
		);
		const ui = judgedUI(fake);
		const result = await gate.handler(bashCall("rm -rf dist"), ui.ctx);
		assert.equal(sent.length, 1);
		assert.equal(fake.requests.length, 1);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /: Not asked for\. Command:/);
		const auto = autoOf(gate);
		assert.equal(auto.verdict, "deny");
		assert.equal(auto.model, "fake/judge");
		assert.equal(auto.jev?.answer, "unsure");
		assert.deepEqual(ui.notices.length, 1);
	});
}

test("with auto.jev {} Jev is asked and logged but decides nothing", async (t) => {
	const sent = stubJev(t, () => jevReply(1, 0, 1));
	const { gate, fake } = await jevGate({}, verdict("allow", "Build output."));
	assert.equal(
		await gate.handler(bashCall("rm -rf dist"), judgedUI(fake).ctx),
		undefined,
	);
	assert.equal(sent.length, 1);
	assert.equal(fake.requests.length, 1);
	const auto = autoOf(gate);
	assert.equal(auto.model, "fake/judge");
	assert.deepEqual(auto.jev && { ...auto.jev, ms: 0 }, {
		answer: "unsure",
		safe: 1,
		confidence: 1,
		ms: 0,
	});
});

const FAILURES: readonly (readonly [
	label: string,
	reply: Scripted,
	keys: Readonly<Record<string, string>>,
	error: string,
])[] = [
	[
		"an HTTP 500",
		{ status: 500, body: "upstream exploded" },
		KEYS,
		"HTTP 500: upstream exploded",
	],
	[
		"a non-JSON reply",
		"<html>oops</html>",
		KEYS,
		"reply was not JSON: <html>oops</html>",
	],
	[
		"a reply without the question's answer",
		JSON.stringify({ model: "jev-1.13", answers: {} }),
		KEYS,
		"reply has no safety answer",
	],
	["a missing opencode-go key", jevReply(0.99, 0.01), {}, "no opencode-go key"],
];

for (const [label, reply, keys, error] of FAILURES) {
	test(`${label} goes to the judge list, is logged and is reported once`, async (t) => {
		const sent = stubJev(t, () => reply);
		const { gate, fake } = await jevGate(
			{ allowAt: 0.9 },
			verdict("allow", "Build output."),
			{},
			keys,
		);
		const ui = judgedUI(fake);
		assert.equal(
			await gate.handler(bashCall("rm -rf dist"), ui.ctx),
			undefined,
		);
		assert.equal(sent.length, Object.keys(keys).length === 0 ? 0 : 1);
		assert.equal(fake.requests.length, 1);
		const auto = autoOf(gate);
		assert.equal(auto.verdict, "allow");
		assert.equal(auto.model, "fake/judge");
		assert.equal(auto.jev?.error, error);
		assert.equal(typeof auto.jev?.ms, "number");
		assert.deepEqual(ui.notices, [
			{
				message: `Auto: ${JEV} unavailable, using fake/judge`,
				level: "warning",
			},
		]);
		const again = judgedUI(fake);
		await gate.handler(bashCall("rm -rf out"), again.ctx);
		assert.equal(autoOf(gate).jev?.error, error);
		assert.deepEqual(again.notices, []);
	});
}

test("a registry whose key lookup throws is a Jev failure with its own error", async (t) => {
	const sent = stubJev(t, () => jevReply(0.99, 0.01));
	const { gate, fake } = await jevGate(
		{ allowAt: 0.9 },
		verdict("allow", "Build output."),
	);
	const locked = (): Promise<string | undefined> =>
		Promise.reject(new Error("keychain locked"));
	Object.assign(fake.registry as object, { getApiKeyForProvider: locked });
	const ui = judgedUI(fake);
	assert.equal(await gate.handler(bashCall("rm -rf dist"), ui.ctx), undefined);
	assert.equal(sent.length, 0);
	assert.equal(fake.requests.length, 1);
	const auto = autoOf(gate);
	assert.equal(auto.verdict, "allow");
	assert.equal(auto.model, "fake/judge");
	assert.equal(auto.jev?.error, "keychain locked");
	assert.deepEqual(ui.notices, [
		{
			message: `Auto: ${JEV} unavailable, using fake/judge`,
			level: "warning",
		},
	]);
	const status = registryUI(fake);
	await gate.runCommand("auto", "status", status.ctx);
	assert.match(
		status.notices[0]?.message ?? "",
		/Jev: on \(allowAt 0\.9, denyAt none\); keychain locked/,
	);
});

test("a Jev failure with no judge available is listed in the no-judge notice", async (t) => {
	stubJev(t, () => ({ status: 500, body: "down" }));
	const { gate, fake } = await jevGate({ allowAt: 0.9 }, "not json");
	const ui = judgedUI(fake, ["Allow once"]);
	await gate.handler(bashCall("rm -rf dist"), ui.ctx);
	assert.deepEqual(ui.notices, [
		{
			message: `Auto: no judge available (${JEV}: HTTP 500: down; fake/judge: no parseable verdict). The auto-judge-list skill can fix the list.`,
			level: "warning",
		},
	]);
});

test("Jev's key never appears in a logged error", async (t) => {
	stubJev(t, () => ({ status: 401, body: `bad key ${KEY}` }));
	const { gate, fake } = await jevGate(
		{ allowAt: 0.9 },
		verdict("allow", "ok"),
	);
	await gate.handler(bashCall("rm -rf dist"), noUI(fake));
	assert.equal(autoOf(gate).jev?.error, "HTTP 401: bad key <key>");
	assert.ok(!JSON.stringify(gate.records()).includes(KEY));
});

test("a Jev call with no reply in 5 s goes to the judge list", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const sent = stubJev(t, () => "hang");
	const { gate, fake } = await jevGate(
		{ allowAt: 0.9 },
		verdict("allow", "ok"),
	);
	const ui = judgedUI(fake);
	const pending = gate.handler(bashCall("rm -rf dist"), ui.ctx);
	await flush();
	assert.equal(sent.length, 1);
	t.mock.timers.tick(4_999);
	await flush();
	assert.equal(sent[0]?.signal?.aborted, false);
	assert.equal(fake.requests.length, 0);
	t.mock.timers.tick(1);
	assert.equal(await pending, undefined);
	assert.equal(sent[0]?.signal?.aborted, true);
	assert.equal(fake.requests.length, 1);
	assert.deepEqual(autoOf(gate).jev, {
		error: "no reply within 5 s",
		ms: 5_000,
	});
	assert.deepEqual(ui.notices, [
		{ message: `Auto: ${JEV} unavailable, using fake/judge`, level: "warning" },
	]);
});

test("after Jev's 5 s the judge list gets the line's remaining 15 s, not a fresh 20 s", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	stubJev(t, () => "hang");
	const first = "fake/first";
	const { gate, fake } = await listGate(
		[first, "fake/judge"],
		{
			[first]: { reply: "hang" },
			"fake/judge": { reply: "hang" },
		},
		{ jev: { allowAt: 0.9 } },
		KEYS,
	);
	const pending = gate.handler(bashCall("rm -rf dist"), noUI(fake));
	await flush();
	t.mock.timers.tick(5_000);
	await flush();
	assert.equal(fake.requests.length, 1);
	t.mock.timers.tick(10_000);
	await flush();
	assert.equal(fake.requests.length, 2);
	t.mock.timers.tick(4_999);
	await flush();
	assert.equal(fake.requests[1]?.signal?.aborted, false);
	// The second entry started at 15 s; the line ends at 20 s, before its 10 s.
	t.mock.timers.tick(1);
	await flush();
	assert.equal(fake.requests[1]?.signal?.aborted, true);
	const result = await pending;
	assert.equal(result?.block, true);
	const auto = autoOf(gate);
	assert.equal(auto.verdict, "none");
	assert.deepEqual(auto.tried, [
		{ model: first, error: "no reply within 10 s" },
		{ model: "fake/judge", error: "the line's 20 s ran out" },
	]);
	assert.deepEqual(auto.jev, { error: "no reply within 5 s", ms: 5_000 });
});

test("aborting the turn while Jev is out aborts its request", async (t) => {
	const sent = stubJev(t, () => "hang");
	const { gate, fake } = await jevGate(
		{ allowAt: 0.9 },
		verdict("allow", "ok"),
	);
	const ui = judgedUI(fake, [undefined]);
	const pending = gate.handler(bashCall("rm -rf dist"), ui.ctx);
	await flush();
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.signal?.aborted, false);
	ui.cancelTurn();
	await flush();
	assert.equal(sent[0]?.signal?.aborted, true);
	const result = await pending;
	assert.deepEqual(fake.requests, []);
	assert.equal(result?.block, true);
	assert.equal(autoOf(gate).jev?.error, "the call was aborted");
});

const NEVER_ASKED: readonly (readonly [
	command: string,
	rule: string,
	levels?: object,
])[] = [
	["sudo ls", "privilege"],
	["rm -rf ~", "rm-root", { "rm-root": "ask" }],
	["rm -rf dist", "recursive-rm", { "recursive-rm": "deny" }],
	["grep -r TODO src", "grep"],
];

for (const [command, rule, levels] of NEVER_ASKED) {
	test(`${command} (${rule}) is denied without asking Jev`, async (t) => {
		const sent = stubJev(t, () => jevReply(1, 0, 1));
		const { gate, fake } = await judgedGate(
			verdict("allow", "ok"),
			{ jev: { allowAt: 0.9 } },
			levels,
			KEYS,
		);
		const result = await gate.handler(bashCall(command), judgedUI(fake).ctx);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", new RegExp(`\\(rule: ${rule}\\)`));
		assert.deepEqual(sent, []);
		assert.deepEqual(fake.requests, []);
	});
}

test("an alwaysAsk hit opens the dialog without asking Jev", async (t) => {
	const sent = stubJev(t, () => jevReply(1, 0, 1));
	const { gate, fake } = await jevGate(
		{ allowAt: 0.9 },
		verdict("allow", "ok"),
		{ alwaysAsk: ["terraform apply"] },
	);
	const ui = judgedUI(fake, ["Allow once"]);
	await gate.handler(bashCall("terraform apply"), ui.ctx);
	assert.equal(ui.dialogs.length, 1);
	assert.deepEqual(sent, []);
	assert.deepEqual(autoOf(gate), { verdict: "always-ask", tried: [] });
});

test("a paused auto mode opens the dialog without asking Jev", async (t) => {
	const sent = stubJev(t, () => jevReply(0.1, 0.9));
	const { gate, fake } = await jevGate(
		{ allowAt: 0.9 },
		verdict("deny", "No."),
	);
	const ui = judgedUI(fake, ["Deny"]);
	for (const dir of ["a", "b", "c"]) {
		await gate.handler(bashCall(`rm -rf ${dir}`), ui.ctx);
	}
	assert.equal(ui.statuses["bouncer"], "<warning>🤖 AUTO (paused)</warning>");
	assert.equal(sent.length, 3);
	await gate.handler(bashCall("rm -rf d"), ui.ctx);
	assert.equal(ui.dialogs.length, 1);
	assert.equal(sent.length, 3);
	assert.equal(autoVerdict(gate.records().at(-1)), "paused");
});

test("a line session allows cover runs without asking Jev", async (t) => {
	const sent = stubJev(t, () => jevReply(1, 0, 1));
	const fake = fakeRegistry(
		{ "fake/judge": { reply: verdict("deny", "No.") } },
		KEYS,
	);
	const gate = await listedGate(["fake/judge"], { jev: { allowAt: 0.9 } });
	const first = judgedUI(fake, ["Allow for this session"]);
	assert.equal(
		await gate.handler(bashCall("rm -rf dist"), first.ctx),
		undefined,
	);
	await gate.runCommand("auto", "", registryUI(fake).ctx);
	assert.equal(gate.mode.mode, "auto");
	const ui = judgedUI(fake);
	assert.equal(await gate.handler(bashCall("rm -rf dist"), ui.ctx), undefined);
	assert.deepEqual(sent, []);
	assert.deepEqual(fake.requests, []);
});

test("a route without auto.jev never asks Jev, even with the key", async (t) => {
	const sent = stubJev(t, () => jevReply(1, 0, 1));
	const { gate, fake } = await judgedGate(
		verdict("allow", "ok"),
		{},
		undefined,
		KEYS,
	);
	assert.equal(
		await gate.handler(bashCall("rm -rf dist"), judgedUI(fake).ctx),
		undefined,
	);
	assert.deepEqual(sent, []);
	assert.equal(fake.requests.length, 1);
	assert.equal(Object.hasOwn(autoOf(gate), "jev"), false);
});

test("a project's auto.jev is ignored with the route-only warning, and Jev stays off", async (t) => {
	const sent = stubJev(t, () => jevReply(1, 0, 1));
	const fake = fakeRegistry(
		{ "fake/judge": { reply: verdict("allow", "ok") } },
		KEYS,
	);
	const gate = await loadGateSession();
	const cwd = tempProjectDir();
	gate.writeRouteConfig({ auto: { models: ["fake/judge"] } });
	writeProjectConfig(cwd, {
		auto: { models: ["fake/judge"], jev: { allowAt: 0.6 } },
	});
	const start = uiContext(cwd);
	await gate.startSession("startup", start.ctx);
	assert.deepEqual(
		start.notices.map((notice) => notice.message),
		[
			`Bouncer config problems; these parts are ignored:\n- ${cwd}/.pi/extensions/bouncer/config.json: "auto" is ignored in a project file: only the route sets auto mode`,
		],
	);
	await gate.runCommand("auto", "", registryUI(fake).ctx);
	await gate.handler(bashCall("rm -rf dist"), judgedUI(fake).ctx);
	assert.deepEqual(sent, []);
	assert.equal(fake.requests.length, 1);
});

for (const jev of [true, { allowAt: 0.4 }, { allowAt: 0.9, denyAt: "x" }]) {
	test(`an invalid auto.jev ${JSON.stringify(jev)} leaves Jev off`, async (t) => {
		const sent = stubJev(t, () => jevReply(1, 0, 1));
		const { gate, fake } = await jevGate(jev, verdict("allow", "ok"));
		await gate.handler(bashCall("rm -rf dist"), judgedUI(fake).ctx);
		assert.deepEqual(sent, []);
		assert.equal(fake.requests.length, 1);
		assert.equal(Object.hasOwn(autoOf(gate), "jev"), false);
	});
}

test("/auto off while Jev is out drops its allow, with auto.discarded", async (t) => {
	let release: (body: string) => void = () => {};
	const held = new Promise<string>((resolve) => {
		release = resolve;
	});
	const sent = stubJev(t, () => held);
	const { gate, fake } = await jevGate(
		{ allowAt: 0.9 },
		verdict("allow", "ok"),
	);
	const ui = judgedUI(fake, ["Allow once"]);
	const pending = gate.handler(bashCall("rm -rf dist"), ui.ctx);
	await flush();
	assert.equal(sent.length, 1);
	await gate.runCommand("auto", "off", registryUI(fake).ctx);
	release(jevReply(0.95, 0.05, 0.9));
	assert.equal(await pending, undefined);
	assert.equal(ui.dialogs.length, 1);
	assert.deepEqual(fake.requests, []);
	const record = gate.records().at(-1);
	assert.deepEqual(record?.asks, [
		{ rule: "recursive-rm", source: "rm -rf dist", answer: "allow-once" },
	]);
	const auto = autoOf(gate);
	assert.equal(auto.verdict, "allow");
	assert.equal(auto.model, JEV);
	assert.equal(auto.jev?.answer, "safe");
	assert.equal(auto.discarded, true);
});

/** The `/auto status` notice, with the registry `fake` in the context. */
async function statusText(
	gate: Awaited<ReturnType<typeof judgedGate>>["gate"],
	fake: ReturnType<typeof fakeRegistry>,
): Promise<string> {
	const ui = registryUI(fake);
	await gate.runCommand("auto", "status", ui.ctx);
	assert.equal(ui.notices.length, 1);
	return ui.notices[0]?.message ?? "";
}

const STATUS_LINES: readonly (readonly [
	label: string,
	jev: object | undefined,
	keys: Readonly<Record<string, string>>,
	line: string,
])[] = [
	["off", undefined, KEYS, "Jev: off"],
	[
		"on with a key",
		{ allowAt: 0.9 },
		KEYS,
		"Jev: on (allowAt 0.9, denyAt none); opencode-go key resolves",
	],
	[
		"on without a key",
		{ denyAt: 0.97 },
		{},
		"Jev: on (allowAt none, denyAt 0.97); no opencode-go key",
	],
];

for (const [label, jev, keys, line] of STATUS_LINES) {
	test(`/auto status shows Jev ${label}`, async (t) => {
		const sent = stubJev(t, () => jevReply(1, 0, 1));
		const auto = jev ? { jev } : {};
		const { gate, fake } = await judgedGate(
			verdict("allow", "ok"),
			auto,
			undefined,
			keys,
		);
		assert.equal(
			await statusText(gate, fake),
			[
				"Bouncer auto mode: auto (paused: no)",
				line,
				"Judge list:",
				"- fake/judge: resolves",
				"Last failures this session: none",
				"Always ask: none",
				"0 environment facts",
			].join("\n"),
		);
		assert.deepEqual(sent, []);
		assert.deepEqual(fake.requests, []);
	});
}

test("/auto status lists Jev's last failure with the judge list's", async (t) => {
	stubJev(t, () => ({ status: 500, body: "down" }));
	const { gate, fake } = await jevGate(
		{ allowAt: 0.9 },
		verdict("allow", "ok"),
	);
	await gate.handler(bashCall("rm -rf dist"), noUI(fake));
	assert.match(
		await statusText(gate, fake),
		/\nLast failures this session:\n- opencode-go\/jev-1\.13: HTTP 500: down\n/,
	);
});
