// The program the bouncer suggests in place of a refused recursive rm: what
// the user config names, else the first one found on PATH.
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

// macOS's built-in, trash-cli's, GLib's (on most Linux desktops).
const KNOWN: readonly (readonly [string, string])[] = [
	["trash", "trash"],
	["trash-put", "trash-put"],
	["gio", "gio trash"],
];

function onPath(name: string, path: string): boolean {
	return path.split(":").some((dir) => {
		if (dir === "") return false;
		try {
			accessSync(join(dir, name), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

export function findTrash(
	configured: string | undefined,
	path: string | undefined,
): string | undefined {
	if (configured) return configured;
	return KNOWN.find(([name]) => onPath(name, path ?? ""))?.[1];
}
