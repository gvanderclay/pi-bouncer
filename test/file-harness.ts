// Helpers for file-tool tests: a temporary HOME holding a fake SSH key, and
// file tool calls.
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { FileTool } from "../src/file-call.ts";
import { toolCall } from "./harness.ts";

/** A temp HOME with ~/.ssh/id_ed25519; sets process.env.HOME. Call before loadGateSession. */
export function tempHome(): string {
	// Real, so a test's expected real paths are the home it names (macOS's
	// tmpdir sits behind the /var -> /private/var symlink).
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-bouncer-home-")));
	process.on("exit", () => rmSync(home, { recursive: true, force: true }));
	mkdirSync(join(home, ".ssh"));
	writeFileSync(join(home, ".ssh", "id_ed25519"), "not a real key\n");
	process.env["HOME"] = home;
	return home;
}

export function fileCall(
	tool: FileTool,
	input: Record<string, unknown>,
): ToolCallEvent {
	return toolCall(tool, input);
}
