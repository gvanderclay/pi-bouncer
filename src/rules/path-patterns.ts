// Gitignore-style globs for path rules, with no `!` negation: a later `allow`
// rule makes exceptions instead.
import { posix } from "node:path";

export type PathWhere = { readonly cwd: string; readonly home: string };

export type PathPattern = {
	readonly source: string;
	readonly anchor: "home" | "root" | "cwd" | "any";
	/** The leading components before the first wildcard, made absolute; undefined for "any". */
	readonly base?: (where: PathWhere) => string;
	readonly test: (absolutePath: string, where: PathWhere) => boolean;
};

const WILDCARD = /[*?]/;

function escaped(text: string): string {
	return text.replace(/[\\^$.|+()[\]{}*?]/g, "\\$&");
}

// shortcut: only `*`, `**` and `?` are wildcards; `[...]` classes match
// literally. Upgrade when a group or a user needs character classes.
function globBody(glob: string): string {
	let out = "";
	let i = 0;
	while (i < glob.length) {
		const rest = glob.slice(i);
		if (rest === "/**") {
			// The folder itself and everything below it.
			out += "(?:/.*)?";
			i += 3;
		} else if (rest.startsWith("/**/")) {
			out += "/(?:.*/)?";
			i += 4;
		} else if (i === 0 && rest.startsWith("**/")) {
			out += "(?:.*/)?";
			i += 3;
		} else if (rest.startsWith("**")) {
			out += ".*";
			i += 2;
		} else if (rest.startsWith("*")) {
			out += "[^/]*";
			i += 1;
		} else if (rest.startsWith("?")) {
			out += "[^/]";
			i += 1;
		} else {
			out += escaped(rest.charAt(0));
			i += 1;
		}
	}
	return out;
}

function anchorDir(anchor: "home" | "root" | "cwd", where: PathWhere): string {
	if (anchor === "home") return where.home;
	if (anchor === "cwd") return where.cwd;
	return "/";
}

export function compilePattern(source: string): PathPattern | undefined {
	if (source === "" || source.includes("!")) return undefined;
	// A leading `**/` matches in every folder on disk, as gitignore's does in
	// every folder below the file.
	if (source.startsWith("**/")) {
		const whole = new RegExp(`^/${globBody(source)}$`);
		return {
			source,
			anchor: "any",
			test: (path: string): boolean => whole.test(path),
		};
	}
	if (!source.includes("/")) {
		const name = new RegExp(`^${globBody(source)}$`);
		return {
			source,
			anchor: "any",
			test: (path: string): boolean => name.test(posix.basename(path)),
		};
	}
	let anchor: "home" | "root" | "cwd" = "cwd";
	let body = source;
	if (source.startsWith("~/")) {
		anchor = "home";
		body = source.slice(2);
	} else if (source.startsWith("/")) {
		anchor = "root";
		body = source.slice(1);
	}
	const bodyRe = globBody(body);
	const firstWild = body.split("/").findIndex((part) => WILDCARD.test(part));
	const fixed =
		firstWild === -1 ? body : body.split("/").slice(0, firstWild).join("/");
	const base = (where: PathWhere): string =>
		posix.join(anchorDir(anchor, where), fixed);
	return {
		source,
		anchor,
		base,
		test: (path: string, where: PathWhere): boolean => {
			const dir = anchorDir(anchor, where);
			const prefix = dir.endsWith("/") ? dir : `${dir}/`;
			return new RegExp(`^${escaped(prefix)}${bodyRe}$`).test(path);
		},
	};
}
