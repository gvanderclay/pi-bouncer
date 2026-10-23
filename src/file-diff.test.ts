// The detail a file call's dialog shows: the diff, or nothing for a read.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempProjectDir } from "../test/harness.ts";
import type { FileAccess, FileChange, FileTool } from "./file-call.ts";
import { fileDiff } from "./file-diff.ts";

function dir(): string {
	const path = tempProjectDir();
	mkdirSync(path, { recursive: true });
	return path;
}

function access(
	change: FileChange | undefined,
	tool: FileTool = "write",
): FileAccess {
	return {
		tool,
		direction: tool === "read" ? "read" : "write",
		path: "/somewhere",
		search: false,
		...(change && { change }),
	};
}

function write(content: string): FileAccess {
	return access({ kind: "write", content });
}

test("an edit's detail shows the changed lines of each entry", () => {
	const diff = fileDiff(
		access(
			{
				kind: "edit",
				edits: [{ oldText: "keep\nold\ntail", newText: "keep\nnew\ntail" }],
			},
			"edit",
		),
		"/nowhere",
	);
	assert.equal(diff, "-old\n+new");
});

test("a write to an existing file diffs against what is there", () => {
	const path = join(dir(), "notes.txt");
	writeFileSync(path, "keep\nold\ntail\n");
	assert.equal(fileDiff(write("keep\nnew\ntail\n"), path), "-old\n+new");
});

test("a write to a new file says so and shows its first 20 lines", () => {
	const content = Array.from({ length: 25 }, (_, at) => `line ${at + 1}`).join(
		"\n",
	);
	const diff = fileDiff(write(content), join(dir(), "not-yet.txt"));
	assert.match(diff, /^new file\nline 1\n/);
	assert.ok(diff.includes("line 20"));
	assert.ok(!diff.includes("line 21"));
});

test("the detail is cut to 2,000 characters", () => {
	const diff = fileDiff(write("x".repeat(5000)), join(dir(), "not-yet.txt"));
	assert.equal(diff.length, 2001);
	assert.match(diff, /…$/);
});

test("a read has no detail", () => {
	assert.equal(fileDiff(access(undefined, "read"), "/nowhere"), "");
});
