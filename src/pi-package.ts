// Finds Pi's package for the CLIs, which run outside Pi. A git checkout has it
// as a devDependency; an npm install of the bouncer has only the `pi` on PATH.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

type Pi = typeof import("@earendil-works/pi-coding-agent");

const NAME = "@earendil-works/pi-coding-agent";

function entryOf(dir: string): string {
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	const entry = pkg.exports?.["."]?.import ?? pkg.main ?? "index.js";
	return pathToFileURL(join(dir, entry)).href;
}

// The package dir above the real path of `pi` on PATH, as npm links its bin.
function dirFromPath(): string | undefined {
	for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
		const bin = join(dir, "pi");
		if (dir === "" || !existsSync(bin)) continue;
		let at = dirname(realpathSync(bin));
		while (at !== dirname(at)) {
			const manifest = join(at, "package.json");
			if (existsSync(manifest)) {
				const { name } = JSON.parse(readFileSync(manifest, "utf8"));
				if (name === NAME) return at;
			}
			at = dirname(at);
		}
		return undefined;
	}
	return undefined;
}

export async function importPi(): Promise<Pi> {
	const tried: string[] = [];
	try {
		return await import(NAME);
	} catch (error) {
		tried.push(`import("${NAME}"): ${String(error)}`);
	}
	const fromEnv = process.env["PI_PACKAGE_DIR"];
	const candidates: [string, string | undefined][] = [
		["$PI_PACKAGE_DIR", fromEnv === "" ? undefined : fromEnv],
		["`pi` on PATH", dirFromPath()],
	];
	for (const [label, dir] of candidates) {
		if (dir === undefined) {
			tried.push(`${label}: not found`);
			continue;
		}
		try {
			return await import(entryOf(dir));
		} catch (error) {
			tried.push(`${label} (${dir}): ${String(error)}`);
		}
	}
	throw new Error(
		`cannot find Pi's package (${NAME}); set PI_PACKAGE_DIR to its directory. Tried:\n  ${tried.join("\n  ")}`,
	);
}
