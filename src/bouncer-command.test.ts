import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	type LoadedGate,
	loadGateSession,
	type Notice,
	tempProjectDir,
	uiContext,
} from "../test/harness.ts";
import { SCHEMA_URL } from "./commands.ts";

async function run(gate: LoadedGate, args: string): Promise<Notice[]> {
	const { ctx, notices } = uiContext(tempProjectDir());
	await gate.runCommand("bouncer", args, ctx);
	return notices;
}

async function started(config?: unknown): Promise<LoadedGate> {
	const gate = await loadGateSession();
	if (config !== undefined) gate.writeRouteConfig(config);
	await gate.startSession("startup");
	return gate;
}

async function text(gate: LoadedGate, args: string): Promise<string> {
	const notices = await run(gate, args);
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.level, "info");
	return notices[0]?.message ?? "";
}

test("/bouncer reports the mode, files, levels, log and auto mode", async () => {
	const gate = await started({ levels: { "recursive-rm": "deny" } });
	const status = await text(gate, "");
	assert.equal(await text(gate, "status"), status);
	const lines = status.split("\n");
	assert.equal(lines[0], "Bouncer mode: normal");
	assert.equal(lines[1], "Parser: loaded");
	assert.ok(
		lines.includes(`- ${join(gate.agentDir, "bouncer.json")} (loaded)`),
	);
	assert.ok(lines.includes("Project: trusted"));
	const deny = lines.find((line) => line.startsWith("Deny: "));
	assert.match(deny ?? "", /recursive-rm/);
	assert.ok(lines.includes(`Log: ${join(gate.logDir, "log.jsonl")}`));
	assert.ok(
		lines.includes(
			"Auto mode: no judge list (auto.models), so it cannot turn on",
		),
	);
});

test("/bouncer status names YOLO mode and a missing parser", async () => {
	const gate = await loadGateSession(() => Promise.reject(new Error("gone")));
	await gate.startSession("startup");
	await gate.runCommand("yolo", "on", uiContext().ctx);
	const lines = (await text(gate, "status")).split("\n");
	assert.equal(lines[0], "Bouncer mode: YOLO");
	assert.equal(lines[1], "Parser: missing, so every bash command is denied");
});

test("/bouncer rules lists every entry with its level and summary", async () => {
	const gate = await started({ levels: { "git-clean": "deny" } });
	const lines = (await text(gate, "rules")).split("\n");
	assert.equal(lines.length, 25);
	assert.ok(
		lines.includes("unparseable (deny): the command is not valid bash"),
	);
	assert.ok(
		lines.includes(
			"git-clean (deny): git clean deletes untracked files for good",
		),
	);
	assert.match(lines.at(-1) ?? "", /^grep \(deny\): .*rg/);
});

test("/bouncer explain replays a command under the session's config", async () => {
	const gate = await started({ levels: { "recursive-rm": "deny" } });
	const lines = (await text(gate, "explain rm -rf  dist")).split("\n");
	assert.equal(lines[0], "recursive-rm (deny): rm -rf  dist");
	assert.ok(lines.includes("with a UI: deny (recursive-rm)"));
	assert.ok(lines.includes("trust: trusted (this session)"));
});

test("/bouncer init writes the user config once", async () => {
	const gate = await started();
	const path = join(gate.agentDir, "bouncer.json");
	assert.equal(
		await text(gate, "init"),
		`Wrote ${path}. Your editor completes its keys from the schema; changes apply at the next session start or /reload.`,
	);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		$schema: SCHEMA_URL,
		levels: {},
	});
	gate.writeRouteConfig({ levels: { power: "ask" } });
	assert.equal(
		await text(gate, "init"),
		`${path} already exists; left as it is.`,
	);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		levels: { power: "ask" },
	});
});

test("/bouncer check re-reads the config without applying it", async () => {
	const gate = await started();
	assert.equal(
		(await text(gate, "check")).split("\n")[0],
		"No config problems.",
	);
	gate.writeRouteConfig({ levels: { nope: "ask" }, startMode: "yolo" });
	const lines = (await text(gate, "check")).split("\n");
	assert.equal(lines[0], "Config problems; these parts would be ignored:");
	assert.ok(lines.includes('  - levels: unknown rule "nope"'));
	assert.match(await text(gate, "status"), /\(absent\)/);
});

test("/bouncer with an unknown subcommand shows its usage", async () => {
	const gate = await started();
	for (const args of ["frobnicate", "explain", "explain   "]) {
		assert.deepEqual(await run(gate, args), [
			{
				message: "Usage: /bouncer [status|rules|explain <command>|init|check]",
				level: "warning",
			},
		]);
	}
});
