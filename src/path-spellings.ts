// Every spelling of a file call's path that a path rule is tested against:
// what Pi opens, and where that really is on disk.
import { existsSync, readlinkSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import type { FileAccess } from "./file-call.ts";
import { absolutePath } from "./history.ts";

export type Spellings = {
	readonly typed: string;
	readonly absolute: string;
	readonly real: string;
	/** Every distinct spelling to test, absolute and real first. */
	readonly all: readonly string[];
};

// Linux's limit on symlinks followed in one lookup.
const MAX_LINKS = 40;

function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

// Whether `error` is a path that does not exist, or a parent of it that is
// not a directory.
export function missing(error: unknown): boolean {
	return code(error) === "ENOENT" || code(error) === "ENOTDIR";
}

// The symlink's target, or undefined when `path` is no symlink.
function linkTarget(path: string): string | undefined {
	try {
		return readlinkSync(path);
	} catch (error) {
		if (missing(error) || code(error) === "EINVAL") return undefined;
		throw error;
	}
}

/**
 * The symlink-resolved path, in the case the file system stores it (macOS
 * folds case). For a path that doesn't exist: a dangling symlink is followed
 * to its target, and otherwise the nearest existing parent is resolved and
 * the rest appended, as a write would create it. Any other error throws.
 */
export function realOf(path: string, links = 0): string {
	try {
		return realpathSync.native(path);
	} catch (error) {
		if (!missing(error)) throw error;
		if (links > MAX_LINKS) {
			throw Object.assign(new Error(`too many symlinks: ${path}`), {
				code: "ELOOP",
			});
		}
		const parent = posix.dirname(path);
		if (parent === path) throw error;
		const target = linkTarget(path);
		if (target !== undefined) {
			return realOf(posix.resolve(parent, target), links + 1);
		}
		return posix.join(realOf(parent, links), posix.basename(path));
	}
}

// The names Pi's `read` also tries when the path doesn't exist:
// `resolveReadPath` in dist/core/tools/path-utils.js of
// @earendil-works/pi-coding-agent 1.0.0.
function readVariants(path: string): string[] {
	const amPm = path.replace(/ (AM|PM)\./gi, "\u202F$1.");
	const nfd = path.normalize("NFD");
	const curly = path.replace(/'/g, "\u2019");
	const nfdCurly = nfd.replace(/'/g, "\u2019");
	return [amPm, nfd, curly, nfdCurly].filter((variant) => variant !== path);
}

export function spellings(
	access: FileAccess,
	cwd: string,
	home: string,
): Spellings {
	const typed = access.path;
	const absolute = absolutePath(typed, cwd, home);
	const real = realOf(absolute);
	const variants =
		access.tool === "read" && !existsSync(absolute)
			? readVariants(absolute).map((variant) => realOf(variant))
			: [];
	const all = [...new Set([absolute, real, ...variants])];
	return { typed, absolute, real, all };
}
