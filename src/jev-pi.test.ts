// Jev through Pi's classifier registry (`auto.jev.model`). The default Zen path is
// pinned by auto-jev.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { answersFor, fourFor } from "../test/jev-replies.ts";
import type { AutoSettings } from "./config.ts";
import { jevAsker, jevStatus } from "./jev.ts";
import { judgeRequest } from "./judge-request.ts";
import {
	type Ruling,
	type RulingRegistry,
	ruleLine,
	rulingFailures,
} from "./ruling.ts";

const MODEL = "openrouter/typesafe/jev-1.13";
const KEY = "sk-or-secret";
const REQUEST = judgeRequest({
	command: "rm -rf build",
	asks: [{ rule: "rm", summary: "deletes build", source: "built-in" }],
	cwd: "/work",
});

type Question = { readonly type: string };
type Call = {
	readonly model: unknown;
	readonly context: {
		readonly state: { readonly command?: string };
		readonly questions: Readonly<Record<string, Question>>;
	};
	readonly options: {
		readonly signal: AbortSignal;
		readonly maxRetries: number;
	};
};

// Pi's shape: `bool` answers carry `probability`, not SystemOne's `noul`.
function piAnswers(safe: number): Record<string, object> {
	const answers = answersFor(safe, fourFor(0), 0.8);
	for (const id of ["created", "risky_target"]) {
		const { noul } = answers[id] as { noul: number };
		answers[id] = { type: "bool", probability: noul };
	}
	return answers;
}

function fakePi(
	reply: (call: Call) => object,
	{ auth = true, known = true } = {},
): { registry: RulingRegistry; calls: Call[]; lookups: unknown[][] } {
	const calls: Call[] = [];
	const lookups: unknown[][] = [];
	const found = { id: "typesafe/jev-1.13", provider: "openrouter" };
	const registry = {
		find: (): undefined => undefined,
		hasConfiguredAuth: (model: unknown): boolean => model === found && auth,
		streamSimple: (): never => assert.fail("no judge expected"),
		getApiKeyForProvider: async (
			provider: string,
		): Promise<string | undefined> =>
			provider === "openrouter" ? KEY : undefined,
		getModelOfType: (...args: unknown[]): object | undefined => {
			lookups.push(args);
			return known ? found : undefined;
		},
		classify: async (
			model: unknown,
			context: unknown,
			options: unknown,
		): Promise<object> => {
			const call = { model, context, options } as Call;
			calls.push(call);
			return reply(call);
		},
	};
	return { registry: registry as unknown as RulingRegistry, calls, lookups };
}

function auto(model: string | undefined = MODEL): AutoSettings {
	const jev = model
		? { allowAt: 0.75, denyAt: null, model }
		: { allowAt: 0.75, denyAt: null };
	return {
		models: [],
		alwaysAsk: [],
		environment: [],
		firstByProvider: {},
		jev,
	};
}

function rule(registry: RulingRegistry): Promise<Ruling> {
	return ruleLine(REQUEST, auto(), undefined, { registry, sessionId: "s" });
}

test("a safe Pi answer allows, named for the model, without retries", async () => {
	const { registry, calls, lookups } = fakePi(() => ({
		answers: piAnswers(0.9),
		stopReason: "stop",
	}));
	const ruling = await rule(registry);
	assert.equal(ruling.kind, "verdict");
	assert.equal(ruling.kind === "verdict" && ruling.verdict, "allow");
	assert.equal(ruling.kind === "verdict" && ruling.model, MODEL);
	assert.equal(ruling.jev?.model, MODEL);
	assert.deepEqual(lookups, [
		["classifier", "openrouter", "typesafe/jev-1.13"],
	]);
	const [call] = calls;
	assert.equal(call?.options.maxRetries, 0);
	assert.ok(call?.options.signal instanceof AbortSignal);
	assert.equal(call?.context.state.command, "rm -rf build");
	// Pi takes `bool`; it sends SystemOne's `noul` itself.
	assert.equal(call?.context.questions["created"]?.type, "bool");
	assert.equal(call?.context.questions["risky_target"]?.type, "bool");
	assert.equal(call?.context.questions["safety"]?.type, "choice");
});

test("an unsure Pi answer goes on to the judge list", async () => {
	const { registry } = fakePi(() => ({
		answers: piAnswers(0.6),
		stopReason: "stop",
	}));
	const ruling = await rule(registry);
	assert.equal(ruling.kind, "none");
	assert.equal(
		ruling.jev && "answer" in ruling.jev && ruling.jev.answer,
		"unsure",
	);
});

test("a Pi error is a Jev failure named for the model, with the key hidden", async () => {
	const { registry } = fakePi(() => ({
		answers: {},
		stopReason: "error",
		errorMessage: `System One API returned 401: bad key ${KEY}`,
	}));
	const ruling = await rule(registry);
	assert.deepEqual(rulingFailures(ruling), [
		{ model: MODEL, error: "System One API returned 401: bad key <key>" },
	]);
	assert.doesNotMatch(JSON.stringify(ruling), new RegExp(KEY));
});

test("a model Pi does not know, or without auth, is never called", async () => {
	for (const [options, error] of [
		[{ known: false }, "not a classifier model in Pi's catalogue"],
		[{ auth: false }, "no configured auth"],
	] as const) {
		const { registry, calls } = fakePi(() => assert.fail(), options);
		const ruling = await rule(registry);
		assert.deepEqual(rulingFailures(ruling), [{ model: MODEL, error }]);
		assert.equal(calls.length, 0);
	}
});

test("an aborted turn reports the abort, not Pi's text", async () => {
	const { registry } = fakePi((call) => {
		assert.ok(call.options.signal.aborted);
		return { answers: {}, stopReason: "aborted", errorMessage: "aborted" };
	});
	const ask = await jevAsker(registry, MODEL);
	assert.equal(typeof ask, "function");
	if (typeof ask === "string") return;
	const call = await ask(REQUEST, AbortSignal.abort());
	assert.equal("error" in call && call.error, "the call was aborted");
});

test("/auto status names the model and whether it resolves", async () => {
	const settings = auto().jev;
	assert.equal(
		await jevStatus(settings, fakePi(() => ({})).registry),
		`Jev: on (allowAt 0.75, denyAt none); ${MODEL}: resolves`,
	);
	assert.equal(
		await jevStatus(settings, fakePi(() => ({}), { auth: false }).registry),
		`Jev: on (allowAt 0.75, denyAt none); ${MODEL}: no configured auth`,
	);
});
