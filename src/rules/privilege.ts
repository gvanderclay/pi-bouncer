// Running anything with elevated privileges. The user can run these with `!`.
import type { Invocation } from "../scan/walk.ts";
import type { Rule } from "./rule.ts";

const PRIVILEGE_NAMES: ReadonlySet<string> = new Set([
	"sudo",
	"su",
	"doas",
	"sudoedit",
	"pkexec",
	"run0",
]);

export const privilege: Rule = {
	name: "privilege",
	summary: "the agent must not run anything with elevated privileges",
	matches: ({ name }: Invocation): boolean => PRIVILEGE_NAMES.has(name),
};
