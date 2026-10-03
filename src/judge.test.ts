import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type JudgeCallOptions,
	type JudgeModel,
	type JudgeRegistry,
	runJudge,
	withVerdictSchema,
} from "./judge.ts";
import { judgeRequest } from "./judge-request.ts";

const ASK = '{"verdict":"ask","reason":"$T is never assigned."}';

test("the verdict schema keeps the request's other output settings", () => {
	assert.deepEqual(
		withVerdictSchema({ model: "m", output_config: { effort: "low" } }),
		{
			model: "m",
			output_config: {
				effort: "low",
				format: {
					type: "json_schema",
					schema: {
						type: "object",
						properties: {
							verdict: { type: "string", enum: ["allow", "ask", "deny"] },
							reason: { type: "string" },
						},
						required: ["verdict", "reason"],
						additionalProperties: false,
					},
				},
			},
		},
	);
});

test("only an Anthropic Messages model other than Haiku is sent the verdict schema", async () => {
	const sent: Record<string, JudgeCallOptions> = {};
	const models: Record<string, JudgeModel> = {
		claude: {
			id: "claude",
			provider: "a",
			reasoning: false,
			api: "anthropic-messages",
		},
		"claude-haiku-4-5": {
			id: "claude-haiku-4-5",
			provider: "a",
			reasoning: false,
			api: "anthropic-messages",
		},
		other: {
			id: "other",
			provider: "b",
			reasoning: false,
			api: "openai-completions",
		},
	};
	const registry: JudgeRegistry = {
		find: (_provider: string, id: string) => models[id],
		hasConfiguredAuth: () => true,
		streamSimple: (
			model: JudgeModel,
			_context: unknown,
			options: JudgeCallOptions,
		) => {
			sent[model.id] = options;
			const text = model.id === "other" ? ASK : "no";
			return {
				result: () =>
					Promise.resolve({
						content: [{ type: "text", text }],
						stopReason: "stop",
					}),
			};
		},
	};
	const request = judgeRequest({
		command: "rm -rf /tmp/x",
		asks: [],
		cwd: "/",
	});
	await runJudge(["a/claude", "a/claude-haiku-4-5", "b/other"], request, {
		registry,
		sessionId: "s",
	});
	assert.equal(sent["claude"]?.onPayload, withVerdictSchema);
	assert.equal(sent["claude-haiku-4-5"]?.onPayload, undefined);
	assert.equal(sent["other"]?.onPayload, undefined);
});
