// Each read gets about a second; a failure reads as "unknown".
import { execFile } from "node:child_process";
import { statSync } from "node:fs";

export type GitState =
	| { readonly kind: "repo"; readonly branch: string; readonly dirty: boolean }
	| { readonly kind: "not-a-repo" }
	| { readonly kind: "unknown" };

export type Remotes = ReadonlyMap<string, string>;

export type RemoteFact = {
	readonly name: string;
	readonly url: string;
	/** Added, or its URL changed, since the session started. */
	readonly changed: boolean;
};

const TIMEOUT_MS = 1000;

type Ran =
	| { readonly ok: true; readonly stdout: string }
	| { readonly ok: false; readonly stderr: string };

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

// A spawn into a missing directory fails slowly, so it is never tried.
function runGit(cwd: string, args: readonly string[]): Promise<Ran> {
	if (!isDirectory(cwd)) {
		return Promise.resolve({ ok: false, stderr: "no such directory" });
	}
	return new Promise((resolve) => {
		execFile(
			"git",
			[...args],
			{ cwd, timeout: TIMEOUT_MS, encoding: "utf8" },
			(error, stdout, stderr) => {
				resolve(
					error ? { ok: false, stderr: String(stderr) } : { ok: true, stdout },
				);
			},
		);
	});
}

// `## feature...origin/feature [ahead 1]`, `## No commits yet on main`,
// `## HEAD (no branch)`.
function branchOf(header: string): string {
	const name = header.replace(/^## /, "").replace(/^No commits yet on /, "");
	return name.split("...")[0]?.split(" ")[0] || "unknown";
}

export async function readGitState(cwd: string): Promise<GitState> {
	const ran = await runGit(cwd, ["status", "--porcelain=v1", "--branch"]);
	if (!ran.ok) {
		return /not a git repository/i.test(ran.stderr)
			? { kind: "not-a-repo" }
			: { kind: "unknown" };
	}
	const [header = "", ...changes] = ran.stdout.split("\n").filter(Boolean);
	return { kind: "repo", branch: branchOf(header), dirty: changes.length > 0 };
}

export async function readRemotes(cwd: string): Promise<Remotes> {
	const ran = await runGit(cwd, ["remote", "-v"]);
	const remotes = new Map<string, string>();
	if (!ran.ok) return remotes;
	for (const line of ran.stdout.split("\n")) {
		const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
		if (match?.[1] && match[2]) remotes.set(match[1], match[2]);
	}
	return remotes;
}

export function remoteFacts(snapshot: Remotes, now: Remotes): RemoteFact[] {
	return [...now]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, url]) => ({ name, url, changed: snapshot.get(name) !== url }));
}
