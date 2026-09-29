// The route's agent dir, computed as Pi's `getAgentDir` does (Pi 0.87.1
// `dist/config.js:421`), because the bouncer must not import Pi at runtime.
import { homedir } from "node:os";
import { join } from "node:path";

/** `$PI_CODING_AGENT_DIR` with `~` expanded, or `~/.pi/agent`. */
export function agentDir(): string {
	const { PI_CODING_AGENT_DIR } = process.env;
	if (!PI_CODING_AGENT_DIR) return join(homedir(), ".pi", "agent");
	if (PI_CODING_AGENT_DIR === "~") return homedir();
	if (PI_CODING_AGENT_DIR.startsWith("~/")) {
		return join(homedir(), PI_CODING_AGENT_DIR.slice(2));
	}
	return PI_CODING_AGENT_DIR;
}
