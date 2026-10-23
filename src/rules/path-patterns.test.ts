// The gitignore-style globs path rules are written in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePattern } from "./path-patterns.ts";

const W = { cwd: "/p", home: "/h", agentDir: "/h/.pi/agent" };

// Each row is a pattern reaching a path it must not, or missing one it must.
const cases: [string, string, boolean][] = [
	["~/.ssh/**", "/h/.ssh/id_rsa", true],
	["~/.ssh/**", "/h/.sshx/id_rsa", false],
	["~/.ssh/**", "/h/.ssh", true],
	["~/.ssh/**", "/other/.ssh/id_rsa", false],
	["*.pem", "/a/b/c/key.pem", true],
	["*.pem", "/a/key.pem/x", false],
	["docs/*", "/p/docs/a.md", true],
	["docs/*", "/p/docs/a/b.md", false],
	["docs/*", "/q/docs/a.md", false],
	["docs/**", "/p/docs/a/b.md", true],
	["/etc/**", "/etc/hosts", true],
	["/etc/**", "/etcx/hosts", false],
	["**/.git/**", "/p/a/.git/hooks/pre-commit", true],
	["**/.git/**", "/p/a/.github/x", false],
	["**/.git/**", "/elsewhere/repo/.git/config", true],
	["**/.git/**", "/p/.git/config", true],
	["**/.git/**", "/.git/config", true],
	["**/.git/**", "/elsewhere/repo/.gitx/config", false],
	["id_rsa*", "/h/backup/id_rsa.old", true],
	["a.b", "/p/aXb", false],
	// A file name may hold a newline; every wildcard but `/` must cross it.
	["~/.ssh/**", "/h/.ssh/key\nprivate", true],
	["**/.git/**", "/r\n/.git/config", true],
	["docs/**", "/p/docs/a\n/b.md", true],
	["*.pem", "/a/k\ney.pem", true],
	["id_rsa?x", "/h/id_rsa\nx", true],
	["docs/*", "/p/docs/a\nb", true],
];
for (const [pattern, path, want] of cases) {
	test(`${pattern} ${want ? "matches" : "doesn't match"} ${path}`, () => {
		assert.equal(compilePattern(pattern)?.test(path, W), want);
	});
}

test("a ! pattern or an empty one doesn't compile", () => {
	assert.equal(compilePattern("!*.env"), undefined);
	assert.equal(compilePattern(""), undefined);
});

test("an anchored pattern's base is its folders before the first wildcard", () => {
	assert.equal(compilePattern("~/.ssh/**")?.base?.(W), "/h/.ssh");
	assert.equal(compilePattern("/etc/**")?.base?.(W), "/etc");
	assert.equal(compilePattern("docs/*/x")?.base?.(W), "/p/docs");
	assert.equal(compilePattern("*.pem")?.base, undefined);
	assert.equal(compilePattern("**/.git/**")?.base, undefined);
});
