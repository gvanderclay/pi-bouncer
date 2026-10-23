// A file tool's input read into a file access: the tool, its direction, the
// path as typed and, for write and edit, the change. The input comes from the
// model, so anything unusable blocks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type FileAccess, type FileTool, readFileCall } from "./file-call.ts";
import type { Verdict } from "./verdict.ts";

function access(tool: FileTool, input: unknown): FileAccess {
	const read = readFileCall(tool, input);
	if (read.kind !== "ok") {
		assert.fail(`${tool} read as unreadable: ${read.verdict.reason}`);
	}
	return read.access;
}

function unreadable(tool: FileTool, input: unknown): Verdict {
	const read = readFileCall(tool, input);
	if (read.kind !== "unreadable") {
		assert.fail(`${tool} read as ${JSON.stringify(read.access)}`);
	}
	return read.verdict;
}

test("a read is a read of the path as typed, with no change", () => {
	assert.deepEqual(access("read", { path: "~/notes.txt", offset: 2 }), {
		tool: "read",
		direction: "read",
		path: "~/notes.txt",
		search: false,
	});
});

test("write and edit are writes and carry their change", () => {
	assert.deepEqual(access("write", { path: "a.txt", content: "hi\n" }), {
		tool: "write",
		direction: "write",
		path: "a.txt",
		search: false,
		change: { kind: "write", content: "hi\n" },
	});
	assert.deepEqual(
		access("edit", {
			path: "a.txt",
			edits: [{ oldText: "old", newText: "new" }],
		}),
		{
			tool: "edit",
			direction: "write",
			path: "a.txt",
			search: false,
			change: { kind: "edit", edits: [{ oldText: "old", newText: "new" }] },
		},
	);
});

test("an edit's top-level oldText and newText pair is a change too, after the listed edits", () => {
	// Pi turns a single oldText/newText pair into this shape before the tool
	// call reaches the bouncer (`prepareEditArguments`).
	const pairs = (input: unknown): readonly (readonly string[])[] => {
		const { change } = access("edit", input);
		assert.equal(change?.kind, "edit");
		if (change?.kind !== "edit") throw new Error("unreachable");
		return change.edits.map(({ oldText, newText }) => [oldText, newText]);
	};
	assert.deepEqual(
		pairs({ path: "a.txt", oldText: "top", newText: "bottom" }),
		[["top", "bottom"]],
	);
	assert.deepEqual(
		pairs({
			path: "a.txt",
			edits: [{ oldText: "old", newText: "new" }],
			oldText: "top",
			newText: "bottom",
		}),
		[
			["old", "new"],
			["top", "bottom"],
		],
	);
});

test("grep, find and ls search, and no path means the working directory", () => {
	for (const tool of ["grep", "find", "ls"] as const) {
		const searched = access(tool, { pattern: "token" });
		assert.equal(searched.direction, "read", tool);
		assert.equal(searched.search, true, tool);
		assert.equal(searched.path, ".", tool);
	}
});

test("a missing path on read, write or edit is unreadable", () => {
	for (const tool of ["read", "write", "edit"] as const) {
		const verdict = unreadable(tool, { content: "x" });
		assert.equal(verdict.level, "deny", tool);
		assert.equal(verdict.rule, "unparseable", tool);
		assert.match(verdict.reason, new RegExp(`the ${tool} tool`), tool);
		assert.equal(verdict.command, tool);
	}
});

test("an input that is not an object, or a path that is not a string, is unreadable", () => {
	const plain = unreadable("read", "~/notes.txt");
	assert.equal(plain.rule, "unparseable");
	assert.match(plain.reason, /none of the call ran/i);
	const nul = unreadable("read", null);
	assert.match(nul.reason, /Input: `null`/);
	const numbered = unreadable("grep", { path: 7 });
	assert.match(numbered.reason, /"path":7/);
	const listed = unreadable("ls", ["~/projects"]);
	assert.equal(listed.command, "ls");
});
