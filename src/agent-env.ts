/** The variable the bouncer's launch listener sets for a child. */
export const BOUNCER_AGENT_VARIABLE = "PI_BOUNCER_AGENT";

// The environment variables that name an agent, in priority order.
export const AGENT_VARIABLES = [
	BOUNCER_AGENT_VARIABLE, // set by the bouncer's session:launch listener, or by hand
	"PI_SUBAGENT_AGENT", // HazAT/pi-interactive-subagents
	"PI_DADDY_DEFINITION", // pi-daddy
] as const;

export type AgentSource = { readonly name: string; readonly variable: string };

/** The agent name from the first variable that is set and not blank. */
export function agentFrom(
	env: Readonly<Record<string, string | undefined>>,
): AgentSource | undefined {
	for (const variable of AGENT_VARIABLES) {
		const name = env[variable]?.trim();
		if (name) return { name, variable };
	}
	return undefined;
}
