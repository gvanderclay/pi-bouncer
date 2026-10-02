// The environment variables that name an agent, in priority order.
export const AGENT_VARIABLES = [
	"PI_BOUNCER_AGENT", // set by the bouncer's session:launch listener, or by hand
	"PI_SUBAGENT_AGENT", // HazAT/pi-interactive-subagents
	"PI_DADDY_DEFINITION", // pi-daddy
] as const;
