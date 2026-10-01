// What the bouncer log records, read back from the real file each bouncer writes.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	bashCall,
	fakeContext,
	loadGateSession,
	projectConfigPath,
	SESSION_FILE,
	SESSION_ID,
	scriptedUI,
	tempProjectDir,
	writeProjectConfig,
} from "./harness.ts";

const failingLoader = (): Promise<never> =>
	Promise.reject(new Error("Cannot find package 'unbash'"));

const PRIVILEGE_SUDO_LS =
	"Blocked by the user's bouncer (rule: privilege): the agent must not run anything with elevated privileges. Command: `sudo ls`. None of the command ran. Do not retry this action through another command, script, or tool. Tell the user what was blocked and why, and let them decide.";

test("a hard deny without a UI appends one blocked call record", async () => {
	const { handler, records } = await loadGateSession();
	const result = await handler(bashCall("sudo ls"), fakeContext("/repo"));
	const [record, ...rest] = records();
	assert.deepEqual(rest, []);
	assert.equal(typeof record?.time, "string");
	assert.ok(!Number.isNaN(Date.parse(String(record?.time))));
	assert.deepEqual(
		{ ...record, time: "T" },
		{
			v: 1,
			type: "call",
			time: "T",
			sessionId: SESSION_ID,
			sessionFile: SESSION_FILE,
			cwd: "/repo",
			command: "sudo ls",
			ui: false,
			outcome: "blocked",
			reason: PRIVILEGE_SUDO_LS,
			matches: [{ rule: "privilege", level: "deny", source: "sudo ls" }],
			asks: [],
		},
	);
	assert.equal(record?.reason, result?.reason);
});

const noUIBlocks: readonly (readonly [
	label: string,
	command: string,
	matches: readonly unknown[],
])[] = [
	[
		"an ask rule's no-UI deny",
		"rm -rf x",
		[{ rule: "recursive-rm", level: "ask", source: "rm -rf x" }],
	],
	[
		"an unparseable command",
		"echo 'unterminated",
		[{ rule: "unparseable", level: "deny", source: "echo 'unterminated" }],
	],
	[
		"a too-deep inline script",
		"eval eval eval eval ls",
		[
			{
				rule: "inline-too-deep",
				level: "deny",
				source: "eval eval eval eval ls",
			},
		],
	],
];

for (const [label, command, matches] of noUIBlocks) {
	test(`${label} is recorded as blocked with its matches`, async () => {
		const { handler, records } = await loadGateSession();
		const result = await handler(bashCall(command), fakeContext());
		const all = records();
		assert.equal(all.length, 1);
		assert.equal(all[0]?.outcome, "blocked");
		assert.equal(all[0]?.ui, false);
		assert.equal(all[0]?.command, command);
		assert.equal(all[0]?.reason, result?.reason);
		assert.deepEqual(all[0]?.matches, matches);
		assert.deepEqual(all[0]?.asks, []);
	});
}

test("a bouncer whose parser failed records parser-unavailable for any command", async () => {
	const { handler, records } = await loadGateSession(failingLoader);
	await handler(bashCall("ls"), fakeContext());
	const all = records();
	assert.equal(all.length, 1);
	assert.equal(all[0]?.outcome, "blocked");
	assert.deepEqual(all[0]?.matches, [
		{ rule: "parser-unavailable", level: "deny", source: "ls" },
	]);
});

test("a hard deny with a UI is recorded with ui true and no dialog", async () => {
	const { handler, records } = await loadGateSession();
	const { ctx, dialogs } = scriptedUI();
	await handler(bashCall("sudo ls"), ctx);
	assert.equal(dialogs.length, 0);
	const all = records();
	assert.equal(all.length, 1);
	assert.equal(all[0]?.ui, true);
	assert.equal(all[0]?.outcome, "blocked");
	assert.deepEqual(all[0]?.asks, []);
});

test("an ask then a deny on one line records both matches in order", async () => {
	const { handler, records } = await loadGateSession();
	await handler(bashCall("rm -rf x && sudo ls"), scriptedUI().ctx);
	assert.deepEqual(records()[0]?.matches, [
		{ rule: "recursive-rm", level: "ask", source: "rm -rf x" },
		{ rule: "privilege", level: "deny", source: "sudo ls" },
	]);
});

test("a multi-line command is stored in full, one record per line", async () => {
	const command = `echo ${"a".repeat(300)}\nsudo ls`;
	const { handler, records } = await loadGateSession();
	await handler(bashCall(command), fakeContext());
	await handler(bashCall("sudo ls"), fakeContext());
	const all = records();
	assert.equal(all.length, 2);
	assert.equal(all[0]?.command, command);
});

test("an in-memory session is recorded with a null session file", async () => {
	const { handler, records } = await loadGateSession();
	const ctx = {
		...fakeContext(),
		sessionManager: {
			getSessionId: (): string => "mem",
			getSessionFile: (): undefined => undefined,
		},
	} as ReturnType<typeof fakeContext>;
	await handler(bashCall("sudo ls"), ctx);
	assert.equal(records()[0]?.sessionId, "mem");
	assert.equal(records()[0]?.sessionFile, null);
});

test("an unmatched command writes nothing and creates no log", async () => {
	const { handler, logDir } = await loadGateSession();
	assert.equal(await handler(bashCall("ls"), scriptedUI().ctx), undefined);
	assert.equal(await handler(bashCall("ls"), fakeContext()), undefined);
	assert.equal(existsSync(logDir), false);
});

test("the log file is mode 0600 and its directory 0700", async () => {
	const { handler, logDir } = await loadGateSession();
	await handler(bashCall("sudo ls"), fakeContext());
	assert.equal(statSync(logDir).mode & 0o777, 0o700);
	assert.equal(statSync(join(logDir, "log.jsonl")).mode & 0o777, 0o600);
});

type DefaultDirEnv = {
	readonly PI_BOUNCER_LOG_DIR: string;
	readonly PI_CODING_AGENT_DIR: string;
};

// Each row: the environment (paths relative to a temp HOME, "~/" kept as is)
// and where below HOME the log must land. XDG_STATE_HOME is always set, and
// must never be used.
const defaultDirs: readonly (readonly [
	label: string,
	env: DefaultDirEnv,
	below: string,
])[] = [
	[
		"PI_BOUNCER_LOG_DIR, over the agent dir",
		{ PI_BOUNCER_LOG_DIR: "live", PI_CODING_AGENT_DIR: "agent" },
		"live",
	],
	[
		"PI_CODING_AGENT_DIR's bouncer directory",
		{ PI_BOUNCER_LOG_DIR: "", PI_CODING_AGENT_DIR: "agent" },
		"agent/bouncer",
	],
	[
		"a ~-relative PI_CODING_AGENT_DIR, expanded",
		{ PI_BOUNCER_LOG_DIR: "", PI_CODING_AGENT_DIR: "~/tilde" },
		"tilde/bouncer",
	],
	[
		"~/.pi/agent/bouncer when neither is set",
		{ PI_BOUNCER_LOG_DIR: "", PI_CODING_AGENT_DIR: "" },
		".pi/agent/bouncer",
	],
];

const ENV_KEYS = [
	"HOME",
	"XDG_STATE_HOME",
	"PI_BOUNCER_LOG_DIR",
	"PI_CODING_AGENT_DIR",
] as const;

for (const [label, env, below] of defaultDirs) {
	test(`with no log directory given, the bouncer logs to ${label}`, async (t) => {
		const home = join((await loadGateSession()).logDir, "..", "home");
		// os.homedir() reads the real environment, so it is changed in place.
		const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
		t.after(() => {
			for (const [key, value] of saved) {
				if (value === undefined) Reflect.deleteProperty(process.env, key);
				else Object.assign(process.env, { [key]: value });
			}
		});
		const inHome = (path: string): string =>
			path === "" || path.startsWith("~/") ? path : join(home, path);
		Object.assign(process.env, {
			HOME: home,
			XDG_STATE_HOME: join(home, "state"),
			PI_BOUNCER_LOG_DIR: inHome(env.PI_BOUNCER_LOG_DIR),
			PI_CODING_AGENT_DIR: inHome(env.PI_CODING_AGENT_DIR),
		});
		// Never reach the real home: fail before the bouncer loads.
		assert.equal(homedir(), home);
		const { handler } = await loadGateSession(undefined, null);
		await handler(bashCall("sudo ls"), fakeContext());
		const log = join(home, below, "log.jsonl");
		assert.ok(existsSync(log), log);
		assert.equal(existsSync(join(home, "state")), false);
	});
}

const RM = { rule: "recursive-rm", source: "rm -rf build" };

const answered: readonly (readonly [
	label: string,
	script: readonly (string | undefined)[],
	outcome: string,
	ask: { readonly answer: string; readonly userReason?: string },
])[] = [
	["Allow once", ["Allow once"], "allowed", { answer: "allow-once" }],
	[
		"Allow for this session",
		["Allow for this session"],
		"allowed",
		{ answer: "allow-session" },
	],
	["Deny", ["Deny"], "blocked", { answer: "deny" }],
	[
		"Deny with reason",
		["Deny with reason", "  use git stash  "],
		"blocked",
		{ answer: "deny-with-reason", userReason: "use git stash" },
	],
	[
		"Deny with reason, left blank",
		["Deny with reason", "   "],
		"blocked",
		{ answer: "deny-with-reason" },
	],
	[
		"Deny with reason, cancelled",
		["Deny with reason", undefined],
		"blocked",
		{ answer: "deny-with-reason" },
	],
	["Deny and stop", ["Deny and stop"], "stopped", { answer: "deny-and-stop" }],
	["Escape", [undefined], "blocked", { answer: "escape" }],
];

for (const [label, script, outcome, ask] of answered) {
	test(`a dialog answered ${label} is recorded as ${ask.answer}`, async () => {
		const { handler, records } = await loadGateSession();
		const { ctx } = scriptedUI([...script]);
		const result = await handler(bashCall("rm -rf build"), ctx);
		const all = records();
		assert.equal(all.length, 1);
		assert.equal(all[0]?.outcome, outcome);
		assert.equal(all[0]?.ui, true);
		assert.deepEqual(all[0]?.asks, [{ ...RM, ...ask }]);
		assert.deepEqual(all[0]?.matches, [{ ...RM, level: "ask" }]);
		// The reason sent to the model, never Pi's "Operation aborted".
		assert.equal(all[0]?.reason, result?.reason);
	});
}

test("a dialog dismissed by an aborted turn is recorded as aborted", async () => {
	const { handler, records } = await loadGateSession();
	const { ctx, cancelTurn } = scriptedUI([undefined]);
	cancelTurn();
	await handler(bashCall("rm -rf build"), ctx);
	assert.equal(records()[0]?.outcome, "blocked");
	assert.deepEqual(records()[0]?.asks, [{ ...RM, answer: "aborted" }]);
});

test("an allowed call has no reason in its record", async () => {
	const { handler, records } = await loadGateSession();
	await handler(bashCall("rm -rf build"), scriptedUI(["Allow once"]).ctx);
	assert.equal("reason" in (records()[0] ?? {}), false);
});

const TWO_ASKS = "rm -rf a && git reset --hard";
const RM_A = { rule: "recursive-rm", source: "rm -rf a" };
const RESET = { rule: "git-reset-hard", source: "git reset --hard" };

test("two asks answered Allow once then Deny are recorded in order", async () => {
	const { handler, records } = await loadGateSession();
	await handler(bashCall(TWO_ASKS), scriptedUI(["Allow once", "Deny"]).ctx);
	assert.deepEqual(records()[0]?.asks, [
		{ ...RM_A, answer: "allow-once" },
		{ ...RESET, answer: "deny" },
	]);
	assert.equal(records()[0]?.outcome, "blocked");
});

test("a first-ask Deny records one ask; the second was never asked", async () => {
	const { handler, records } = await loadGateSession();
	await handler(bashCall(TWO_ASKS), scriptedUI(["Deny"]).ctx);
	assert.deepEqual(records()[0]?.asks, [{ ...RM_A, answer: "deny" }]);
	assert.deepEqual(records()[0]?.matches, [
		{ ...RM_A, level: "ask" },
		{ ...RESET, level: "ask" },
	]);
});

test("a command allowed for the session is recorded again as session-allowed", async () => {
	const { handler, records } = await loadGateSession();
	const first = scriptedUI([
		"Allow for this session",
		"Allow for this session",
	]);
	await handler(bashCall(TWO_ASKS), first.ctx);
	const again = scriptedUI();
	assert.equal(await handler(bashCall(TWO_ASKS), again.ctx), undefined);
	assert.equal(again.dialogs.length, 0);
	const all = records();
	assert.equal(all.length, 2);
	assert.equal(all[1]?.outcome, "allowed");
	assert.deepEqual(all[1]?.asks, [
		{ ...RM_A, answer: "session-allowed" },
		{ ...RESET, answer: "session-allowed" },
	]);
});

test("session-allowed and asked answers keep the asks' order", async () => {
	const { handler, records } = await loadGateSession();
	// Only the first ask is allowed for the session; the second is denied.
	const first = scriptedUI(["Allow for this session", "Deny"]);
	await handler(bashCall(TWO_ASKS), first.ctx);
	const again = scriptedUI(["Allow once"]);
	await handler(bashCall(TWO_ASKS), again.ctx);
	assert.equal(again.dialogs.length, 1);
	assert.deepEqual(records()[1]?.asks, [
		{ ...RM_A, answer: "session-allowed" },
		{ ...RESET, answer: "allow-once" },
	]);
});

// Every rule's built-in level, unreadable-command denies first, as the
// session record lists them.
const BUILT_IN_LEVELS = {
	"parser-unavailable": "deny",
	unparseable: "deny",
	"inline-too-deep": "deny",
	"rm-root": "deny",
	"recursive-rm": "ask",
	"find-delete": "ask",
	"find-exec": "ask",
	"fd-exec": "ask",
	"rg-pre": "ask",
	"opaque-exec": "ask",
	"disk-format": "deny",
	"dd-device": "deny",
	power: "deny",
	privilege: "deny",
	"git-clean": "ask",
	"git-reset-hard": "ask",
	"git-checkout-discard": "ask",
	"git-restore-worktree": "ask",
	"git-stash-destroy": "ask",
	"git-push-force": "ask",
	"git-push-delete": "ask",
	"remote-script": "ask",
	publish: "ask",
	"gh-delete": "ask",
	grep: "deny",
} as const;

test("with no config files, the session record lists built-in config", async () => {
	const { startSession, records, agentDir } = await loadGateSession();
	const cwd = tempProjectDir();
	await startSession("startup", fakeContext(cwd));
	assert.deepEqual(records()[0]?.config, {
		files: [
			{
				path: join(agentDir, "bouncer.json"),
				loaded: false,
				problems: [],
			},
			{
				path: projectConfigPath(cwd),
				loaded: false,
				problems: [],
			},
		],
		projectTrusted: true,
		levels: BUILT_IN_LEVELS,
		log: { rotateAboveMiB: 5, generations: 5 },
	});
});

test("with a route and a project file, the session record merges them", async () => {
	const { startSession, records, agentDir, writeRouteConfig } =
		await loadGateSession();
	const cwd = tempProjectDir();
	writeRouteConfig({
		levels: { privilege: "ask", "git-clean": "deny" },
		log: { generations: 2, maxAgeDays: 30 },
		extra: 1,
	});
	writeProjectConfig(cwd, { levels: { "git-clean": "ask", publish: "deny" } });
	await startSession("startup", fakeContext(cwd));
	assert.deepEqual(records()[0]?.config, {
		files: [
			{
				path: join(agentDir, "bouncer.json"),
				loaded: true,
				problems: ['unknown key "extra"'],
			},
			{
				path: projectConfigPath(cwd),
				loaded: true,
				problems: [],
			},
		],
		projectTrusted: true,
		levels: { ...BUILT_IN_LEVELS, privilege: "ask", publish: "deny" },
		log: { rotateAboveMiB: 5, generations: 2, maxAgeDays: 30 },
	});
});

test("a broken route file still yields a session record", async () => {
	const { startSession, records, writeRouteConfig } = await loadGateSession();
	writeRouteConfig("[");
	await startSession("startup");
	const [record] = records();
	assert.equal(record?.type, "session");
	const config = record?.config as { levels: unknown; files: unknown[] };
	assert.deepEqual(config.levels, BUILT_IN_LEVELS);
	assert.equal((config.files[0] as { loaded: boolean }).loaded, false);
});
