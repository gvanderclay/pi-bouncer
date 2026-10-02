import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	bashCall,
	expectAllow,
	expectDeny,
	fakeContext,
	loadGateSession,
	tempLogDir,
	tempProjectDir,
	writeProjectConfig,
} from "../../test/harness.ts";
import { trashHint } from "../gate.ts";
import { findTrash } from "../trash.ts";

const denied = [
	"trash ~",
	"trash ~/",
	"trash ~/*",
	"trash -v ~/Documents",
	"trash-put /etc",
	"trash-put --trash-dir /tmp/t -- /usr",
	"gio trash ~/.ssh",
	"/usr/bin/trash /",
	"cd /tmp && trash $HOME",
];

for (const command of denied) {
	test(`${command} is denied as trash-root`, async () => {
		await expectDeny(command, "trash-root");
	});
}

const allowed = [
	"trash build",
	"trash /tmp/x ~/workspace/proj/dist",
	"trash-put --trash-dir /etc build",
	"gio info ~",
	"gio trash --empty",
	"echo trash ~",
];

for (const command of allowed) {
	test(`${command} runs without an ask`, async () => {
		await expectAllow(command);
	});
}

async function ruleOf(
	config: object,
	command: string,
	project?: object,
): Promise<string> {
	const gate = await loadGateSession(undefined, tempLogDir(), {
		userConfig: config,
	});
	const cwd = tempProjectDir();
	if (project) writeProjectConfig(cwd, project);
	await gate.startSession("startup", fakeContext(cwd));
	const result = await gate.handler(bashCall(command), fakeContext(cwd));
	return /\(rule: ([a-z-]+)\)/.exec(result?.reason ?? "")?.[1] ?? "";
}

test("trash-root covers the trashCommand program and the protect paths", async () => {
	const config = {
		trashCommand: "/opt/bin/mytrash",
		protect: { home: ["code"] },
	};
	assert.equal(await ruleOf(config, "mytrash ~"), "trash-root");
	assert.equal(await ruleOf(config, "trash ~/code"), "trash-root");
	assert.equal(await ruleOf(config, "mytrash ~/code/old"), "");
});

test("a project file cannot set trashCommand", async () => {
	const gate = await loadGateSession();
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { trashCommand: "evil" });
	await gate.startSession("startup", fakeContext(cwd));
	const result = await gate.handler(bashCall("rm -rf build"), fakeContext(cwd));
	assert.ok(!(result?.reason ?? "").includes("evil"));
	assert.equal(await ruleOf({}, "evil ~", { trashCommand: "evil" }), "");
});

test('"levels": {"trash-root": "off"} lets it through', async () => {
	assert.equal(
		await ruleOf({ levels: { "trash-root": "off" } }, "trash ~"),
		"",
	);
});

test("the first trash program on PATH is found, and the config's wins", () => {
	const dir = mkdtempSync(join(tmpdir(), "path-"));
	assert.equal(findTrash(undefined, dir), undefined);
	writeFileSync(join(dir, "gio"), "");
	assert.equal(findTrash(undefined, dir), undefined, "not executable");
	chmodSync(join(dir, "gio"), 0o755);
	assert.equal(findTrash(undefined, `/nowhere::${dir}`), "gio trash");
	writeFileSync(join(dir, "trash-put"), "", { mode: 0o755 });
	assert.equal(findTrash(undefined, dir), "trash-put");
	assert.equal(findTrash("/opt/bin/mytrash", dir), "/opt/bin/mytrash");
});

test("a refused recursive rm with no UI suggests the trash program", async () => {
	const dir = mkdtempSync(join(tmpdir(), "path-"));
	writeFileSync(join(dir, "trash-put"), "", { mode: 0o755 });
	const gate = await loadGateSession(undefined, tempLogDir(), {
		env: { PATH: dir },
	});
	await gate.startSession("startup");
	const result = await gate.handler(bashCall("rm -rf build"), fakeContext());
	assert.ok(
		result?.reason?.endsWith(trashHint("trash-put")),
		String(result?.reason),
	);
	const other = await gate.handler(bashCall("git clean -fdx"), fakeContext());
	assert.ok(!other?.reason?.includes("trash"), String(other?.reason));
});

test("with no trash program, the refusal suggests none", async () => {
	const gate = await loadGateSession(undefined, tempLogDir(), {
		env: { PATH: mkdtempSync(join(tmpdir(), "path-")) },
	});
	await gate.startSession("startup");
	const result = await gate.handler(bashCall("rm -rf build"), fakeContext());
	assert.ok(!result?.reason?.includes("trash"), String(result?.reason));
});
