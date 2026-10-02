import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "unbash";
import { scan } from "./walk.ts";

// Names (or "" for a bare assignment) with the assignment names each carries.
function assigned(command: string): [string, readonly string[]][] {
	const result = scan(parse, command);
	assert.equal(result.kind, "ok");
	if (result.kind !== "ok") return [];
	return result.invocations.map((i) => [i.name, i.assignments]);
}

test("a prefix names the variables it sets", () => {
	assert.deepEqual(assigned("FOO=1 BAR=2 ls"), [["ls", ["FOO", "BAR"]]]);
});

test("a bare assignment is an invocation with an empty name", () => {
	assert.deepEqual(assigned("FOO=1"), [["", ["FOO"]]]);
});

test("a command with no prefix has none", () => {
	assert.deepEqual(assigned("echo a=b"), [["echo", []]]);
});

test("a peeled command carries the wrapper's prefix", () => {
	assert.deepEqual(assigned("FOO=1 nohup pi"), [
		["nohup", ["FOO"]],
		["pi", ["FOO"]],
	]);
	assert.deepEqual(assigned("FOO=1 env -S 'pi -p hi'").at(-1), ["pi", ["FOO"]]);
});

test("inside sh -c the inner prefix is seen", () => {
	assert.deepEqual(assigned("sh -c 'FOO=1 pi'"), [
		["sh", []],
		["pi", ["FOO"]],
	]);
});
