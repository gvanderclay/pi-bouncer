// The `/bouncer` command: what the bouncer enforces, where its files are, and
// a dry run of a command, all without changing anything but `init`'s new file.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type ConfigFile,
	type GateConfig,
	loadConfig,
	routeConfigFile,
} from "./config.ts";
import { errorText } from "./error-text.ts";
import { asText } from "./explain.ts";
import { inspect, type ParseFn } from "./gate.ts";
import { logFile } from "./log.ts";
import type { ModeHolder } from "./mode.ts";
import type { SessionState } from "./mode-switch.ts";
import { ruleLevels } from "./policy.ts";
import { builtInPolicy } from "./rules/built-in-policy.ts";
import { type Policy, policyEntryName, type Rule } from "./rules/rule.ts";

export const SCHEMA_URL =
	"https://raw.githubusercontent.com/gvanderclay/pi-bouncer/main/schema/bouncer.schema.json";

const USAGE = "Usage: /bouncer [status|rules|explain <command>|init|check]";

export type BouncerParts = {
	readonly holder: ModeHolder;
	readonly session: SessionState;
	readonly parser: ParseFn | undefined;
	readonly agentDir: string;
	readonly logDir: string;
};

const UNREADABLE: Readonly<Record<string, string>> = {
	"parser-unavailable": "the bash parser (unbash) could not load",
	unparseable: "the command is not valid bash",
	"inline-too-deep": "inline scripts (sh -c, eval) nest more than 3 deep",
};

function policyOf(parts: BouncerParts): Policy {
	return parts.session.config?.policy ?? builtInPolicy;
}

function offOf(parts: BouncerParts): readonly Rule[] {
	return parts.session.config?.off ?? [];
}

function trusted(parts: BouncerParts): boolean {
	return parts.session.config?.projectTrusted ?? false;
}

function fileLines({ path, loaded, problems }: ConfigFile): string[] {
	let state = "absent";
	if (loaded) state = "loaded";
	else if (problems.length > 0) state = "not loaded";
	return [`- ${path} (${state})`, ...problems.map((p) => `  - ${p}`)];
}

function modeText({ holder, session }: BouncerParts): string {
	if (holder.mode === "yolo") return "YOLO";
	if (holder.mode === "auto") {
		return session.pause.paused ? "auto (paused)" : "auto";
	}
	return "normal";
}

function autoLine(config: GateConfig | undefined): string {
	const auto = config?.auto;
	if (!auto)
		return "Auto mode: no judge list (auto.models), so it cannot turn on";
	const count = auto.models.length;
	const jev = auto.jev ? ", Jev on" : "";
	return `Auto mode: ${count} judge-list entr${count === 1 ? "y" : "ies"}${jev}; /auto status has more`;
}

function protectLines(config: GateConfig | undefined): string[] {
	const { home = [], paths = [] } = config?.protect ?? {};
	const added = [...home.map((name) => `~/${name}`), ...paths];
	return added.length > 0 ? [`rm-root also protects: ${added.join(", ")}`] : [];
}

function status(parts: BouncerParts): string {
	const { config } = parts.session;
	const levels = Object.entries(ruleLevels(policyOf(parts), offOf(parts)));
	const byLevel = (level: string): string =>
		levels
			.filter(([, at]) => at === level)
			.map(([name]) => name)
			.join(", ") || "none";
	return [
		`Bouncer mode: ${modeText(parts)}`,
		parts.parser
			? "Parser: loaded"
			: "Parser: missing, so every bash command is denied",
		"Config files:",
		...(config?.files.flatMap(fileLines) ?? ["- not read yet"]),
		`Project: ${trusted(parts) ? "trusted" : "untrusted"}`,
		`Deny: ${byLevel("deny")}`,
		`Ask: ${byLevel("ask")}`,
		`Off: ${byLevel("off")}`,
		...protectLines(config),
		`Log: ${logFile(parts.logDir)}`,
		autoLine(config),
		"/bouncer rules explains each rule.",
	].join("\n");
}

function rules(parts: BouncerParts): string {
	const active = policyOf(parts).map((entry) => {
		const name = policyEntryName(entry);
		const summary =
			entry.kind === "unreadable" ? UNREADABLE[name] : entry.rule.summary;
		const steer = entry.kind === "steer" ? `; ${entry.instead}` : "";
		return `${name} (${entry.level}): ${summary}${steer}`;
	});
	const off = offOf(parts).map((rule) => `${rule.name} (off): ${rule.summary}`);
	return [...active, ...off].join("\n");
}

function explainCommand(
	parts: BouncerParts,
	command: string,
	ctx: ExtensionContext,
): string {
	const project = { cwd: ctx.cwd, trusted: trusted(parts) };
	const config = parts.session.config ?? loadConfig(parts.agentDir, project);
	const where = { cwd: ctx.cwd, home: homedir() };
	const alwaysAsk = config.auto?.alwaysAsk ?? [];
	const inspection = inspect(
		parts.parser,
		command,
		config.policy,
		where,
		alwaysAsk,
	);
	const trust = { trusted: project.trusted, source: "this session" };
	return asText(inspection, config, trust);
}

function init(parts: BouncerParts): string {
	const path = routeConfigFile(parts.agentDir);
	const text = `${JSON.stringify({ $schema: SCHEMA_URL, levels: {} }, null, "\t")}\n`;
	try {
		mkdirSync(parts.agentDir, { recursive: true });
		writeFileSync(path, text, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return `${path} already exists; left as it is.`;
		}
		return `Could not write ${path}: ${errorText(error)}`;
	}
	return `Wrote ${path}. Your editor completes its keys from the schema; changes apply at the next session start or /reload.`;
}

// Reads both files again and applies nothing.
function check(parts: BouncerParts, ctx: ExtensionContext): string {
	const config = loadConfig(parts.agentDir, {
		cwd: ctx.cwd,
		trusted: trusted(parts),
	});
	const verdict =
		config.problems.length === 0
			? "No config problems."
			: "Config problems; these parts would be ignored:";
	return [verdict, ...config.files.flatMap(fileLines)].join("\n");
}

function respond(
	parts: BouncerParts,
	args: string,
	ctx: ExtensionContext,
): string {
	const [sub = "status", ...rest] = args.trim().split(/\s+(.*)/s);
	const command = rest.join("").trim();
	if (sub === "status" || sub === "") return status(parts);
	if (sub === "rules") return rules(parts);
	if (sub === "explain" && command !== "") {
		return explainCommand(parts, command, ctx);
	}
	if (sub === "init") return init(parts);
	if (sub === "check") return check(parts, ctx);
	return USAGE;
}

export function registerBouncer(pi: ExtensionAPI, parts: BouncerParts): void {
	pi.registerCommand("bouncer", {
		description:
			"Bouncer: status, rules, explain <command>, init (write a user config) or check (re-read the config)",
		handler: async (args: string, ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) return;
			const text = respond(parts, args, ctx);
			ctx.ui.notify(text, text === USAGE ? "warning" : "info");
		},
	});
}
