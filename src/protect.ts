// The `protect` key: more paths for rm-root. Add-only, so any config file may
// set it, an untrusted project's included.
import { posix } from "node:path";
import type { Protect } from "./rules/filesystem.ts";

export const NO_PROTECT: Protect = { home: [], paths: [] };

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CHECKS = {
	home: [
		(v: string): boolean => !/^[/~]/.test(v) && !v.split("/").includes(".."),
		"a path below the home directory, such as code",
	],
	paths: [(v: string): boolean => v.startsWith("/"), "an absolute path"],
} as const;

function validList(
	key: keyof Protect,
	value: unknown,
	problems: string[],
): string[] {
	const [valid, rule] = CHECKS[key];
	if (!Array.isArray(value)) {
		problems.push(`"protect.${key}" must be a list`);
		return [];
	}
	return value.flatMap((entry) => {
		if (typeof entry === "string" && entry.trim() !== "" && valid(entry)) {
			const path = posix.normalize(entry).replace(/(.)\/$/, "$1");
			return [path];
		}
		problems.push(
			`"protect.${key}" entry ${JSON.stringify(entry)} must be ${rule}`,
		);
		return [];
	});
}

export function validProtect(value: unknown, problems: string[]): Protect {
	if (!isObject(value)) {
		problems.push('"protect" is not an object');
		return NO_PROTECT;
	}
	const protect = { home: [] as string[], paths: [] as string[] };
	for (const [key, list] of Object.entries(value)) {
		if (key === "home" || key === "paths") {
			protect[key] = validList(key, list, problems);
		} else problems.push(`"protect": unknown key "${key}"`);
	}
	return protect;
}

export function mergeProtect(a: Protect, b: Protect): Protect {
	return {
		home: [...new Set([...a.home, ...b.home])],
		paths: [...new Set([...a.paths, ...b.paths])],
	};
}
