import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
	bashCall,
	fakeContext,
	type LoadedGate,
	loadGateSession,
	SESSION_FILE,
	SESSION_ID,
	scriptedUI,
	tempLogDir,
	uiContext,
} from "../test/harness.ts";

const failingLoader = (): Promise<never> =>
	Promise.reject(new Error("Cannot find package 'unbash'"));

const MIB = 1024 * 1024;

for (const reason of ["startup", "reload", "new", "resume", "fork"] as const) {
	test(`session_start (${reason}) appends one session record`, async () => {
		const { startSession, records } = await loadGateSession();
		await startSession(reason, fakeContext("/repo"));
		const all = records();
		assert.equal(all.length, 1);
		assert.ok(!Number.isNaN(Date.parse(String(all[0]?.time))));
		// The config field's contents are pinned in log.test.ts.
		const { config, ...rest } = all[0] ?? {};
		assert.equal(typeof config, "object");
		assert.deepEqual(
			{ ...rest, time: "T" },
			{
				v: 1,
				type: "session",
				time: "T",
				sessionId: SESSION_ID,
				sessionFile: SESSION_FILE,
				cwd: "/repo",
				reason,
				parser: true,
				yolo: false,
				auto: false,
			},
		);
	});
}

test("a bouncer whose parser failed records parser false", async () => {
	const { startSession, records } = await loadGateSession(failingLoader);
	await startSession("startup");
	assert.equal(records()[0]?.parser, false);
});

function seeded(logDir: string, size: number): Buffer {
	mkdirSync(logDir, { recursive: true, mode: 0o700 });
	const line = `${JSON.stringify({ v: 1, type: "old", pad: "x".repeat(1000) })}\n`;
	// Ends with a newline, so a record appended after it stays on its own line.
	const whole = line.repeat(Math.ceil(size / line.length));
	const text = `${whole.slice(0, size - 1)}\n`;
	const bytes = Buffer.from(text);
	writeFileSync(join(logDir, "log.jsonl"), bytes, { mode: 0o600 });
	return bytes;
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

test("a log over 5 MiB rotates into log.1.jsonl.gz at session start", async () => {
	const { startSession, records, logDir } = await loadGateSession();
	const old = seeded(logDir, 5 * MIB + 1);
	await startSession("startup");
	const gz = join(logDir, "log.1.jsonl.gz");
	assert.deepEqual(gunzipSync(readFileSync(gz)), old);
	assert.deepEqual(
		records().map((record) => record.type),
		["session"],
	);
	assert.deepEqual(readdirSync(logDir).sort(), ["log.1.jsonl.gz", "log.jsonl"]);
	assert.equal(mode(gz), 0o600);
	assert.equal(mode(join(logDir, "log.jsonl")), 0o600);
});

test("a log of exactly 5 MiB is not rotated", async () => {
	const { startSession, logDir } = await loadGateSession();
	const old = seeded(logDir, 5 * MIB);
	await startSession("startup");
	assert.equal(existsSync(join(logDir, "log.1.jsonl.gz")), false);
	const log = readFileSync(join(logDir, "log.jsonl"));
	assert.deepEqual(log.subarray(0, old.length), old);
	const added = JSON.parse(log.subarray(old.length).toString());
	assert.equal(added.type, "session");
});

test("with five generations, a rotation drops the oldest and keeps five", async () => {
	const { startSession, logDir } = await loadGateSession();
	seeded(logDir, 5 * MIB + 1);
	for (const n of [1, 2, 3, 4, 5]) {
		writeFileSync(join(logDir, `log.${n}.jsonl.gz`), `gen ${n}`, {
			mode: 0o600,
		});
	}
	await startSession("startup");
	assert.deepEqual(readdirSync(logDir).sort(), [
		"log.1.jsonl.gz",
		"log.2.jsonl.gz",
		"log.3.jsonl.gz",
		"log.4.jsonl.gz",
		"log.5.jsonl.gz",
		"log.jsonl",
	]);
	for (const n of [2, 3, 4, 5]) {
		const text = readFileSync(join(logDir, `log.${n}.jsonl.gz`), "utf8");
		assert.equal(text, `gen ${n - 1}`);
	}
});

/** A bouncer whose log directory is an existing file, so every write fails. */
async function brokenLog(): Promise<LoadedGate> {
	const logDir = tempLogDir();
	mkdirSync(dirname(logDir), { recursive: true });
	writeFileSync(logDir, "not a directory");
	return await loadGateSession(undefined, logDir);
}

const sameDecision: readonly (readonly [
	label: string,
	command: string,
	script: readonly (string | undefined)[] | undefined,
])[] = [
	["a hard deny without a UI", "sudo ls", undefined],
	["a hard deny with a UI", "sudo ls", []],
	["an ask answered Deny", "rm -rf build", ["Deny"]],
	["an ask answered Allow once", "rm -rf build", ["Allow once"]],
	["an ask answered Deny and stop", "rm -rf build", ["Deny and stop"]],
];

for (const [label, command, script] of sameDecision) {
	test(`an unwritable log leaves ${label} unchanged`, async () => {
		const context = (): ReturnType<typeof fakeContext> =>
			script ? scriptedUI([...script]).ctx : fakeContext();
		const working = await loadGateSession();
		const expected = await working.handler(bashCall(command), context());
		assert.equal(working.records().length, 1);
		const broken = await brokenLog();
		const result = await broken.handler(bashCall(command), context());
		assert.deepEqual(result, expected);
	});
}

test("the first failure warns once, naming the log and the error", async () => {
	const { handler, logDir } = await brokenLog();
	const { ctx, notices } = uiContext();
	await handler(bashCall("sudo ls"), ctx);
	await handler(bashCall("sudo ls"), ctx);
	const failures = notices.filter(({ message }) => message.includes("log"));
	assert.equal(failures.length, 1);
	assert.equal(failures[0]?.level, "warning");
	assert.ok(failures[0]?.message.includes(join(logDir, "log.jsonl")));
	assert.match(failures[0]?.message ?? "", /EEXIST|ENOTDIR/);
});

test("after session_start, the next failure warns again", async () => {
	const { handler, startSession } = await brokenLog();
	const first = uiContext();
	await handler(bashCall("sudo ls"), first.ctx);
	await startSession("new", fakeContext());
	const second = uiContext();
	await handler(bashCall("sudo ls"), second.ctx);
	const warned = (notices: typeof first.notices): number =>
		notices.filter(({ message }) => message.includes("log.jsonl")).length;
	assert.equal(warned(first.notices), 1);
	assert.equal(warned(second.notices), 1);
});

test("a failing session_start with a UI warns once for the whole session", async () => {
	const { handler, startSession } = await brokenLog();
	const { ctx, notices } = uiContext();
	await startSession("startup", ctx);
	await handler(bashCall("sudo ls"), ctx);
	const failures = notices.filter(({ message }) =>
		message.includes("log.jsonl"),
	);
	assert.equal(failures.length, 1);
});

test("without a UI, failures neither throw nor notify", async () => {
	const { handler, startSession } = await brokenLog();
	await startSession("startup", fakeContext());
	const result = await handler(bashCall("sudo ls"), fakeContext());
	assert.equal(result?.block, true);
});

test("a failing session_start still clears session allows", async () => {
	const { handler, startSession } = await brokenLog();
	await handler(
		bashCall("rm -rf dist"),
		scriptedUI(["Allow for this session"]).ctx,
	);
	await startSession("new", fakeContext());
	const again = scriptedUI(["Deny"]);
	const result = await handler(bashCall("rm -rf dist"), again.ctx);
	assert.equal(result?.block, true);
	assert.equal(again.dialogs.length, 1);
});

function generations(logDir: string, ns: readonly number[]): void {
	for (const n of ns) {
		writeFileSync(join(logDir, `log.${n}.jsonl.gz`), `gen ${n}`, {
			mode: 0o600,
		});
	}
}

test("rotateAboveMiB 1 rotates a 1.5 MiB log; the default does not", async () => {
	const configured = await loadGateSession();
	configured.writeRouteConfig({ log: { rotateAboveMiB: 1 } });
	seeded(configured.logDir, 1.5 * MIB);
	await configured.startSession("startup");
	assert.ok(existsSync(join(configured.logDir, "log.1.jsonl.gz")));
	const plain = await loadGateSession();
	seeded(plain.logDir, 1.5 * MIB);
	await plain.startSession("startup");
	assert.equal(existsSync(join(plain.logDir, "log.1.jsonl.gz")), false);
});

test("generations 2 keeps two gzipped generations after a rotation", async () => {
	const { startSession, logDir, writeRouteConfig } = await loadGateSession();
	writeRouteConfig({ log: { generations: 2 } });
	seeded(logDir, 5 * MIB + 1);
	generations(logDir, [1, 2, 3, 4]);
	await startSession("startup");
	assert.deepEqual(readdirSync(logDir).sort(), [
		"log.1.jsonl.gz",
		"log.2.jsonl.gz",
		"log.jsonl",
	]);
	assert.equal(readFileSync(join(logDir, "log.2.jsonl.gz"), "utf8"), "gen 1");
});

test("generations 0 keeps no gzipped history and starts a fresh log", async () => {
	const { startSession, logDir, writeRouteConfig, records } =
		await loadGateSession();
	writeRouteConfig({ log: { generations: 0 } });
	seeded(logDir, 5 * MIB + 1);
	await startSession("startup");
	assert.deepEqual(readdirSync(logDir), ["log.jsonl"]);
	assert.deepEqual(
		records().map(({ type }) => type),
		["session"],
	);
});

const DAY = 24 * 60 * 60 * 1000;

function aged(path: string, days: number): void {
	const then = new Date(Date.now() - days * DAY);
	utimesSync(path, then, then);
}

test("maxAgeDays 30 prunes a 40-day-old generation and keeps the rest", async () => {
	const { startSession, logDir, writeRouteConfig } = await loadGateSession();
	writeRouteConfig({ log: { maxAgeDays: 30 } });
	seeded(logDir, 100);
	generations(logDir, [1, 2]);
	aged(join(logDir, "log.1.jsonl.gz"), 10);
	aged(join(logDir, "log.2.jsonl.gz"), 40);
	aged(join(logDir, "log.jsonl"), 400);
	await startSession("startup");
	assert.deepEqual(readdirSync(logDir).sort(), ["log.1.jsonl.gz", "log.jsonl"]);
});

test("without maxAgeDays nothing is pruned by age", async () => {
	const { startSession, logDir } = await loadGateSession();
	seeded(logDir, 100);
	generations(logDir, [1]);
	aged(join(logDir, "log.1.jsonl.gz"), 4000);
	await startSession("startup");
	assert.ok(existsSync(join(logDir, "log.1.jsonl.gz")));
});

test("a broken route config rotates on built-in limits", async () => {
	const { startSession, logDir, writeRouteConfig } = await loadGateSession();
	writeRouteConfig("{ not json");
	seeded(logDir, 5 * MIB + 1);
	await startSession("startup");
	assert.ok(existsSync(join(logDir, "log.1.jsonl.gz")));
});
