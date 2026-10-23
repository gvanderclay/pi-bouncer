// Path rules on Pi's file tools, driven through the tool_call handler with a
// temporary HOME.
import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileCall, tempHome } from "../test/file-harness.ts";
import {
	bashCall,
	fakeContext,
	type LoadedGate,
	loadGateSession,
	scriptedUI,
	tempProjectDir,
	uiContext,
} from "../test/harness.ts";

const HOME = tempHome(); // before any gate loads

async function gate(userConfig: object = {}): Promise<LoadedGate> {
	const g = await loadGateSession(undefined, undefined, { userConfig });
	await g.startSession("startup");
	return g;
}

function project(): string {
	const dir = tempProjectDir();
	mkdirSync(dir, { recursive: true });
	return dir;
}

function calls(g: LoadedGate): ReturnType<LoadedGate["records"]> {
	return g.records().filter((x) => x.type === "call");
}

test("a read of ~/.ssh is denied by path-ssh, so keys never reach the model", async () => {
	const g = await gate();
	const r = await g.handler(
		fileCall("read", { path: "~/.ssh/id_ed25519" }),
		fakeContext(project()),
	);
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /\(rule: path-ssh\)/);
	assert.match(
		r?.reason ?? "",
		/Ask the user to do this or to change the bouncer's `levels`/,
	);
	const [rec] = calls(g);
	assert.equal(rec?.command, "read ~/.ssh/id_ed25519");
	assert.equal(rec?.tool, "read");
	assert.deepEqual(rec?.path, {
		direction: "read",
		typed: "~/.ssh/id_ed25519",
		real: join(HOME, ".ssh/id_ed25519"),
	});
});

for (const spelled of [
	"@~/.ssh/id_ed25519",
	`${HOME}/.ssh/id_ed25519`,
	"~/.ssh/../.ssh/id_ed25519",
	"~/.SSH/id_ed25519",
	`file://${HOME}/.ssh/id_ed25519`,
]) {
	test(`the spelling ${spelled} doesn't get past path-ssh`, async (t) => {
		if (spelled.includes(".SSH") && process.platform !== "darwin") {
			t.skip("case folds only on macOS's file system");
			return;
		}
		const g = await gate();
		const r = await g.handler(
			fileCall("read", { path: spelled }),
			fakeContext(project()),
		);
		assert.equal(r?.block, true);
	});
}

test("a file under ~/.ssh with a newline in its name is still denied", async () => {
	const name = "key\nprivate";
	writeFileSync(join(HOME, ".ssh", name), "not a real key\n");
	const g = await gate();
	const r = await g.handler(
		fileCall("read", { path: join(HOME, ".ssh", name) }),
		fakeContext(project()),
	);
	assert.equal(r?.block, true);
});

test("a key that doesn't exist yet under ~/.ssh is still denied", async () => {
	const g = await gate();
	const r = await g.handler(
		fileCall("read", { path: "~/.ssh/new/id_rsa" }),
		fakeContext(project()),
	);
	assert.equal(r?.block, true);
});

test("a relative path from the home folder is caught", async () => {
	const g = await gate();
	const r = await g.handler(
		fileCall("read", { path: ".ssh/id_ed25519" }),
		fakeContext(HOME),
	);
	assert.equal(r?.block, true);
});

test("a symlink in the project that points into ~/.ssh is caught as ~/.ssh", async () => {
	const dir = project();
	symlinkSync(join(HOME, ".ssh"), join(dir, "keys"));
	const g = await gate();
	const r = await g.handler(
		fileCall("read", { path: "keys/id_ed25519" }),
		fakeContext(dir),
	);
	assert.equal(r?.block, true);
	const [rec] = calls(g);
	assert.deepEqual(rec?.path, {
		direction: "read",
		typed: "keys/id_ed25519",
		real: join(HOME, ".ssh/id_ed25519"),
	});
});

test("a file not there yet in a symlinked folder resolves through its real parent", async () => {
	const dir = project();
	symlinkSync(join(HOME, ".ssh"), join(dir, "keys"));
	const g = await gate();
	const r = await g.handler(
		fileCall("read", { path: "keys/later/id_rsa" }),
		fakeContext(dir),
	);
	assert.equal(r?.block, true);
});

test("a dangling project symlink into ~/.ssh is followed to its target", async () => {
	const dir = project();
	symlinkSync(join(HOME, ".ssh/not-yet"), join(dir, "key"));
	const g = await gate();
	const r = await g.handler(
		fileCall("read", { path: "key" }),
		fakeContext(dir),
	);
	assert.equal(r?.block, true);
});

test("a path the bouncer can't resolve (a symlink loop) is blocked, never allowed", async () => {
	const dir = project();
	symlinkSync(join(dir, "b"), join(dir, "a"));
	symlinkSync(join(dir, "a"), join(dir, "b"));
	const g = await gate();
	const r = await g.handler(
		fileCall("read", { path: "a/x" }),
		fakeContext(dir),
	);
	assert.equal(r?.block, true);
});

test("a HOME given through a symlink still guards the real ~/.ssh", async (t) => {
	const linked = join(project(), "home-link");
	symlinkSync(HOME, linked);
	process.env["HOME"] = linked;
	t.after(() => {
		process.env["HOME"] = HOME;
	});
	const g = await gate();
	const r = await g.handler(
		fileCall("read", { path: join(HOME, ".ssh/id_ed25519") }),
		fakeContext(project()),
	);
	assert.equal(r?.block, true);
});

test("a project file read is allowed and not logged", async () => {
	const g = await gate();
	assert.equal(
		await g.handler(
			fileCall("read", { path: "README.md" }),
			fakeContext(project()),
		),
		undefined,
	);
	assert.equal(calls(g).length, 0);
});

test("YOLO lets a path-ssh read through, as it does any deny outside the always-deny set", async () => {
	const g = await gate();
	await g.runCommand("yolo", "", uiContext().ctx);
	assert.equal(
		await g.handler(
			fileCall("read", { path: "~/.ssh/id_ed25519" }),
			fakeContext(project()),
		),
		undefined,
	);
	const [rec] = calls(g);
	assert.equal(rec?.withoutYolo, "blocked");
});

test("levels path-ssh off restores the old behaviour in one line", async () => {
	const g = await gate({ levels: { "path-ssh": "off" } });
	assert.equal(
		await g.handler(
			fileCall("read", { path: "~/.ssh/known_hosts" }),
			fakeContext(project()),
		),
		undefined,
	);
});

test("a key inside ~/.ssh is still denied with path-ssh off: path-keys covers it", async () => {
	const g = await gate({ levels: { "path-ssh": "off" } });
	const r = await g.handler(
		fileCall("read", { path: "~/.ssh/id_ed25519" }),
		fakeContext(project()),
	);
	assert.match(r?.reason ?? "", /\(rule: path-keys\)/);
});

test("levels path-ssh ask with no UI blocks the read", async () => {
	const g = await gate({ levels: { "path-ssh": "ask" } });
	const r = await g.handler(
		fileCall("read", { path: "~/.ssh/id_ed25519" }),
		fakeContext(project()),
	);
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /\(rule: path-ssh\)/);
});

test("the search tools aren't decided yet", async () => {
	const g = await gate();
	assert.equal(
		await g.handler(fileCall("ls", { path: "~/.ssh" }), fakeContext(project())),
		undefined,
	);
});

test("a bash command never meets a path group", async () => {
	const g = await gate();
	assert.equal(
		await g.handler(bashCall("cat ~/.ssh/id_ed25519"), fakeContext(project())),
		undefined,
	);
});

for (const input of [{}, { path: 42 }, { path: null }]) {
	test(`a read with path ${JSON.stringify(input)} is blocked, never allowed`, async () => {
		const g = await gate();
		const r = await g.handler(fileCall("read", input), fakeContext(project()));
		assert.equal(r?.block, true);
	});
}

for (const [group, rel] of [
	["path-aws", ".aws/credentials"],
	["path-gnupg", ".gnupg/private-keys-v1.d/a.key"],
	["path-kube", ".kube/config"],
	["path-docker", ".docker/config.json"],
	["path-gcloud", ".config/gcloud/credentials.db"],
	["path-azure", ".azure/accessTokens.json"],
] as const) {
	test(`${group} denies reading ~/${rel}`, async () => {
		const g = await gate();
		const r = await g.handler(
			fileCall("read", { path: `~/${rel}` }),
			fakeContext(project()),
		);
		assert.match(r?.reason ?? "", new RegExp(`\\(rule: ${group}\\)`));
	});
}

test("path-ssh denies writing a key too, not only reading it", async () => {
	const g = await gate();
	const r = await g.handler(
		fileCall("write", { path: "~/.ssh/id_ed25519", content: "x" }),
		fakeContext(project()),
	);
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /\(rule: path-ssh\)/);
});

test("path-pi-auth denies reading Pi's auth.json in the agent dir", async () => {
	const g = await gate();
	const r = await g.handler(
		fileCall("read", { path: join(g.agentDir, "auth.json") }),
		fakeContext(project()),
	);
	assert.match(r?.reason ?? "", /\(rule: path-pi-auth\)/);
});

test("models.json in the agent dir stays readable", async () => {
	const g = await gate();
	assert.equal(
		await g.handler(
			fileCall("read", { path: join(g.agentDir, "models.json") }),
			fakeContext(project()),
		),
		undefined,
	);
});

for (const [file, rule] of [
	["a/b/.env", "path-env"],
	[".env.local", "path-env"],
	["certs/server.pem", "path-keys"],
	["deploy/id_rsa", "path-keys"],
	[".npmrc", "path-npmrc"],
	[".pypirc", "path-pypirc"],
	[".netrc", "path-netrc"],
	[".git-credentials", "path-git-credentials"],
] as const) {
	test(`${rule} denies reading ${file} at any depth`, async () => {
		const g = await gate();
		const r = await g.handler(
			fileCall("read", { path: file }),
			fakeContext(project()),
		);
		assert.match(r?.reason ?? "", new RegExp(`\\(rule: ${rule}\\)`));
	});
}

for (const file of [
	".env.example",
	".env.sample",
	".env.template",
	"id_ed25519.pub",
]) {
	test(`${file} stays readable`, async () => {
		const g = await gate();
		assert.equal(
			await g.handler(fileCall("read", { path: file }), fakeContext(project())),
			undefined,
		);
	});
}

for (const file of [".git/config", "/etc/hosts", "~/.zshrc"]) {
	test(`reading ${file} is allowed: its group guards writes only`, async () => {
		const g = await gate();
		assert.equal(
			await g.handler(fileCall("read", { path: file }), fakeContext(project())),
			undefined,
		);
	});
}

test("an edit of .git/config asks, and the dialog shows the diff", async () => {
	const g = await gate();
	const ui = scriptedUI(["Allow once"], project());
	const call = fileCall("edit", {
		path: ".git/config",
		edits: [{ oldText: "bare = false", newText: "bare = true" }],
	});
	assert.equal(await g.handler(call, ui.ctx), undefined);
	assert.ok(ui.dialogs[0]?.options?.includes("Allow for this session"));
	const text = JSON.stringify(ui.dialogs[0]);
	assert.match(text, /path-git/);
	assert.match(text, /-bare = false/);
	assert.match(text, /\+bare = true/);
});

test("a write to a new .env asks and shows it as a new file", async () => {
	const g = await gate();
	const ui = scriptedUI(["Allow once"], project());
	await g.handler(
		fileCall("write", { path: ".env", content: "A=1\n" }),
		ui.ctx,
	);
	assert.ok(ui.dialogs[0]?.options?.includes("Allow for this session"));
	assert.match(JSON.stringify(ui.dialogs[0]), /new file[\s\S]*A=1/);
});

test("the same .env is denied to read and only asked about to write", async () => {
	const g = await gate();
	const read = await g.handler(
		fileCall("read", { path: ".env" }),
		fakeContext(project()),
	);
	assert.match(read?.reason ?? "", /\(rule: path-env\)/);
	const ui = scriptedUI(["Allow once"], project());
	assert.equal(
		await g.handler(
			fileCall("write", { path: ".env", content: "A=1\n" }),
			ui.ctx,
		),
		undefined,
	);
	assert.equal(ui.dialogs.length, 1);
});

test("a session allow covers the exact real path and direction only", async () => {
	const dir = project();
	const g = await gate();
	const ui = scriptedUI(["Allow for this session", "Deny"], dir);
	const w = (path: string): ReturnType<typeof fileCall> =>
		fileCall("write", { path, content: "x" });
	assert.equal(await g.handler(w(".git/config"), ui.ctx), undefined);
	assert.equal(await g.handler(w(`${dir}/.git/config`), ui.ctx), undefined);
	assert.equal(
		(await g.handler(w(".git/hooks/pre-commit"), ui.ctx))?.block,
		true,
	);
	assert.equal(ui.dialogs.length, 2);
});

test("with no UI a write ask is blocked, and says no one could answer", async () => {
	const g = await gate();
	const r = await g.handler(
		fileCall("write", { path: ".git/config", content: "x" }),
		fakeContext(project()),
	);
	assert.equal(r?.block, true);
	assert.match(r?.reason ?? "", /\(rule: path-git\)/);
	assert.match(r?.reason ?? "", /no one can answer/);
});

test("the dialog names the real target when a symlink was followed", async () => {
	const dir = realpathSync(project());
	mkdirSync(join(dir, "real/.git"), { recursive: true });
	symlinkSync(join(dir, "real/.git"), join(dir, "link"));
	const g = await gate();
	const ui = scriptedUI(["Deny"], dir);
	await g.handler(
		fileCall("write", { path: "link/config", content: "x" }),
		ui.ctx,
	);
	assert.ok(
		JSON.stringify(ui.dialogs[0]).includes(
			`link/config → ${dir}/real/.git/config`,
		),
	);
});

test("path-git catches a nested .git folder but not .github or .gitignore", async () => {
	const g = await gate();
	const dir = project();
	const ui = scriptedUI(["Allow once"], dir);
	assert.equal(
		await g.handler(
			fileCall("write", { path: "sub/.git/config", content: "x" }),
			ui.ctx,
		),
		undefined,
	);
	assert.equal(ui.dialogs.length, 1);
	for (const path of [".gitignore", ".github/workflows/ci.yml"]) {
		assert.equal(
			await g.handler(
				fileCall("write", { path, content: "x" }),
				fakeContext(dir),
			),
			undefined,
			path,
		);
	}
});

test("a write whose existing file can't be read still opens the dialog", async (t) => {
	if (process.getuid?.() === 0) {
		t.skip("root reads a 0-permission file");
		return;
	}
	const dir = project();
	mkdirSync(join(dir, ".git"));
	const locked = join(dir, ".git/config");
	writeFileSync(locked, "secret\n");
	chmodSync(locked, 0o000);
	t.after(() => chmodSync(locked, 0o600));
	const g = await gate();
	const ui = scriptedUI(["Deny"], dir);
	const r = await g.handler(
		fileCall("write", { path: ".git/config", content: "x" }),
		ui.ctx,
	);
	assert.equal(r?.block, true);
	assert.equal(ui.dialogs.length, 1);
	assert.match(JSON.stringify(ui.dialogs[0]), /could not read/);
});

for (const path of [
	"/tmp/pi-bouncer-path-system",
	"/private/tmp/pi-bouncer-path-system",
	`${HOME}/notes.txt`,
	`${HOME}/.config/app/settings.json`,
]) {
	test(`a write to ${path} is allowed: path-system leaves it alone`, async () => {
		const g = await gate();
		assert.equal(
			await g.handler(
				fileCall("write", { path, content: "x" }),
				fakeContext(project()),
			),
			undefined,
		);
	});
}

for (const file of [
	"/etc/ssl/private/server.pem",
	"/usr/local/x.key",
	".git/id_rsa",
]) {
	test(`a key at ${file} is denied by path-keys, not allowed by its folder group`, async () => {
		const g = await gate();
		const r = await g.handler(
			fileCall("read", { path: file }),
			fakeContext(project()),
		);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /\(rule: path-keys\)/);
	});
}
