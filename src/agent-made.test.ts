// A recursive rm of a directory the agent made this session runs without an
// ask, in every mode and with no UI; everything that only looks like one
// still asks (and so, here with no UI, blocks).
import assert from "node:assert/strict";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
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
	scriptedUI,
	tempLogDir,
	tempProjectDir,
	writeProjectConfig,
} from "../test/harness.ts";
import { AGENT_MADE_NOTE, copyTarget, mkdirTargets } from "./agent-made.ts";
import { AGENT_MADE_HINT } from "./gate.ts";
import { recursiveRm } from "./rules/filesystem.ts";

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
	cwd = "/work",
): Promise<{ block?: boolean; reason?: string } | undefined> {
	// One context for the call and its result, as Pi gives both.
	const ctx = fakeContext(cwd);
	await gate.endMessage(assistant(["t1"]));
	const decision = await gate.handler(bashCall(command), ctx);
	if (decision?.block) return decision;
	act();
	await gate.finishTool(bashResult(command, result), ctx);
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

async function asks(
	gate: LoadedGate,
	command: string,
	cwd = "/work",
): Promise<string> {
	const result = await run(gate, command, () => {}, {}, cwd);
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
	assert.ok((await asks(gate, "rm -rf build")).includes(AGENT_MADE_HINT));
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

test("each run tells the agent how to delete what it made, while trusted and bash is on", async () => {
	const gate = await session();
	assert.deepEqual(await gate.startAgent(), { bouncer: AGENT_MADE_NOTE });
	assert.deepEqual(await gate.startAgent(["read"]), {});
	const off = await session({ trustAgentMade: false });
	assert.deepEqual(await off.startAgent(), {});
});

// Relative paths and copies. Each case runs in its own fresh directory, with
// one context for the call and its result.

const OLD = new Date("2020-01-01");

async function makes(
	gate: LoadedGate,
	cwd: string,
	command: string,
	path: string,
): Promise<void> {
	const act = (): void => {
		mkdirSync(join(cwd, path), { recursive: true });
	};
	await run(gate, command, act, {}, cwd);
}

async function runs(
	gate: LoadedGate,
	command: string,
	cwd: string,
): Promise<void> {
	const result = await run(gate, command, () => {}, {}, cwd);
	assert.equal(
		result,
		undefined,
		`expected ${command} to run: ${result?.reason}`,
	);
}

const relativePairs: readonly (readonly [string, string, string])[] = [
	["mkdir scratch", "rm -rf scratch", "scratch"],
	["mkdir ./dot", "rm -rf ./dot", "dot"],
	["mkdir slash/", "rm -rf slash/", "slash"],
	["mkdir ./both/", "rm -r ./both", "both"],
	["mkdir -p nest/a/b", "rm -rf nest", "nest/a/b"],
	["mkdir 'my dir'", "rm -rf 'my dir'", "my dir"],
	['mkdir "my other dir"', 'rm -rf "my other dir"', "my other dir"],
	["mkdir -- ./-scratch", "rm -rf -- ./-scratch", "-scratch"],
];

for (const [create, remove, path] of relativePairs) {
	test(`${create}, then ${remove} in a later call, runs`, async () => {
		const gate = await session();
		const cwd = parent();
		await makes(gate, cwd, create, path);
		writeFileSync(join(cwd, path, "file"), "x");
		await runs(gate, remove, cwd);
	});
}

test("mkdir -p counts only the highest folder it made, with relative paths", async () => {
	const gate = await session();
	const cwd = parent();
	mkdirSync(join(cwd, "pre"));
	await makes(gate, cwd, "mkdir -p pre/new/deep", "pre/new/deep");
	await runs(gate, "rm -rf pre/new", cwd);
	await asks(gate, "rm -rf pre", cwd);
});

test("one rm of several owned folders, relative and absolute, runs", async () => {
	const gate = await session();
	const cwd = parent();
	await makes(gate, cwd, "mkdir one", "one");
	const abs = await made(gate);
	await runs(gate, `rm -rf one ${abs}`, cwd);
	await runs(gate, `rm -rf -- ./one '${abs}'`, cwd);
	await asks(gate, `rm -rf one ${parent()}`, cwd);
});

test("/tmp and /private/tmp name the same folder", {
	skip: !existsSync("/private/tmp"),
}, async () => {
	const gate = await session();
	const cwd = mkdtempSync(join("/tmp", "agent-made-"));
	await makes(gate, cwd, "mkdir scratch", "scratch");
	const alias = cwd.replace(/^\/tmp/, "/private/tmp");
	await runs(gate, `rm -rf ${alias}/scratch`, "/work");
	await runs(gate, "rm -rf scratch", alias);
});

const relativeStillAsks: readonly (readonly [string, string])[] = [
	["a cd", "cd {cwd} && rm -rf scratch"],
	["an assignment", "FOO=1 rm -rf scratch"],
	["a wrapper", "timeout 5 rm -rf scratch"],
	["a command word wrapper", "command rm -rf scratch"],
	["a bash -c", "bash -c 'rm -rf scratch'"],
	["a substitution", "rm -rf scratch $(echo)"],
	["a variable", "rm -rf $D"],
	["a redirect", "rm -rf scratch > /dev/null"],
	["a pipeline", "echo x | rm -rf scratch"],
	["a second command", "rm -rf scratch; true"],
	["a conditional", "true && rm -rf scratch"],
	["background execution", "rm -rf scratch &"],
	["a negation", "! rm -rf scratch"],
	["a function body", "f() { rm -rf scratch; }; f"],
	["control flow", "if true; then rm -rf scratch; fi"],
	["a .. segment", "rm -rf ../scratch"],
	["a nested .. segment", "rm -rf ./a/../scratch"],
	["a home path", "rm -rf ~/scratch"],
	["a glob", "rm -rf scra*"],
	["a brace", "rm -rf {scratch,x}"],
	["an escape", "rm -rf scr\\atch"],
	["an ANSI-C string", "rm -rf $'scratch'"],
];

for (const [label, template] of relativeStillAsks) {
	test(`a relative rm with ${label} still asks`, async () => {
		const gate = await session();
		const cwd = parent();
		await makes(gate, cwd, "mkdir scratch", "scratch");
		await asks(gate, template.replace("{cwd}", cwd), cwd);
	});
}

test("a relative rm asks in another directory, or when the working directory is unknown", async () => {
	const gate = await session();
	const cwd = parent();
	await makes(gate, cwd, "mkdir scratch", "scratch");
	mkdirSync(join(cwd, "scratch", "scratch"));
	await asks(gate, "rm -rf scratch", parent());
	await asks(gate, "rm -rf scratch", "");
	await asks(gate, "rm -rf scratch", "relative");
});

test("a relative mkdir that is not standalone, or an existing folder, proves nothing", async () => {
	const gate = await session();
	const cwd = parent();
	const cases = [
		"cd . && mkdir a",
		"mkdir b && true",
		"mkdir c &",
		"mkdir d || true",
		"! mkdir e",
		"mkdir f > /dev/null",
		"timeout 5 mkdir g",
		"mkdir ../h",
	];
	for (const command of cases) {
		const name = command.replace(/^.*mkdir (\.\.\/)?/, "").slice(0, 1);
		await makes(gate, cwd, command, name);
		await asks(gate, `rm -rf ${name}`, cwd);
	}
	mkdirSync(join(cwd, "there"));
	await run(gate, "mkdir there", () => {}, {}, cwd);
	await asks(gate, "rm -rf there", cwd);
});

test("a failed, detached or shell-background mkdir proves nothing", async () => {
	const gate = await session();
	const cwd = parent();
	const act = (name: string) => (): void => mkdirSync(join(cwd, name));
	await run(gate, "mkdir failed", act("failed"), { isError: true }, cwd);
	await asks(gate, "rm -rf failed", cwd);
	await run(gate, "mkdir bg", act("bg"), { background: true }, cwd);
	await asks(gate, "rm -rf bg", cwd);
});

function sourceTree(cwd: string, name = "src"): string {
	const src = join(cwd, name);
	mkdirSync(join(src, "sub"), { recursive: true });
	for (const file of [join(src, "a"), join(src, "sub", "b")]) {
		writeFileSync(file, "x");
		utimesSync(file, OLD, OLD);
	}
	return src;
}

function copying(cwd: string, from: string, to: string): () => void {
	return () => cpSync(join(cwd, from), join(cwd, to), { recursive: true });
}

const copies: readonly (readonly [string, string])[] = [
	["cp -r src c1", "c1"],
	["cp -R src c2", "c2"],
	["cp --recursive src c3", "c3"],
	["cp -r -- src c4", "c4"],
	["gcp -r src c5", "c5"],
	["cp -r ./src ./c6", "c6"],
	["cp -r src/ c7/", "c7"],
	["cp -r 'src' 'c8'", "c8"],
	["cp -r -R src c9", "c9"],
];

for (const [command, dest] of copies) {
	test(`${command} into a folder that was absent makes it the agent's`, async () => {
		const gate = await session();
		const cwd = parent();
		sourceTree(cwd);
		await run(gate, command, copying(cwd, "src", dest), {}, cwd);
		await runs(gate, `rm -rf ${dest}`, cwd);
		await runs(gate, `rm -rf ${dest}/sub`, cwd);
	});
}

test("an absolute recursive copy counts too", async () => {
	const gate = await session();
	const cwd = parent();
	const src = sourceTree(cwd);
	const dest = join(cwd, "abs");
	const act = (): void => cpSync(src, dest, { recursive: true });
	await run(gate, `cp -r ${src} ${dest}`, act, {}, "/work");
	await runs(gate, `rm -rf ${dest}`, "/work");
});

const copyProves: readonly (readonly [string, string])[] = [
	["a failed copy", "cp -r src d"],
	["a detached copy", "cp -r src d"],
	["a shell-background copy", "cp -r src d &"],
	["a conditional copy", "true && cp -r src d"],
	["a masked copy", "cp -r src d || true"],
	["a copy before true", "cp -r src d; true"],
	["a negated copy", "! cp -r src d"],
	["a copy chain", "cp -r src d && cp -r src e"],
	["a copy with a redirect", "cp -r src d 2> /dev/null"],
	["a copy in a subshell", "(cp -r src d)"],
	["a wrapped copy", "timeout 5 cp -r src d"],
	["a copy with several sources", "cp -r src src d"],
	["a copy with one operand", "cp -r src"],
	["a copy without a flag", "cp src d"],
	["a copy with a variable", "cp -r src $D"],
	["a copy with a glob", "cp -r src d*"],
	["a copy to a parent path", "cp -r src ../d"],
	["a copy with -rf", "cp -rf src d"],
	["a copy with -a", "cp -a src d"],
	["a copy with -p", "cp -rp src d"],
	["a copy with --preserve", "cp -r --preserve src d"],
	["a copy with -n", "cp -r -n src d"],
	["a copy with -L", "cp -rL src d"],
	["a copy with --recursive=x", "cp --recursive=x src d"],
	["a copy with --rec", "cp --rec src d"],
];

for (const [label, command] of copyProves) {
	test(`${label} proves nothing`, async () => {
		const gate = await session();
		const cwd = parent();
		sourceTree(cwd);
		const results: Record<string, object> = {
			"a failed copy": { isError: true },
			"a detached copy": { background: true },
		};
		const result = results[label] ?? {};
		await run(gate, command, copying(cwd, "src", "d"), result, cwd);
		await asks(gate, "rm -rf d", cwd);
	});
}

test("a copy into a folder that already existed proves nothing, and neither does anything inside it", async () => {
	const gate = await session();
	const cwd = parent();
	sourceTree(cwd);
	mkdirSync(join(cwd, "d", "earlier"), { recursive: true });
	await run(gate, "cp -r src d", copying(cwd, "src", "d"), {}, cwd);
	await asks(gate, "rm -rf d", cwd);
	await asks(gate, "rm -rf d/earlier", cwd);
	await asks(gate, "rm -rf d/src", cwd);
});

test("a copy onto a dangling symlink proves nothing", async () => {
	const gate = await session();
	const cwd = parent();
	sourceTree(cwd);
	symlinkSync(join(cwd, "nowhere"), join(cwd, "d"));
	const act = (): void => {
		mkdirSync(join(cwd, "nowhere"));
	};
	await run(gate, "cp -r src d", act, {}, cwd);
	await asks(gate, "rm -rf d", cwd);
	await asks(gate, "rm -rf nowhere", cwd);
});

test("a copy of a symlinked source root proves nothing, whatever its trailing spelling", async () => {
	const gate = await session();
	const cwd = parent();
	sourceTree(cwd, "real");
	symlinkSync(join(cwd, "real"), join(cwd, "link"));
	const abs = join(cwd, "link");
	const spellings = [
		"link",
		"link/",
		"link/.",
		"./link/",
		"link//",
		abs,
		`${abs}/`,
		`${abs}/.`,
		`${abs}//`,
	];
	for (const [at, source] of spellings.entries()) {
		const dest = `d${at}`;
		const act = (): void => mkdirSync(join(cwd, dest));
		await run(gate, `cp -r ${source} ${dest}`, act, {}, cwd);
		await asks(gate, `rm -rf ${dest}`, cwd);
	}
});

test("a copy whose operands reach through a symlink and `..` proves nothing", async () => {
	const gate = await session();
	const b = parent();
	mkdirSync(join(b, "lexical", "src"), { recursive: true });
	mkdirSync(join(b, "actual", "sub"), { recursive: true });
	symlinkSync(join(b, "actual", "sub"), join(b, "lexical", "bridge"));
	symlinkSync(join(b, "real"), join(b, "actual", "src"));
	mkdirSync(join(b, "real"));
	const dest = join(b, "dest");
	await run(
		gate,
		`cp -R ${b}/lexical/bridge/../src/ ${dest}`,
		() => mkdirSync(dest),
		{},
		"/work",
	);
	await asks(gate, `rm -rf ${dest}`, "/work");
});

test("a copy of a source that is missing or a file proves nothing", async () => {
	const gate = await session();
	const cwd = parent();
	writeFileSync(join(cwd, "file"), "x");
	for (const [at, source] of ["missing", "file"].entries()) {
		const dest = `d${at}`;
		const act = (): void => mkdirSync(join(cwd, dest));
		await run(gate, `cp -r ${source} ${dest}`, act, {}, cwd);
		await asks(gate, `rm -rf ${dest}`, cwd);
	}
});

test("a copied folder replaced by a symlink afterwards is not the agent's", async () => {
	const gate = await session();
	const cwd = parent();
	sourceTree(cwd);
	await run(gate, "cp -r src d", copying(cwd, "src", "d"), {}, cwd);
	const other = parent();
	rmSync(join(cwd, "d"), { recursive: true });
	symlinkSync(other, join(cwd, "d"));
	await asks(gate, "rm -rf d", cwd);
	await asks(gate, "rm -rf d/", cwd);
});

test("a file moved into a copied folder, or kept with its old date, makes it ask", async () => {
	const gate = await session();
	const cwd = parent();
	sourceTree(cwd);
	await run(gate, "cp -r src moved", copying(cwd, "src", "moved"), {}, cwd);
	const outside = join(parent(), "old");
	writeFileSync(outside, "the user's");
	utimesSync(outside, OLD, OLD);
	renameSync(outside, join(cwd, "moved", "sub", "old"));
	await asks(gate, "rm -rf moved", cwd);
	await asks(gate, "rm -rf moved/sub/old", cwd);
	const kept = copying(cwd, "src", "kept");
	const act = (): void => {
		kept();
		for (const file of ["a", "sub/b"]) {
			utimesSync(join(cwd, "kept", file), OLD, OLD);
		}
	};
	await run(gate, "cp -r src kept", act, {}, cwd);
	await asks(gate, "rm -rf kept", cwd);
});

test("a symlink out of a made relative folder still asks", async () => {
	const gate = await session();
	const cwd = parent();
	await makes(gate, cwd, "mkdir scratch", "scratch");
	symlinkSync(parent(), join(cwd, "scratch", "link"));
	await asks(gate, "rm -rf scratch/link", cwd);
	await asks(gate, "rm -rf scratch/link/", cwd);
});

test("a folder made in one session is not the next session's, relative or not", async () => {
	const gate = await session();
	const cwd = parent();
	await makes(gate, cwd, "mkdir scratch", "scratch");
	sourceTree(cwd);
	await run(gate, "cp -r src d", copying(cwd, "src", "d"), {}, cwd);
	await gate.startSession("new");
	await asks(gate, "rm -rf scratch", cwd);
	await asks(gate, "rm -rf d", cwd);
});

test("rm-root and --no-preserve-root still deny a made relative folder", async () => {
	const gate = await session();
	const cwd = parent();
	await makes(gate, cwd, "mkdir scratch", "scratch");
	const result = await run(
		gate,
		"rm -rf --no-preserve-root scratch",
		() => {},
		{},
		cwd,
	);
	assert.match(result?.reason ?? "", /\(rule: rm-root\)/);
});

test("a protected folder made by the agent is still denied", async () => {
	const gate = await session();
	const cwd = parent();
	const home = join(cwd, "Documents");
	mkdirSync(home);
	await makes(gate, home, "mkdir x", "x");
	const result = await run(gate, "rm -rf /usr", () => {}, {}, cwd);
	assert.match(result?.reason ?? "", /\(rule: rm-root\)/);
});

test('"trustAgentMade": false asks for relative folders and copies too, with no hint', async () => {
	const gate = await session({ trustAgentMade: false });
	const cwd = parent();
	await makes(gate, cwd, "mkdir scratch", "scratch");
	sourceTree(cwd);
	await run(gate, "cp -r src d", copying(cwd, "src", "d"), {}, cwd);
	assert.ok(
		!(await asks(gate, "rm -rf scratch", cwd)).includes(AGENT_MADE_HINT),
	);
	await asks(gate, "rm -rf d", cwd);
});

test("a PATH assignment or wrapper before an absolute rm still asks", async () => {
	const gate = await session();
	const dir = await made(gate);
	await asks(gate, `PATH=${dir}/bin rm -rf ${dir}`);
	await asks(gate, `env X=1 rm -rf ${dir}`);
});

// Diagnostics

type Check = {
	source: string;
	eligible: boolean;
	reason?: string;
	targets: {
		operand: string;
		eligible: boolean;
		reason?: string;
		at?: string;
		path?: string;
	}[];
};

function lastCheck(gate: LoadedGate): Check[] {
	const calls = gate.records().filter((record) => record.type === "call");
	return (calls.at(-1)?.agentMade ?? []) as Check[];
}

test("a failed exemption puts one check per rm, with per-target reasons, in the call record", async () => {
	const gate = await session();
	const cwd = parent();
	await makes(gate, cwd, "mkdir mine", "mine");
	mkdirSync(join(cwd, "theirs"));
	await asks(gate, "rm -rf mine theirs", cwd);
	const [check] = lastCheck(gate);
	assert.equal(check?.source, "rm -rf mine theirs");
	assert.equal(check?.eligible, false);
	assert.equal(check?.reason, "untracked-or-preexisting");
	assert.deepEqual(
		check?.targets.map((t) => [t.operand, t.eligible, t.reason]),
		[
			["mine", true, undefined],
			["theirs", false, "untracked-or-preexisting"],
		],
	);
	assert.equal(check?.targets[0]?.path, realpathSync(join(cwd, "mine")));
});

test("each failure has its stable reason code", async () => {
	const cwd = parent();
	const dir = join(parent(), "made");
	const cases: readonly (readonly [string, string, object?])[] = [
		["rm -rf $D", "expansion"],
		["mv a b; rm -rf x", "compound-command"],
		[`timeout 5 rm -rf ${dir}`, "wrapper"],
		[`PATH=/x rm -rf ${dir}`, "wrapper"],
		[`cd ${cwd} && rm -rf scratch`, "relative-cwd-ambiguous"],
		["rm -rf ../x", "nonliteral-path"],
		["rm -rf *", "nonliteral-path"],
		["rm -rf /nowhere/at/all", "untracked-or-preexisting"],
		[`rm -rf ${cwd}`, "untracked-or-preexisting"],
	];
	for (const [command, reason] of cases) {
		const gate = await session();
		await run(gate, `mkdir ${dir}`, () => mkdirSync(dir, { recursive: true }));
		await makes(gate, cwd, "mkdir scratch", "scratch");
		await asks(gate, command, cwd);
		const [check] = lastCheck(gate);
		const got = check?.reason ?? check?.targets.find((t) => t.reason)?.reason;
		assert.equal(got, reason, command);
	}
});

test("disabled and sibling-call failures are reported", async () => {
	const off = await session({ trustAgentMade: false });
	const dir = await made(off);
	await asks(off, `rm -rf ${dir}`);
	assert.equal(lastCheck(off)[0]?.reason, "disabled");
	const gate = await session();
	const own = await made(gate);
	await gate.endMessage(assistant(["t0", "t1"]));
	await gate.handler(bashCall(`rm -rf ${own}`), fakeContext());
	assert.equal(lastCheck(gate)[0]?.reason, "sibling-tool-calls");
});

test("a sibling call still lists every operand with its early reason", async () => {
	const gate = await session();
	await gate.endMessage(assistant(["t0", "t1"]));
	await gate.handler(bashCall("rm -rf one two"), fakeContext());
	const [check] = lastCheck(gate);
	assert.equal(check?.reason, "sibling-tool-calls");
	assert.deepEqual(
		check?.targets.map((t) => [t.operand, t.eligible, t.reason]),
		[
			["one", false, "sibling-tool-calls"],
			["two", false, "sibling-tool-calls"],
		],
	);
});

test("older contents name the item, and a metadata error fails closed", async () => {
	const gate = await session();
	const dir = await made(gate);
	const old = join(dir, "old");
	writeFileSync(old, "x");
	utimesSync(old, OLD, OLD);
	await asks(gate, `rm -rf ${dir}`);
	const [check] = lastCheck(gate);
	assert.equal(check?.targets[0]?.reason, "older-contents");
	assert.equal(check?.targets[0]?.at, join(realpathSync(dir), "old"));
});

test("an unreadable folder fails closed as filesystem-failure", {
	skip: process.getuid?.() === 0,
}, async () => {
	const gate = await session();
	const dir = await made(gate);
	const locked = join(dir, "locked");
	mkdirSync(locked);
	chmodSync(locked, 0o000);
	try {
		await asks(gate, `rm -rf ${dir}`);
		const [check] = lastCheck(gate);
		assert.equal(check?.targets[0]?.reason, "filesystem-failure");
		assert.equal(check?.targets[0]?.at, join(realpathSync(dir), "locked"));
	} finally {
		chmodSync(locked, 0o700);
	}
});

function fill(dir: string, count: number): void {
	for (let i = 0; i < count; i += 1) writeFileSync(join(dir, `f${i}`), "");
}

test("a tree of exactly 10,000 items runs; one more asks and names an item", async () => {
	const gate = await session();
	const exact = await made(gate);
	fill(exact, 9_999);
	await runs(gate, `rm -rf ${exact}`, "/work");
	const over = await made(gate);
	fill(over, 10_000);
	await asks(gate, `rm -rf ${over}`);
	const [check] = lastCheck(gate);
	assert.equal(check?.targets[0]?.reason, "tree-limit");
	assert.ok(check?.targets[0]?.at?.startsWith(realpathSync(over)));
});

test("the walk budget is shared across one rm's targets, and each reports its own result", async () => {
	const gate = await session();
	const first = await made(gate);
	const second = await made(gate);
	fill(first, 5_999);
	fill(second, 5_999);
	await asks(gate, `rm -rf ${first} ${second}`);
	const [check] = lastCheck(gate);
	assert.deepEqual(
		check?.targets.map((t) => [t.eligible, t.reason]),
		[
			[true, undefined],
			[false, "tree-limit"],
		],
	);
	await runs(gate, `rm -rf ${first}`, "/work");
});

test("the rule reads the check the gate already made, never the filesystem", () => {
	const invocation = {
		name: "rm",
		args: ["-rf", "/nowhere"],
		source: "rm -rf /nowhere",
		assignments: [],
		upstream: [],
		substitutions: [],
	};
	const where = { cwd: "/", home: "/" };
	const check = { source: invocation.source, targets: [] };
	const yes = new Map([[invocation, { ...check, eligible: true }]]);
	const no = new Map([[invocation, { ...check, eligible: false }]]);
	assert.equal(
		recursiveRm.matches(invocation, { ...where, agentMadeChecks: yes }),
		false,
	);
	assert.equal(
		recursiveRm.matches(invocation, { ...where, agentMadeChecks: no }),
		true,
	);
	assert.equal(
		recursiveRm.matches(invocation, { ...where, agentMadeChecks: new Map() }),
		true,
	);
});

test("diagnostics survive a dialog allow, a session allow, auto mode and YOLO", async () => {
	const gate = await session();
	const cwd = parent();
	mkdirSync(join(cwd, "theirs"));
	const once = scriptedUI(["Allow once"], cwd);
	await gate.endMessage(assistant(["t1"]));
	assert.equal(
		await gate.handler(bashCall("rm -rf theirs"), once.ctx),
		undefined,
	);
	assert.equal(lastCheck(gate)[0]?.reason, "untracked-or-preexisting");
	const sess = scriptedUI(["Allow for this session"], cwd);
	await gate.handler(bashCall("rm -rf theirs/"), sess.ctx);
	const again = scriptedUI([], cwd);
	await gate.handler(bashCall("rm -rf theirs/"), again.ctx);
	assert.equal(lastCheck(gate)[0]?.eligible, false);
	gate.mode.mode = "auto";
	const auto = scriptedUI(["Allow once"], cwd);
	await gate.handler(bashCall("rm -rf theirs/x"), auto.ctx);
	assert.equal(lastCheck(gate)[0]?.reason, "untracked-or-preexisting");
	gate.mode.mode = "yolo";
	await gate.handler(bashCall("rm -rf theirs/y"), fakeContext(cwd));
	const calls = gate.records().filter((record) => record.type === "call");
	const last = calls.at(-1);
	assert.equal(last?.yolo, true);
	assert.equal(last?.outcome, "allowed");
	assert.equal(lastCheck(gate)[0]?.reason, "untracked-or-preexisting");
});

test("a silent success and an unrelated call record nothing about the exemption", async () => {
	const gate = await session();
	const dir = await made(gate);
	await runs(gate, `rm -rf ${dir}`, "/work");
	assert.deepEqual(
		gate.records().filter((record) => record.type === "call"),
		[],
	);
	await run(gate, "git reset --hard");
	const [record] = gate.records().filter((record) => record.type === "call");
	assert.equal(record?.outcome, "blocked");
	assert.equal("agentMade" in (record ?? {}), false);
});

test("the note and hint teach separate creation, work and literal cleanup", async () => {
	assert.match(AGENT_MADE_NOTE, /separate calls/);
	assert.match(AGENT_MADE_NOTE, /mktemp -d/);
	assert.match(AGENT_MADE_NOTE, /literal path/);
	assert.ok(AGENT_MADE_HINT.includes(AGENT_MADE_NOTE));
});

test("only ENOENT counts as an absent copy destination", {
	skip: process.getuid?.() === 0,
}, () => {
	const cwd = parent();
	sourceTree(cwd);
	mkdirSync(join(cwd, "locked"));
	const copy = (dest: string): string | undefined =>
		copyTarget(
			{
				name: "cp",
				args: ["-r", "src", dest],
				source: `cp -r src ${dest}`,
				assignments: [],
				upstream: [],
				substitutions: [],
			},
			cwd,
		);
	assert.equal(copy("fresh"), join(cwd, "fresh"));
	chmodSync(join(cwd, "locked"), 0o000);
	try {
		assert.equal(copy("locked/d"), undefined);
	} finally {
		chmodSync(join(cwd, "locked"), 0o700);
	}
});

test("a relative mkdir is never resolved against an unknown or relative working directory", () => {
	const mkdir = {
		name: "mkdir",
		args: ["scratch"],
		source: "mkdir scratch",
		assignments: [],
		upstream: [],
		substitutions: [],
	};
	const cwd = parent();
	assert.deepEqual(mkdirTargets([mkdir], cwd, mkdir), [join(cwd, "scratch")]);
	assert.deepEqual(mkdirTargets([mkdir], cwd, undefined), []);
	assert.deepEqual(mkdirTargets([mkdir], "", mkdir), []);
	assert.deepEqual(mkdirTargets([mkdir], "relative", mkdir), []);
});
