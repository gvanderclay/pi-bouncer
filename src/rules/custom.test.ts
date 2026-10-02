import assert from "node:assert/strict";
import { test } from "node:test";
import { judgedGate, judgedUI } from "../../test/auto-harness.ts";
import {
	bashCall,
	fakeContext,
	type LoadedGate,
	loadGateSession,
	projectConfigPath,
	scriptedUI,
	tempProjectDir,
	uiContext,
	verdict,
	writeProjectConfig,
} from "../../test/harness.ts";

const KUBECTL_DELETE = {
	name: "kubectl-delete",
	command: "kubectl",
	args: ["delete"],
	level: "deny",
	summary: "deletes cluster resources",
};

const NO_YARN = {
	name: "no-yarn",
	command: ["yarn", "yarnpkg"],
	summary: "this repo uses pnpm",
	instead: "Use pnpm instead.",
};

async function gateWith(rules: readonly object[]): Promise<LoadedGate> {
	const gate = await loadGateSession(undefined, undefined, {
		userConfig: { rules },
	});
	const ui = uiContext();
	await gate.startSession("startup", ui.ctx);
	assert.deepEqual(ui.notices, []);
	return gate;
}

async function ruleOf(gate: LoadedGate, command: string): Promise<string> {
	const result = await gate.handler(bashCall(command), fakeContext());
	return /\(rule: ([a-z0-9-]+)\)/.exec(result?.reason ?? "")?.[1] ?? "allowed";
}

const matched: readonly (readonly [command: string, rule: string])[] = [
	["kubectl delete pod x", "kubectl-delete"],
	["kubectl -n prod delete pod x", "kubectl-delete"],
	["/usr/local/bin/kubectl delete pod x", "kubectl-delete"],
	["env A=1 kubectl delete pod x", "kubectl-delete"],
	["ls && kubectl delete pod x", "kubectl-delete"],
	["sh -c 'kubectl delete pod x'", "kubectl-delete"],
	["find . -name '*.yaml' -exec kubectl delete -f {} \\;", "kubectl-delete"],
	["fd -e yaml -x kubectl delete -f", "kubectl-delete"],
	["fd --exec=kubectl delete -f", "kubectl-delete"],
	["kubectl get pods", "allowed"],
	["kubectl apply -f x", "allowed"],
	["echo kubectl delete", "allowed"],
	["yarn install", "no-yarn"],
	["yarnpkg add x", "no-yarn"],
	["find . -execdir yarn {} +", "no-yarn"],
	["pnpm install", "allowed"],
	["git -C repo push --force origin main", "force-main"],
	["git push origin main", "allowed"],
];

for (const [command, rule] of matched) {
	test(`custom rules: ${command} is ${rule}`, async () => {
		const gate = await gateWith([
			KUBECTL_DELETE,
			NO_YARN,
			{
				name: "force-main",
				command: "git",
				args: ["push", "--force", "main"],
				level: "deny",
				summary: "force-pushes main",
			},
		]);
		assert.equal(await ruleOf(gate, command), rule);
	});
}

test("an ask rule opens a dialog naming it, and a session allow holds", async () => {
	const gate = await gateWith([{ ...KUBECTL_DELETE, level: "ask" }]);
	const first = scriptedUI(["Allow for this session"]);
	await gate.handler(bashCall("kubectl delete pod x"), first.ctx);
	assert.equal(first.dialogs.length, 1);
	assert.ok(first.dialogs[0]?.title.includes("(rule: kubectl-delete)"));
	const second = scriptedUI();
	const result = await gate.handler(
		bashCall("kubectl delete pod x"),
		second.ctx,
	);
	assert.equal(result, undefined);
	assert.equal(second.dialogs.length, 0);
});

test("an ask rule is the default level", async () => {
	const { level: _, ...noLevel } = KUBECTL_DELETE;
	const gate = await gateWith([noLevel]);
	const { ctx, dialogs } = scriptedUI(["Deny"]);
	await gate.handler(bashCall("kubectl delete pod x"), ctx);
	assert.equal(dialogs.length, 1);
});

test("a deny rule blocks with the hard-deny text and a warning, and logs its name", async () => {
	const gate = await gateWith([KUBECTL_DELETE]);
	const { ctx, dialogs, notices } = scriptedUI();
	const result = await gate.handler(bashCall("kubectl delete pod x"), ctx);
	assert.equal(dialogs.length, 0);
	assert.equal(
		result?.reason,
		"Blocked by the user's bouncer (rule: kubectl-delete): deletes cluster resources. Command: `kubectl delete pod x`. None of the command ran. Do not retry this action through another command, script, or tool. Tell the user what was blocked and why, and let them decide.",
	);
	assert.deepEqual(notices, [
		{
			message: "Bouncer denied kubectl-delete: kubectl delete pod x",
			level: "warning",
		},
	]);
	const call = gate.records().find((record) => record.type === "call");
	assert.deepEqual(call?.matches, [
		{ rule: "kubectl-delete", level: "deny", source: "kubectl delete pod x" },
	]);
	const session = gate.records().find((record) => record.type === "session");
	const config = session?.config as { levels: Record<string, string> };
	assert.equal(config.levels["kubectl-delete"], "deny");
});

test("a rule set to off matches nothing", async () => {
	const gate = await gateWith([{ ...KUBECTL_DELETE, level: "off" }]);
	assert.equal(await ruleOf(gate, "kubectl delete pod x"), "allowed");
});

test("a steer rule blocks with its instead text, no warning and no dialog", async () => {
	const gate = await gateWith([NO_YARN]);
	const { ctx, dialogs, notices } = scriptedUI();
	const result = await gate.handler(bashCall("yarn install && rm -rf x"), ctx);
	assert.equal(
		result?.reason,
		"Blocked by the user's bouncer (rule: no-yarn): this repo uses pnpm. Command: `yarn install`. None of the command ran. Use pnpm instead.",
	);
	assert.deepEqual(dialogs, []);
	assert.deepEqual(notices, []);
});

test("a real deny beside a steer rule wins", async () => {
	const gate = await gateWith([NO_YARN]);
	assert.equal(await ruleOf(gate, "yarn install && sudo ls"), "privilege");
});

test("YOLO mode allows ask and deny custom rules but still steers", async () => {
	const gate = await gateWith([KUBECTL_DELETE, NO_YARN]);
	await gate.runCommand("yolo", "", uiContext().ctx);
	assert.equal(await ruleOf(gate, "kubectl delete pod x"), "allowed");
	assert.equal(await ruleOf(gate, "yarn install"), "no-yarn");
});

test("auto mode sends a custom ask to the judge", async () => {
	const rules = [{ ...KUBECTL_DELETE, level: "ask" }];
	const { gate, fake } = await judgedGate(
		verdict("allow", "a test pod"),
		{},
		undefined,
		{},
		{ rules },
	);
	const ui = judgedUI(fake);
	const result = await gate.handler(bashCall("kubectl delete pod x"), ui.ctx);
	assert.equal(result, undefined);
	assert.equal(fake.requests.length, 1);
});

test("invalid rules are problems and are skipped whole; the rest apply", async () => {
	const gate = await loadGateSession(undefined, undefined, {
		userConfig: {
			rules: [
				KUBECTL_DELETE,
				{ ...KUBECTL_DELETE, summary: "again" },
				{ ...KUBECTL_DELETE, name: "rm-root" },
				{ ...KUBECTL_DELETE, name: "Bad Name" },
				{ ...KUBECTL_DELETE, name: "a", command: [] },
				{ ...KUBECTL_DELETE, name: "b", args: "delete" },
				{ ...KUBECTL_DELETE, name: "c", summary: " " },
				{ ...NO_YARN, name: "d", level: "ask" },
				{ ...KUBECTL_DELETE, name: "e", extra: 1 },
				"kubectl",
			],
		},
	});
	const ui = uiContext();
	await gate.startSession("startup", ui.ctx);
	const lines = (ui.notices[0]?.message ?? "").split("\n").slice(1);
	const problems = lines.map((line) => line.replace(/^- [^:]+: /, ""));
	assert.deepEqual(problems, [
		'rules[1]: "kubectl-delete" is defined twice',
		`rules[2]: "rm-root" is a built-in rule's name`,
		'rules[3]: "name" must be lowercase letters, digits and dashes',
		'rules[4]: "command" must be a program name or a list of them',
		'rules[5]: "args" must be a list of words',
		'rules[6]: "summary" must be a sentence',
		'rules[7]: "level" must be "deny", "off"',
		'rules[8]: unknown key "extra"',
		"rules[9]: is not an object",
	]);
	assert.equal(await ruleOf(gate, "kubectl delete pod x"), "kubectl-delete");
});

async function projectGate(
	trusted: boolean,
	rules: readonly object[],
	userRules: readonly object[] = [],
): Promise<{ gate: LoadedGate; cwd: string; notices: readonly string[] }> {
	const gate = await loadGateSession(undefined, undefined, {
		userConfig: { rules: userRules },
	});
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { rules });
	const ui = uiContext(cwd, trusted);
	await gate.startSession("startup", ui.ctx);
	return { gate, cwd, notices: ui.notices.map((notice) => notice.message) };
}

async function projectRule(
	gate: LoadedGate,
	cwd: string,
	command: string,
): Promise<string> {
	const result = await gate.handler(bashCall(command), fakeContext(cwd));
	return /\(rule: ([a-z0-9-]+)\)/.exec(result?.reason ?? "")?.[1] ?? "allowed";
}

test("an untrusted project may add ask and deny rules", async () => {
	const { gate, cwd, notices } = await projectGate(false, [KUBECTL_DELETE]);
	assert.deepEqual(notices, []);
	assert.equal(
		await projectRule(gate, cwd, "kubectl delete pod x"),
		"kubectl-delete",
	);
});

test("an untrusted project may not add a steer rule", async () => {
	const { gate, cwd, notices } = await projectGate(false, [NO_YARN]);
	const path = projectConfigPath(cwd);
	assert.deepEqual(notices, [
		[
			"Bouncer config problems; these parts are ignored:",
			`- ${path}: rules: "no-yarn" is a steer rule, and the project is not trusted`,
		].join("\n"),
	]);
	assert.equal(await projectRule(gate, cwd, "yarn install"), "allowed");
});

test("a trusted project may add a steer rule", async () => {
	const { gate, cwd, notices } = await projectGate(true, [NO_YARN]);
	assert.deepEqual(notices, []);
	assert.equal(await projectRule(gate, cwd, "yarn install"), "no-yarn");
});

test("a project rule may not reuse a user rule's name", async () => {
	const { gate, cwd, notices } = await projectGate(
		true,
		[{ ...KUBECTL_DELETE, level: "off" }],
		[KUBECTL_DELETE],
	);
	const path = projectConfigPath(cwd);
	assert.deepEqual(notices, [
		[
			"Bouncer config problems; these parts are ignored:",
			`- ${path}: rules: "kubectl-delete" is already a rule in the user config`,
		].join("\n"),
	]);
	assert.equal(
		await projectRule(gate, cwd, "kubectl delete pod x"),
		"kubectl-delete",
	);
});
