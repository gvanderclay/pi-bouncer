// Path group levels in `levels`: a plain level for both directions, or an
// object naming `read` and/or `write`. Driven through the tool_call handler
// with a temporary HOME.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { fileCall, tempHome } from "../test/file-harness.ts";
import {
	bashCall,
	fakeContext,
	type LoadedGate,
	loadGateSession,
	scriptedUI,
	tempProjectDir,
	uiContext,
	writeProjectConfig,
} from "../test/harness.ts";

tempHome(); // before any gate loads

async function gate(
	userConfig: object = {},
	env: Readonly<Record<string, string>> = {},
): Promise<LoadedGate> {
	const g = await loadGateSession(undefined, undefined, { userConfig, env });
	await g.startSession("startup");
	return g;
}

function messages(notices: readonly { readonly message: string }[]): string {
	return notices.map(({ message }) => message).join("\n");
}

function project(): string {
	const dir = tempProjectDir();
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("a plain level applies to both directions: path-git ask also asks for reads", async () => {
	const g = await gate({ levels: { "path-git": "ask" } });
	const ui = scriptedUI(["Deny"], project());
	await g.handler(fileCall("read", { path: ".git/config" }), ui.ctx);
	assert.equal(ui.dialogs.length, 1);
});

test("a direction object sets each direction and keeps the other default", async () => {
	const g = await gate({ levels: { "path-env": { read: "allow" } } });
	const dir = project();
	assert.equal(
		await g.handler(fileCall("read", { path: ".env" }), fakeContext(dir)),
		undefined,
	);
	const r = await g.handler(
		fileCall("write", { path: ".env", content: "A=1" }),
		fakeContext(dir),
	);
	// The write still asks, and there is no UI to answer it.
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /no one can answer/);
});

test("path-ssh can ask for writes and deny reads", async () => {
	const g = await gate({
		levels: { "path-ssh": { write: "ask", read: "deny" } },
	});
	const dir = project();
	const ui = scriptedUI(["Allow once"], dir);
	assert.equal(
		await g.handler(
			fileCall("write", { path: "~/.ssh/config", content: "" }),
			ui.ctx,
		),
		undefined,
	);
	assert.equal(ui.dialogs.length, 1);
	const read = await g.handler(
		fileCall("read", { path: "~/.ssh/config" }),
		ui.ctx,
	);
	assert.equal(read?.block, true);
	assert.match(read?.reason ?? "", /\(rule: path-ssh\)/);
});

test("an untrusted project can't turn off path-ssh, but can raise path-git", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		levels: { "path-ssh": "off", "path-git": "deny" },
	});
	const g = await loadGateSession();
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	const call = scriptedUI([], dir);
	const read = await g.handler(
		fileCall("read", { path: "~/.ssh/id_ed25519" }),
		call.ctx,
	);
	assert.equal(read?.block, true);
	assert.match(read?.reason ?? "", /\(rule: path-ssh\)/);
	const write = await g.handler(
		fileCall("write", { path: ".git/config", content: "" }),
		call.ctx,
	);
	assert.match(write?.reason ?? "", /\(rule: path-git\)/);
	assert.doesNotMatch(write?.reason ?? "", /no one can answer/);
	assert.match(
		notices[0]?.message ?? "",
		/an untrusted project may not lower "path-ssh" read/,
	);
	assert.match(
		notices[0]?.message ?? "",
		/an untrusted project may not lower "path-ssh" write/,
	);
});

test("a profile gives one agent its own path levels", async () => {
	const config = {
		profiles: { reader: { levels: { "path-env": { read: "allow" } } } },
		agents: { scout: "reader" },
	};
	const scout = await gate(config, { PI_BOUNCER_AGENT: "scout" });
	assert.equal(
		await scout.handler(
			fileCall("read", { path: ".env" }),
			fakeContext(project()),
		),
		undefined,
	);
	// Without the agent name the normal rules still deny the read.
	const plain = await gate(config);
	const denied = await plain.handler(
		fileCall("read", { path: ".env" }),
		fakeContext(project()),
	);
	assert.equal(denied?.block, true);
});

test("a profile's direction object replaces the whole entry for that group", async () => {
	const g = await gate(
		{
			levels: { "path-env": { write: "deny" } },
			profiles: { reader: { levels: { "path-env": { read: "allow" } } } },
			agents: { scout: "reader" },
		},
		{ PI_BOUNCER_AGENT: "scout" },
	);
	const dir = project();
	assert.equal(
		await g.handler(fileCall("read", { path: ".env" }), fakeContext(dir)),
		undefined,
	);
	const ui = scriptedUI(["Allow once"], dir);
	assert.equal(
		await g.handler(
			fileCall("write", { path: ".env", content: "A=1" }),
			ui.ctx,
		),
		undefined,
	);
	// The write is the built-in ask again, not the removed `deny`.
	assert.equal(ui.dialogs.length, 1);
});

test("an unknown path group is a problem, not silently ignored", async () => {
	const g = await gate({ levels: { "path-nope": "deny" } });
	const ui = uiContext();
	await g.runCommand("bouncer", "check", ui.ctx);
	assert.match(messages(ui.notices), /unknown rule "path-nope"/);
});

test("an empty direction object is a problem, and the group keeps its defaults", async () => {
	const g = await gate({ levels: { "path-ssh": {} } });
	const ui = uiContext();
	await g.runCommand("bouncer", "check", ui.ctx);
	assert.match(messages(ui.notices), /must set "read", "write" or both/);
	const read = await g.handler(
		fileCall("read", { path: "~/.ssh/id_ed25519" }),
		fakeContext(project()),
	);
	assert.equal(read?.block, true);
});

test("path-bouncer takes a write level only, and that level still asks", async () => {
	const g = await gate({ levels: { "path-bouncer": { write: "ask" } } });
	const check = uiContext();
	await g.runCommand("bouncer", "check", check.ctx);
	assert.match(messages(check.notices), /No config problems/);
	const dir = project();
	const config = join(g.agentDir, "bouncer.json");
	assert.equal(
		await g.handler(fileCall("read", { path: config }), fakeContext(dir)),
		undefined,
	);
	const ui = scriptedUI(["Deny"], dir);
	await g.handler(fileCall("write", { path: config, content: "{}" }), ui.ctx);
	assert.equal(ui.dialogs.length, 1);
});

test("path-bouncer's read key is a problem and its write cannot be off", async () => {
	const g = await gate({
		levels: { "path-bouncer": { read: "ask", write: "off" } },
	});
	const ui = uiContext();
	await g.runCommand("bouncer", "check", ui.ctx);
	assert.match(
		messages(ui.notices),
		/"path-bouncer" sets only the write level/,
	);
	assert.match(
		messages(ui.notices),
		/"path-bouncer" write must be "ask" or "deny"/,
	);
	const r = await g.handler(
		fileCall("write", {
			path: join(g.agentDir, "bouncer.json"),
			content: "{}",
		}),
		scriptedUI([], project()).ctx,
	);
	assert.equal(r?.block, true);
});

test("a trusted project may lower one direction", async () => {
	const dir = project();
	writeProjectConfig(dir, { levels: { "path-ssh": { read: "ask" } } });
	const g = await loadGateSession();
	const { ctx, notices } = uiContext(dir, true);
	await g.startSession("startup", ctx);
	assert.deepEqual(notices, []);
	const ui = scriptedUI(["Deny"], dir);
	await g.handler(fileCall("read", { path: "~/.ssh/config" }), ui.ctx);
	assert.equal(ui.dialogs.length, 1);
});

test("an untrusted project may raise a direction", async () => {
	const dir = project();
	writeProjectConfig(dir, { levels: { "path-env": { write: "deny" } } });
	const g = await loadGateSession();
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	assert.equal(notices.length, 0, messages(notices));
	const denied = await g.handler(
		fileCall("write", { path: ".env", content: "A=1" }),
		scriptedUI([], dir).ctx,
	);
	assert.match(denied?.reason ?? "", /\(rule: path-env\)/);
	assert.doesNotMatch(denied?.reason ?? "", /no one can answer/);
});

test("an untrusted project can't lower a direction by leaving it out", async () => {
	const dir = project();
	writeProjectConfig(dir, { levels: { "path-git": { write: "deny" } } });
	const g = await loadGateSession(undefined, undefined, {
		userConfig: { levels: { "path-git": "deny" } },
	});
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	assert.match(
		messages(notices),
		/an untrusted project may not lower "path-git" read/,
	);
	const read = await g.handler(
		fileCall("read", { path: ".git/config" }),
		scriptedUI([], dir).ctx,
	);
	assert.equal(read?.block, true);
	assert.match(read?.reason ?? "", /\(rule: path-git\)/);
});

test("an untrusted project naming a lower direction keeps the whole entry", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		levels: { "path-git": { read: "allow", write: "deny" } },
	});
	const g = await loadGateSession(undefined, undefined, {
		userConfig: { levels: { "path-git": "deny" } },
	});
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	assert.match(
		messages(notices),
		/an untrusted project may not lower "path-git" read/,
	);
	const read = await g.handler(
		fileCall("read", { path: ".git/config" }),
		scriptedUI([], dir).ctx,
	);
	assert.equal(read?.block, true);
	assert.match(read?.reason ?? "", /\(rule: path-git\)/);
});

test("an untrusted project's profile can't lower a user profile's direction", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		profiles: { reader: { levels: { "path-git": { write: "deny" } } } },
	});
	const g = await loadGateSession(undefined, undefined, {
		userConfig: {
			profiles: { reader: { levels: { "path-git": "deny" } } },
			agents: { scout: "reader" },
		},
		env: { PI_BOUNCER_AGENT: "scout" },
	});
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	assert.match(
		messages(notices),
		/an untrusted project may not lower "path-git" read/,
	);
	const read = await g.handler(
		fileCall("read", { path: ".git/config" }),
		scriptedUI([], dir).ctx,
	);
	assert.equal(read?.block, true);
	assert.match(read?.reason ?? "", /\(rule: path-git\)/);
});

test("a profile in an untrusted project can't lower a direction by leaving it out", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		profiles: { reader: { levels: { "path-git": { write: "deny" } } } },
		agents: { scout: "reader" },
	});
	const g = await loadGateSession(undefined, undefined, {
		userConfig: { levels: { "path-git": "deny" } },
		env: { PI_BOUNCER_AGENT: "scout" },
	});
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	assert.match(
		messages(notices),
		/an untrusted project may not lower "path-git" read/,
	);
	const read = await g.handler(
		fileCall("read", { path: ".git/config" }),
		scriptedUI([], dir).ctx,
	);
	assert.equal(read?.block, true);
	assert.match(read?.reason ?? "", /\(rule: path-git\)/);
});

test("an untrusted project may not set allow, even where the default is allow", async () => {
	const dir = project();
	writeProjectConfig(dir, { levels: { "path-git": { read: "allow" } } });
	const g = await loadGateSession();
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	assert.match(
		messages(notices),
		/an untrusted project may not lower "path-git" read/,
	);
});

test("a group with its read off and its write at ask stays in the policy", async () => {
	const g = await gate({
		levels: { "path-env": { read: "off", write: "ask" } },
	});
	const dir = project();
	assert.equal(
		await g.handler(fileCall("read", { path: ".env" }), fakeContext(dir)),
		undefined,
	);
	const ui = scriptedUI(["Allow once"], dir);
	assert.equal(
		await g.handler(
			fileCall("write", { path: ".env", content: "A=1" }),
			ui.ctx,
		),
		undefined,
	);
	assert.equal(ui.dialogs.length, 1);
});

test("a profile in an untrusted project may not lower a direction", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		profiles: { reader: { levels: { "path-env": { read: "allow" } } } },
		agents: { scout: "reader" },
	});
	const g = await loadGateSession(undefined, undefined, {
		env: { PI_BOUNCER_AGENT: "scout" },
	});
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	assert.match(
		messages(notices),
		/an untrusted project may not lower "path-env" read/,
	);
	const read = await g.handler(
		fileCall("read", { path: ".env" }),
		scriptedUI([], dir).ctx,
	);
	assert.equal(read?.block, true);
});

// Custom path rules in `rules`.

test("a custom path rule protects a folder the bouncer doesn't know", async () => {
	const g = await gate({
		rules: [
			{
				name: "notes",
				paths: ["~/notes/**"],
				level: "deny",
				summary: "personal notes",
			},
		],
	});
	const r = await g.handler(
		fileCall("read", { path: "~/notes/a.md" }),
		fakeContext(project()),
	);
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /\(rule: notes\)/);
});

test("a bare ** path rule matches outside the working directory", async () => {
	const g = await gate({
		rules: [{ name: "all", paths: ["**"], level: "deny", summary: "x" }],
	});
	const r = await g.handler(
		fileCall("read", { path: "/tmp/x" }),
		fakeContext(project()),
	);
	assert.match(r?.reason ?? "", /\(rule: all\)/);
});

test("a delegate profile can write only to one folder", async () => {
	const dir = project();
	const g = await gate(
		{
			profiles: {
				docs: {
					rules: [
						{
							name: "no-writes",
							paths: ["**"],
							level: { write: "deny" },
							summary: "writes only to docs",
						},
						{
							name: "docs-only",
							paths: [`${dir}/docs/**`],
							level: { write: "allow" },
							summary: "the docs folder",
						},
					],
				},
			},
			agents: { writer: "docs" },
		},
		{ PI_BOUNCER_AGENT: "writer" },
	);
	const w = (path: string): ToolCallEvent =>
		fileCall("write", { path, content: "x" });
	assert.equal(await g.handler(w("docs/a.md"), fakeContext(dir)), undefined);
	const denied = await g.handler(w("src/a.ts"), fakeContext(dir));
	assert.match(denied?.reason ?? "", /\(rule: no-writes\)/);
	assert.equal(
		await g.handler(fileCall("read", { path: "src/a.ts" }), fakeContext(dir)),
		undefined,
	);
});

test("an earlier allow doesn't beat a later deny within one spelling", async () => {
	const g = await gate({
		rules: [
			{ name: "open", paths: ["**"], level: "allow", summary: "x" },
			{ name: "secrets", paths: ["secrets/**"], level: "deny", summary: "s" },
		],
	});
	const r = await g.handler(
		fileCall("read", { path: "secrets/a" }),
		fakeContext(project()),
	);
	assert.match(r?.reason ?? "", /\(rule: secrets\)/);
});

test("a later allow beats the built-in path-git for hooks only", async () => {
	const g = await gate({
		rules: [
			{
				name: "hooks",
				paths: ["**/.git/hooks/**"],
				level: { write: "allow" },
				summary: "hooks",
			},
		],
	});
	const ctx = fakeContext(project());
	assert.equal(
		await g.handler(
			fileCall("write", { path: ".git/hooks/pre-commit", content: "" }),
			ctx,
		),
		undefined,
	);
	const config = await g.handler(
		fileCall("write", { path: ".git/config", content: "" }),
		ctx,
	);
	assert.equal(config?.block, true);
	assert.match(config?.reason ?? "", /\(rule: path-git\)/);
});

test("no allow rule overrides path-bouncer", async () => {
	const g0 = await gate();
	const g = await gate({
		rules: [
			{
				name: "agent-dir",
				paths: [`${g0.agentDir}/**`, "**"],
				level: "allow",
				summary: "x",
			},
		],
	});
	const r = await g.handler(
		fileCall("write", {
			path: join(g.agentDir, "bouncer.json"),
			content: "{}",
		}),
		fakeContext(project()),
	);
	assert.match(r?.reason ?? "", /\(rule: path-bouncer\)/);
});

test("no allow rule unblocks a search of the home folder", async () => {
	const g = await gate({
		rules: [{ name: "open", paths: ["~/**"], level: "allow", summary: "x" }],
	});
	const r = await g.handler(
		fileCall("grep", { pattern: "x", path: "~" }),
		fakeContext(project()),
	);
	assert.equal(r?.block, true);
});

test("an untrusted project can't add an allow path rule", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		rules: [
			{ name: "open", paths: ["~/.ssh/**"], level: "allow", summary: "x" },
		],
	});
	const g = await loadGateSession();
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	assert.match(messages(notices), /"open"/);
	const r = await g.handler(
		fileCall("read", { path: "~/.ssh/id_ed25519" }),
		fakeContext(dir),
	);
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /\(rule: path-ssh\)/);
});

test("an untrusted project's ask rule doesn't lower path-ssh's read deny", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		rules: [{ name: "ssh", paths: ["~/.ssh/**"], level: "ask", summary: "x" }],
	});
	const g = await loadGateSession();
	const { ctx, notices } = uiContext(dir, false);
	await g.startSession("startup", ctx);
	assert.equal(notices.length, 0, messages(notices));
	const ui = scriptedUI(["Allow once"], dir);
	const r = await g.handler(
		fileCall("read", { path: "~/.ssh/id_ed25519" }),
		ui.ctx,
	);
	assert.equal(ui.dialogs.length, 0);
	assert.match(r?.reason ?? "", /\(rule: path-ssh\)/);
});

test("an untrusted project's ** ask rule doesn't override a user deny rule", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		rules: [{ name: "all", paths: ["**"], level: "ask", summary: "x" }],
	});
	const g = await loadGateSession(undefined, undefined, {
		userConfig: {
			rules: [
				{ name: "notes", paths: ["~/notes/**"], level: "deny", summary: "n" },
			],
		},
	});
	await g.startSession("startup", uiContext(dir, false).ctx);
	const ui = scriptedUI(["Allow once"], dir);
	const r = await g.handler(fileCall("read", { path: "~/notes/a" }), ui.ctx);
	assert.equal(ui.dialogs.length, 0);
	assert.match(r?.reason ?? "", /\(rule: notes\)/);
});

test("a trusted project's ** ask rule overrides a user deny rule", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		rules: [{ name: "all", paths: ["**"], level: "ask", summary: "x" }],
	});
	const g = await loadGateSession(undefined, undefined, {
		userConfig: {
			rules: [
				{ name: "notes", paths: ["~/notes/**"], level: "deny", summary: "n" },
			],
		},
	});
	await g.startSession("startup", uiContext(dir, true).ctx);
	const ui = scriptedUI(["Allow once"], dir);
	const r = await g.handler(fileCall("read", { path: "~/notes/a" }), ui.ctx);
	assert.equal(r, undefined);
	assert.equal(ui.dialogs.length, 1);
});

test("an untrusted project's deny rule tightens a path", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		rules: [
			{
				name: "lock",
				paths: ["src/**"],
				level: { write: "deny" },
				summary: "x",
			},
		],
	});
	const g = await loadGateSession(undefined, undefined, {
		userConfig: {
			rules: [{ name: "open", paths: ["**"], level: "allow", summary: "o" }],
		},
	});
	await g.startSession("startup", uiContext(dir, false).ctx);
	const r = await g.handler(
		fileCall("write", { path: "src/a.ts", content: "" }),
		fakeContext(dir),
	);
	assert.match(r?.reason ?? "", /\(rule: lock\)/);
	assert.equal(
		await g.handler(fileCall("read", { path: "src/a.ts" }), fakeContext(dir)),
		undefined,
	);
});

test("a path steer sends its instead text, in YOLO mode too", async () => {
	const rule = {
		name: "use-vault",
		paths: ["secrets/**"],
		level: "deny",
		summary: "secrets live in the vault",
		instead: "Use `vault kv get` instead.",
	};
	const g = await gate({ rules: [rule] });
	const dir = project();
	const r = await g.handler(
		fileCall("read", { path: "secrets/a" }),
		fakeContext(dir),
	);
	assert.match(
		r?.reason ?? "",
		/\(rule: use-vault\): secrets live in the vault\. The read of `secrets\/a` did not run\. Use `vault kv get` instead\./,
	);
	await g.runCommand("yolo", "", uiContext(dir).ctx);
	const yolo = await g.handler(
		fileCall("read", { path: "secrets/a" }),
		fakeContext(dir),
	);
	assert.match(yolo?.reason ?? "", /Use `vault kv get` instead\./);
});

test("a rule with both command and paths, or a path- name, is a problem", async () => {
	const g = await gate({
		rules: [
			{ name: "both", command: "x", paths: ["a"], summary: "x" },
			{ name: "path-mine", paths: ["a"], summary: "x" },
			{ name: "bad-glob", paths: ["a/!b"], summary: "x" },
			{ name: "cmd-allow", command: "x", level: "allow", summary: "x" },
		],
	});
	const ui = uiContext();
	await g.runCommand("bouncer", "check", ui.ctx);
	const text = messages(ui.notices);
	assert.match(text, /rules\[0\]: a rule takes "command" or "paths", not both/);
	assert.match(
		text,
		/rules: "path-mine": names starting with "path-" are kept for built-in path groups/,
	);
	assert.match(text, /rules: "bad-glob": path pattern "a\/!b" is not valid/);
	assert.match(text, /rules\[3\]: "level" must be "ask", "deny", "off"/);
});

test("a path rule written through a symlinked folder also matches the real path", async () => {
	const dir = project();
	mkdirSync(join(dir, "real"));
	symlinkSync(join(dir, "real"), join(dir, "link"));
	const g = await gate({
		rules: [
			{
				name: "linked",
				paths: [`${dir}/link/**`],
				level: "deny",
				summary: "x",
			},
		],
	});
	const r = await g.handler(
		fileCall("read", { path: join(dir, "real", "a") }),
		fakeContext(dir),
	);
	assert.match(r?.reason ?? "", /\(rule: linked\)/);
});

test("an untrusted project's profile path rule can't lower path-ssh", async () => {
	const dir = project();
	writeProjectConfig(dir, {
		profiles: {
			open: {
				rules: [
					{ name: "ssh", paths: ["~/.ssh/**"], level: "ask", summary: "x" },
				],
			},
		},
		agents: { scout: "open" },
	});
	const g = await loadGateSession(undefined, undefined, {
		env: { PI_BOUNCER_AGENT: "scout" },
	});
	await g.startSession("startup", uiContext(dir, false).ctx);
	const ui = scriptedUI(["Allow once"], dir);
	const r = await g.handler(
		fileCall("read", { path: "~/.ssh/id_ed25519" }),
		ui.ctx,
	);
	assert.equal(ui.dialogs.length, 0);
	assert.match(r?.reason ?? "", /\(rule: path-ssh\)/);
});

test("a search of the real folder reaches a rule written through a symlink", async () => {
	const dir = project();
	mkdirSync(join(dir, "real", "protected"), { recursive: true });
	symlinkSync(join(dir, "real"), join(dir, "link"));
	const g = await gate({
		rules: [
			{
				name: "linked",
				paths: [`${dir}/link/protected/**`],
				level: "deny",
				summary: "x",
			},
		],
	});
	const r = await g.handler(
		fileCall("grep", { pattern: "x", path: join(dir, "real") }),
		fakeContext(dir),
	);
	assert.match(r?.reason ?? "", /\(rule: linked\)/);
});

test("a bash rule named path-… still loads and denies", async () => {
	const g = await gate({
		rules: [
			{
				name: "path-deploy",
				command: "kubectl",
				args: ["delete"],
				level: "deny",
				summary: "cluster deletion",
			},
		],
	});
	const ui = uiContext();
	await g.runCommand("bouncer", "check", ui.ctx);
	assert.match(messages(ui.notices), /No config problems/);
	const r = await g.handler(
		bashCall("kubectl delete pod x"),
		fakeContext(project()),
	);
	assert.match(r?.reason ?? "", /\(rule: path-deploy\)/);
});
