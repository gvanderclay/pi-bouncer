import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	bashCall,
	expectDeny,
	fakeContext,
	loadGate,
	loadGateSession,
	scriptedUI,
	tempProjectDir,
	uiContext,
	writeProjectConfig,
} from "../../test/harness.ts";

const HOME = homedir();

const denied = [
	"rm -rf /",
	"rm -rf /*",
	"rm -rf //",
	"rm -rf --no-preserve-root /x",
	"rm -r --no-preserve-root build",
	"rm -rf -- /",
	"rm -rf ~",
	"rm -rf ~/",
	"rm -rf ~/*",
	"rm -rf $HOME",
	"rm -rf ${HOME}",
	'rm -rf "$HOME"',
	'rm -rf "$HOME/"',
	`rm -rf ${HOME}`,
	`rm -rf ${HOME}/`,
	`rm -rf ${HOME}/*`,
	"rm -rf /usr",
	"rm -rf /usr/",
	"rm -rf /usr/*",
	"rm -rf /usr/local",
	"rm -rf /etc/ssh",
	"rm -rf /bin",
	"rm -rf /sbin",
	"rm -rf /var",
	"rm -rf /var/log",
	"rm -rf /opt",
	"rm -rf /System",
	"rm -rf /Library",
	"rm -rf /Applications",
	"rm -rf /Applications/Safari.app",
	"rm -rf /Users",
	"rm -rf /Users/someone",
	"rm -rf /private",
	"rm -rf /private/tmp",
	"rm -rf /usr/local/..",
	"rm -rf /home",
	"rm -rf /home/someone",
	"rm -rf /root",
	"rm -rf /boot",
	"rm -rf /lib",
	"rm -rf /lib64",
	"rm -rf /srv",
	"rm -rf /srv/www",
	"rm -rf /dev",
	"rm -rf /proc",
	"rm -rf /sys",
	"rm -rf /snap",
	"rm -rf /nix",
	"rm -rf /nix/store",
	"rm -rf ~/Desktop",
	"rm -rf ~/Documents",
	"rm -rf ~/Documents/",
	"rm -rf ~/Documents/*",
	"rm -rf ~/Downloads",
	"rm -rf ~/Pictures",
	"rm -rf ~/Movies",
	"rm -rf ~/Music",
	"rm -rf ~/Library",
	"rm -rf ~/Applications",
	"rm -rf ~/workspace",
	"rm -rf ~/.config",
	"rm -rf ~/.local",
	"rm -rf ~/pi",
	"rm -rf ~/.pi",
	"rm -rf ~/.ssh",
	"rm -rf ~/.gnupg",
	"rm -rf ~/.aws",
	"rm -rf ~/.kube",
	"rm -rf ~/.docker",
	"rm -rf $HOME/.ssh",
	`rm -rf ${HOME}/Documents`,
	"rm -rf build ~/.ssh",
	"grm -rf ~",
	"rm --recursive ~",
	"rm ~ -r",
];

for (const command of denied) {
	test(`deny rm-root: ${command}`, () =>
		expectDeny(command, "rm-root", command));
}

// A wrapper or chain quotes the whole command: expectDeny checks the quote
// is part of it.
const inside = [
	"env X=1 rm -rf ~",
	"time rm -rf /",
	"sh -c 'rm -rf /usr'",
	"cd /tmp && rm -rf ~/Documents",
	"rm -rf dist; rm -rf ~",
	"echo $(rm -rf ~)",
];

for (const command of inside) {
	test(`deny rm-root inside a wrapper or chain: ${command}`, () =>
		expectDeny(command, "rm-root"));
}

const stillRecursiveRm = [
	"rm -rf .",
	"rm -rf *",
	"rm -rf ./*",
	"rm -rf dist",
	"rm -rf ~/tmp",
	"rm -rf ~/.cargo",
	"rm -rf ~/.npm",
	"rm -rf /usr/local/lib",
	"rm -rf ~/workspace/project",
	"rm -rf ~/Documents/old",
	"rm -rf /tmp/x",
	"rm -rf /home/someone/project",
	"rm -rf /srv/www/cache",
	"rm -rf ~other",
];

for (const command of stillRecursiveRm) {
	test(`still recursive-rm: ${command}`, () =>
		expectDeny(command, "recursive-rm", command));
}

test("rm without a recursive flag is not rm-root", async () => {
	const handler = await loadGate();
	assert.equal(await handler(bashCall("rm ~/.ssh"), fakeContext()), undefined);
	assert.equal(await handler(bashCall("rm -f /"), fakeContext()), undefined);
});

async function deniedRuleFrom(cwd: string, command: string): Promise<string> {
	const handler = await loadGate();
	const result = await handler(bashCall(command), fakeContext(cwd));
	return /\(rule: ([a-z-]+)\)/.exec(result?.reason ?? "")?.[1] ?? "allowed";
}

const relative: readonly (readonly [
	cwd: string,
	command: string,
	rule: string,
])[] = [
	[join(HOME, "workspace"), "rm -rf ..", "rm-root"],
	[join(HOME, "workspace"), "rm -rf ../", "rm-root"],
	[join(HOME, "workspace"), "rm -rf ../*", "rm-root"],
	[join(HOME, "workspace"), "rm -rf ../.ssh", "rm-root"],
	[join(HOME, "workspace", "repo"), "rm -rf .", "recursive-rm"],
	[join(HOME, "workspace", "repo"), "rm -rf ..", "rm-root"],
	[join(HOME, "workspace", "repo"), "rm -rf ../other", "recursive-rm"],
	[HOME, "rm -rf Documents", "rm-root"],
	[HOME, "rm -rf .", "rm-root"],
	[HOME, "rm -rf *", "rm-root"],
	[HOME, "rm -rf tmp", "recursive-rm"],
	["/", "rm -rf usr", "rm-root"],
	["/usr/local", "rm -rf lib", "recursive-rm"],
	["/usr/local", "rm -rf ../..", "rm-root"],
];

for (const [cwd, command, rule] of relative) {
	test(`from ${cwd}, ${command} is ${rule}`, async () => {
		assert.equal(await deniedRuleFrom(cwd, command), rule);
	});
}

for (const command of ["rm -rf ~ && rm -rf dist", "rm -rf dist && rm -rf ~"]) {
	test(`rm-root beside an ask denies without a dialog: ${command}`, async () => {
		const handler = await loadGate();
		const { ctx, dialogs, notices } = scriptedUI();
		const result = await handler(bashCall(command), ctx);
		assert.equal(dialogs.length, 0);
		assert.equal(result?.block, true);
		assert.ok(
			result?.reason?.includes("(rule: rm-root)"),
			String(result?.reason),
		);
		assert.ok(result?.reason?.includes("Command: `rm -rf ~`."));
		assert.deepEqual(notices, [
			{ message: "Bouncer denied rm-root: rm -rf ~", level: "warning" },
		]);
	});
}

test("rm-root wins over recursive-rm with a UI: a warning and no dialog", async () => {
	const handler = await loadGate();
	const { ctx, dialogs, notices } = scriptedUI();
	const result = await handler(bashCall("rm -rf ~"), ctx);
	assert.equal(dialogs.length, 0);
	assert.equal(
		result?.reason,
		"Blocked by the user's bouncer (rule: rm-root): recursive rm of a protected path (the filesystem root, a system directory, your home directory, or a path the user's config protects). Command: `rm -rf ~`. None of the command ran. Do not retry this action through another command, script, or tool. Tell the user what was blocked and why, and let them decide.",
	);
	assert.deepEqual(notices, [
		{ message: "Bouncer denied rm-root: rm -rf ~", level: "warning" },
	]);
});

test("a route config lowering rm-root to ask opens a dialog naming it", async () => {
	const { handler, startSession, writeRouteConfig } = await loadGateSession();
	writeRouteConfig({ levels: { "rm-root": "ask" } });
	await startSession("startup");
	const { ctx, dialogs } = scriptedUI(["Deny"]);
	const result = await handler(bashCall("rm -rf ~"), ctx);
	assert.equal(result?.block, true);
	assert.equal(dialogs.length, 1);
	assert.ok(
		dialogs[0]?.title.includes("(rule: rm-root)"),
		String(dialogs[0]?.title),
	);
});

test("protect adds home folders and paths to rm-root, from either config file", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({ protect: { home: ["code", "notes/"] } });
	const cwd = tempProjectDir();
	writeProjectConfig(cwd, { protect: { paths: ["/data/"] } });
	// Adding is stricter, so an untrusted project's additions apply.
	const ui = uiContext(cwd, false);
	await gate.startSession("startup", ui.ctx);
	assert.deepEqual(ui.notices, []);
	const ruleOf = async (command: string): Promise<string> => {
		const result = await gate.handler(
			bashCall(command),
			scriptedUI(["Deny"], cwd).ctx,
		);
		return /\(rule: ([a-z-]+)\)/.exec(result?.reason ?? "")?.[1] ?? "";
	};
	assert.equal(await ruleOf("rm -rf ~/code"), "rm-root");
	assert.equal(await ruleOf("rm -rf ~/notes"), "rm-root");
	assert.equal(await ruleOf("rm -rf /data"), "rm-root");
	assert.equal(await ruleOf("rm -rf /data/sets"), "rm-root");
	assert.equal(await ruleOf("rm -rf ~/code/old"), "recursive-rm");
	assert.equal(await ruleOf("rm -rf /data/sets/old"), "recursive-rm");
	// The built-in paths stay.
	assert.equal(await ruleOf("rm -rf ~/.ssh"), "rm-root");
});

test("protect entries that are not paths are problems; the rest apply", async () => {
	const gate = await loadGateSession();
	gate.writeRouteConfig({
		protect: {
			home: ["/abs", "../up", "~/x", "", "ok"],
			paths: ["rel", 1],
			x: [],
		},
	});
	const ui = uiContext();
	await gate.startSession("startup", ui.ctx);
	const message = ui.notices[0]?.message ?? "";
	for (const problem of [
		'"protect.home" entry "/abs" must be a path below the home directory',
		'"protect.home" entry "../up" must be',
		'"protect.home" entry "~/x" must be',
		'"protect.home" entry "" must be',
		'"protect.paths" entry "rel" must be an absolute path',
		'"protect.paths" entry 1 must be an absolute path',
		'"protect": unknown key "x"',
	]) {
		assert.ok(message.includes(problem), `${problem}\n${message}`);
	}
	const result = await gate.handler(bashCall("rm -rf ~/ok"), scriptedUI().ctx);
	assert.match(result?.reason ?? "", /\(rule: rm-root\)/);
});
