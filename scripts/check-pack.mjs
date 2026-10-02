// Checks the file list `npm pack` would publish: the extension, skills,
// license and built CLIs (run `pnpm build` first) are in it, nothing from
// tests, docs or tooling is, and every relative import in a packed .ts file
// points at another packed file.
// Run from the package root: node scripts/check-pack.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const packed = JSON.parse(
	execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		encoding: "utf8",
	}),
)[0].files.map((file) => file.path);
const files = new Set(packed);

const problems = [];

const REQUIRED = [
	"package.json",
	"README.md",
	"LICENSE",
	"CHANGELOG.md",
	"src/index.ts",
	"src/explain.ts",
	"dist/src/explain.js",
	"dist/skills/auto-judge-list/bench.js",
	"skills/bouncer-debug/SKILL.md",
	"skills/auto-judge-list/SKILL.md",
	"schema/bouncer.schema.json",
	"examples/prefer-rg.json",
];
for (const path of REQUIRED) {
	if (!files.has(path)) problems.push(`missing: ${path}`);
}

const FORBIDDEN = /^(test|docs|scripts|node_modules|\.github)\/|^\.|\.tgz$|\.test\.ts$/;
for (const path of packed) {
	if (FORBIDDEN.test(path)) problems.push(`should not be packed: ${path}`);
}

const IMPORT = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
for (const path of packed.filter((p) => p.endsWith(".ts"))) {
	const source = readFileSync(path, "utf8");
	for (const [, target] of source.matchAll(IMPORT)) {
		const resolved = normalize(join(dirname(path), target));
		if (!files.has(resolved)) {
			problems.push(`${path} imports ${target}, which is not packed`);
		}
	}
}

if (problems.length > 0) {
	console.error(`check-pack: ${problems.length} problem(s)`);
	for (const problem of problems) console.error(`  ${problem}`);
	process.exit(1);
}
console.log(`check-pack: ${packed.length} files, all expected`);
