// Path rules on Pi's file tools, driven through the tool_call handler with a
// temporary HOME.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileCall, tempHome } from "../test/file-harness.ts";
import {
	bashCall,
	fakeContext,
	type LoadedGate,
	loadGateSession,
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
			fileCall("read", { path: "~/.ssh/id_ed25519" }),
			fakeContext(project()),
		),
		undefined,
	);
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

test("the other file tools aren't decided yet", async () => {
	const g = await gate();
	const ctx = fakeContext(project());
	const path = "~/.ssh/id_ed25519";
	assert.equal(
		await g.handler(fileCall("write", { path, content: "x" }), ctx),
		undefined,
	);
	assert.equal(
		await g.handler(fileCall("ls", { path: "~/.ssh" }), ctx),
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
