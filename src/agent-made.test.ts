// A recursive rm of a directory the agent made this session runs without an
// ask, in every mode and with no UI; everything that only looks like one
// still asks (and so, here with no UI, blocks).
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	bashCall,
	bashResult,
	fakeContext,
	type LoadedGate,
	loadGateSession,
	tempLogDir,
	tempProjectDir,
	writeProjectConfig,
} from "../test/harness.ts";
import { AGENT_MADE_HINT } from "./gate.ts";

async function session(userConfig: object = {}): Promise<LoadedGate> {
	const gate = await loadGateSession(undefined, tempLogDir(), { userConfig });
	await gate.startSession("startup");
	return gate;
}

/** Decides `command`; if allowed, runs `act` as the command would, then reports the result. */
async function run(
	gate: LoadedGate,
	command: string,
	act: () => void = (): void => {},
	result: { isError?: boolean; text?: string; background?: boolean } = {},
): Promise<{ block?: boolean; reason?: string } | undefined> {
	await gate.endMessage(assistant(["t1"]));
	const decision = await gate.handler(bashCall(command), fakeContext());
	if (decision?.block) return decision;
	act();
	await gate.finishTool(bashResult(command, result));
	return decision;
}

// The assistant message whose tool calls are about to be checked.
function assistant(ids: readonly string[]): object {
	const content = ids.map((id) => ({ type: "toolCall", id, name: "bash" }));
	return { role: "assistant", content };
}

function parent(): string {
	return mkdtempSync(join(tmpdir(), "agent-made-"));
}

async function made(gate: LoadedGate): Promise<string> {
	const dir = join(parent(), "made");
	await run(gate, `mkdir ${dir}`, () => mkdirSync(dir));
	return dir;
}

test("rm -rf of a directory the agent made, or of something in it, runs", async () => {
	const gate = await session();
	const dir = await made(gate);
	mkdirSync(join(dir, "sub"));
	writeFileSync(join(dir, "sub", "file"), "x");
	assert.equal(await run(gate, `rm -rf ${dir}/sub`), undefined);
	assert.equal(await run(gate, `rm -rf ${dir}/`), undefined);
	assert.equal(await run(gate, `cd /work && rm -r -- '${dir}'`), undefined);
});

test("mkdir -p counts from the highest directory that was missing", async () => {
	const gate = await session();
	const top = join(parent(), "a");
	const deep = join(top, "b", "c");
	await run(gate, `mkdir -p ${deep}`, () =>
		mkdirSync(deep, { recursive: true }),
	);
	assert.equal(await run(gate, `rm -rf ${top}`), undefined);
});

test("a lone mktemp -d's directory counts", async () => {
	const gate = await session();
	assert.equal(
		await gate.handler(bashCall("mktemp -d"), fakeContext()),
		undefined,
	);
	const dir = mkdtempSync(join(tmpdir(), "tmp."));
	await gate.finishTool(bashResult("mktemp -d", { text: `${dir}\n` }));
	assert.equal(await run(gate, `rm -rf ${dir}`), undefined);
});

async function asks(gate: LoadedGate, command: string): Promise<string> {
	const result = await run(gate, command);
	assert.equal(result?.block, true, `expected ${command} to ask`);
	assert.match(result?.reason ?? "", /\(rule: recursive-rm\)/);
	return result?.reason ?? "";
}

test("mkdir -p of a directory that already existed proves nothing", async () => {
	const gate = await session();
	const dir = parent();
	await run(gate, `mkdir -p ${dir}`);
	await asks(gate, `rm -rf ${dir}`);
});

test("a failed or detached mkdir, or a mktemp with more on the line, proves nothing", async () => {
	const gate = await session();
	const failed = join(parent(), "failed");
	await run(gate, `mkdir ${failed}`, () => mkdirSync(failed), {
		isError: true,
	});
	await asks(gate, `rm -rf ${failed}`);
	const detached = join(parent(), "detached");
	const act = (): void => mkdirSync(detached);
	await run(gate, `mkdir ${detached}`, act, { background: true });
	await asks(gate, `rm -rf ${detached}`);
	const busy = mkdtempSync(join(tmpdir(), "tmp."));
	await run(gate, "D=$(mktemp -d) && echo $D", () => {}, { text: busy });
	await asks(gate, `rm -rf ${busy}`);
});

test("a variable, glob, relative path, home path or wrapper still asks", async () => {
	const gate = await session();
	const dir = await made(gate);
	await asks(gate, `D=${dir}; rm -rf "$D"`);
	await asks(gate, `rm -rf ${dir}/*`);
	await asks(gate, `cd ${dir}/.. && rm -rf made`);
	await asks(gate, "rm -rf ~/made");
	await asks(gate, `echo ~ | xargs rm -rf ${dir}`);
	await asks(gate, `bash -c 'rm -rf ${dir}'`);
	await asks(gate, `timeout 5 rm -rf ${dir}`);
});

test("one target outside an agent-made directory makes the whole rm ask", async () => {
	const gate = await session();
	const dir = await made(gate);
	await asks(gate, `rm -rf ${dir} ${parent()}`);
});

test("a symlink out of the directory still asks, with or without a trailing slash", async () => {
	const gate = await session();
	const dir = await made(gate);
	symlinkSync(parent(), join(dir, "link"));
	await asks(gate, `rm -rf ${dir}/link/`);
	await asks(gate, `rm -rf ${dir}/link`);
});

test("a file moved in from outside makes the directory ask again", async () => {
	const gate = await session();
	const dir = await made(gate);
	const outside = join(parent(), "old");
	writeFileSync(outside, "the user's");
	const before = new Date("2020-01-01");
	utimesSync(outside, before, before);
	mkdirSync(join(dir, "sub"));
	renameSync(outside, join(dir, "sub", "old"));
	await asks(gate, `rm -rf ${dir}`);
	await asks(gate, `rm -rf ${dir}/sub/old`);
});

test("the refusal with no UI says how a folder the agent made gets through", async () => {
	const gate = await session();
	assert.ok((await asks(gate, "rm -rf build")).endsWith(AGENT_MADE_HINT));
});

test('"trustAgentMade": false asks as before, with no hint', async () => {
	const gate = await session({ trustAgentMade: false });
	const dir = await made(gate);
	const reason = await asks(gate, `rm -rf ${dir}`);
	assert.ok(!reason.includes(AGENT_MADE_HINT));
});

test("rm-root still denies an agent-made directory", async () => {
	const gate = await session();
	const dir = await made(gate);
	const result = await run(gate, `rm -rf --no-preserve-root ${dir}`);
	assert.match(result?.reason ?? "", /\(rule: rm-root\)/);
});

test("a new session forgets what the agent made", async () => {
	const gate = await session();
	const dir = await made(gate);
	await gate.startSession("new");
	await asks(gate, `rm -rf ${dir}`);
});

test('a project file\'s "trustAgentMade": false turns it off too', async () => {
	const gate = await session();
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { trustAgentMade: false });
	await gate.startSession("new", fakeContext(cwd));
	const dir = join(parent(), "made");
	const ctx = fakeContext(cwd);
	await gate.endMessage(assistant(["t1"]));
	await gate.handler(bashCall(`mkdir ${dir}`), ctx);
	mkdirSync(dir);
	await gate.finishTool(bashResult(`mkdir ${dir}`), ctx);
	await gate.endMessage(assistant(["t1"]));
	const result = await gate.handler(bashCall(`rm -rf ${dir}`), ctx);
	assert.match(result?.reason ?? "", /\(rule: recursive-rm\)/);
});

test("anything that could fill the folder earlier on the line makes it ask", async () => {
	const gate = await session();
	const dir = await made(gate);
	const outside = parent();
	await asks(gate, `mv ${outside} ${dir}/x && rm -rf ${dir}`);
	await asks(gate, `cp -al ${outside} ${dir}/x; rm -rf ${dir}`);
	await asks(gate, `rm -rf $(mv ${outside} ${dir}/x) ${dir}`);
	// The scan cannot see a command an expansion runs, or which `rm` runs.
	await asks(
		gate,
		`x='a[$(mv ${outside} ${dir}/x)]'; echo $((x)); rm -rf ${dir}`,
	);
	await asks(
		gate,
		`y='$(mv ${outside} ${dir}/x)'; echo \${y@P}; rm -rf ${dir}`,
	);
	await asks(gate, `PATH=${dir}/bin:/usr/bin; rm -rf ${dir}`);
	// Any expansion at all: the value could be crafted where the scan cannot see.
	await asks(gate, `echo $((HOME)) && rm -rf ${dir}`);
	assert.equal(
		await run(gate, `cd /work && ls ${dir} && rm -rf ${dir}`),
		undefined,
	);
});

test("an rm with sibling calls in the same message asks", async () => {
	const gate = await session();
	const dir = await made(gate);
	await gate.endMessage(assistant(["t0", "t1"]));
	const result = await gate.handler(bashCall(`rm -rf ${dir}`), fakeContext());
	assert.match(result?.reason ?? "", /\(rule: recursive-rm\)/);
});

test("a folder deleted and made again at the same path is not the agent's", async () => {
	const gate = await session();
	const dir = await made(gate);
	await run(gate, `rm -rf ${dir}`, () => rmSync(dir, { recursive: true }));
	mkdirSync(dir);
	await asks(gate, `rm -rf ${dir}`);
});

test("a folder replaced between the agent's calls is not the agent's", async () => {
	const gate = await session();
	const dir = await made(gate);
	rmSync(dir, { recursive: true });
	mkdirSync(dir);
	await asks(gate, `rm -rf ${dir}`);
});
