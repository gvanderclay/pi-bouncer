import assert from "node:assert/strict";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// A copy outside this checkout, so the bare import finds no node_modules.
async function isolatedImportPi(): Promise<() => Promise<unknown>> {
	const dir = mkdtempSync(join(tmpdir(), "pi-package-"));
	copyFileSync(
		join(import.meta.dirname, "pi-package.ts"),
		join(dir, "pi-package.ts"),
	);
	const url = pathToFileURL(join(dir, "pi-package.ts")).href;
	return (await import(url)).importPi;
}

function fakePi(): string {
	const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
	mkdirSync(join(dir, "dist"));
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			type: "module",
			exports: { ".": { import: "./dist/index.js" } },
		}),
	);
	writeFileSync(join(dir, "dist/index.js"), "export const stub = 'fake';\n");
	return dir;
}

function withEnv(env: Record<string, string>): () => void {
	const saved = {
		PI_PACKAGE_DIR: process.env["PI_PACKAGE_DIR"],
		PATH: process.env["PATH"],
	};
	Object.assign(process.env, env);
	return (): void => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

test("importPi falls back to PI_PACKAGE_DIR", async () => {
	const importPi = await isolatedImportPi();
	const restore = withEnv({ PI_PACKAGE_DIR: fakePi(), PATH: "" });
	try {
		assert.deepEqual({ ...((await importPi()) as object) }, { stub: "fake" });
	} finally {
		restore();
	}
});

test("importPi finds the package above `pi` on PATH", async () => {
	const importPi = await isolatedImportPi();
	const pkg = fakePi();
	const bin = mkdtempSync(join(tmpdir(), "bin-"));
	writeFileSync(join(pkg, "dist/cli.js"), "");
	symlinkSync(join(pkg, "dist/cli.js"), join(bin, "pi"));
	const restore = withEnv({ PI_PACKAGE_DIR: "", PATH: bin });
	try {
		assert.deepEqual({ ...((await importPi()) as object) }, { stub: "fake" });
	} finally {
		restore();
	}
});

test("importPi names every place it tried when nothing resolves", async () => {
	const importPi = await isolatedImportPi();
	const restore = withEnv({ PI_PACKAGE_DIR: "", PATH: "" });
	try {
		await assert.rejects(importPi(), (error: Error) => {
			assert.match(error.message, /set PI_PACKAGE_DIR/);
			assert.match(
				error.message,
				/import\("@earendil-works\/pi-coding-agent"\)/,
			);
			assert.match(error.message, /\$PI_PACKAGE_DIR: not found/);
			assert.match(error.message, /`pi` on PATH: not found/);
			return true;
		});
	} finally {
		restore();
	}
});
