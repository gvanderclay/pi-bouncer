// Choosing a session's profile: steps 1 to 4 of the plan's resolution rules.
import type { AgentSource } from "./agent-env.ts";
import type {
	Chosen,
	Normal,
	ParsedProfile,
	Profile,
	ProfileFile,
	StartMode,
} from "./profiles.ts";
import { projectLevels } from "./project-config.ts";
import { mergeProtect } from "./protect.ts";
import { projectRules } from "./rules/custom.ts";

function own<T>(
	record: Readonly<Record<string, T>> | undefined,
	key: string,
): T | undefined {
	return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

// Step 2: the profile name for an agent. An untrusted project's entry stands
// only when the user config neither maps the agent nor defines that profile.
function profileName(
	agent: string,
	user: ProfileFile,
	project: ProfileFile,
	trusted: boolean,
	problems: string[],
): string | undefined {
	const fromUser = own(user.agents, agent);
	const fromProject = own(project.agents, agent);
	if (fromProject === undefined || trusted) return fromProject ?? fromUser;
	if (fromUser === undefined && own(user.profiles, fromProject) === undefined) {
		return fromProject;
	}
	problems.push(
		`agents: "${agent}" would replace the user config's profile, and the project is not trusted`,
	);
	return fromUser;
}

const EMPTY: Profile = { levels: {}, rules: [] };

// A trusted project's mode replaces the user's; an untrusted one may only
// start the session in off.
function projectMode(
	base: StartMode | undefined,
	mode: StartMode | undefined,
	trusted: boolean,
	refused: string[],
): StartMode | undefined {
	if (mode === undefined || trusted || mode === "off") return mode ?? base;
	refused.push(
		'mode: "auto" would loosen the session, and the project is not trusted',
	);
	return base;
}

// Step 3: the project's definition on top of the user's.
function layered(
	user: Profile | undefined,
	project: Profile | undefined,
	normal: Normal,
	trusted: boolean,
	refused: string[],
): Profile {
	const base = user ?? EMPTY;
	if (!project) return base;
	const kept = projectLevels(
		{ file: { path: "", loaded: true, problems: [] }, levels: project.levels },
		{ ...normal.levels, ...base.levels },
		trusted,
	);
	refused.push(...kept.file.problems);
	const used = [...normal.rules, ...base.rules];
	const rules = projectRules(project.rules, used, trusted, refused);
	const protect = mergeProtect(base.protect, project.protect);
	const mode = projectMode(base.mode, project.mode, trusted, refused);
	return {
		levels: { ...base.levels, ...kept.levels },
		rules: [...base.rules, ...rules],
		...(protect && { protect }),
		...(mode && { mode }),
	};
}

function okProfile(parsed: ParsedProfile | undefined): Profile | undefined {
	return parsed?.kind === "ok" ? parsed.profile : undefined;
}

/**
 * Steps 1 to 4 of the resolution: which profile the agent gets, the layer to
 * apply, and the problems the project file's refusals add.
 */
export function chooseProfile(
	agent: AgentSource | undefined,
	user: ProfileFile,
	project: ProfileFile,
	trusted: boolean,
	normal: Normal,
): Chosen {
	if (!agent) return { problems: [] };
	const { name: who, variable: from } = agent;
	const problems: string[] = [];
	const name = profileName(who, user, project, trusted, problems);
	if (name === undefined) {
		return { choice: { state: "unmapped", agent: who, from }, problems };
	}
	const mine = own(user.profiles, name);
	const theirs = own(project.profiles, name);
	const broken = mine?.kind === "broken" || (!mine && theirs?.kind !== "ok");
	if (broken) {
		return { choice: { state: "broken", agent: who, from, name }, problems };
	}
	const refused: string[] = [];
	const layer = layered(
		okProfile(mine),
		okProfile(theirs),
		normal,
		trusted,
		refused,
	);
	problems.push(...refused.map((problem) => `profiles.${name}.${problem}`));
	return {
		choice: { state: "profile", agent: who, from, name },
		layer,
		problems,
	};
}

/** Every agent name whose profile resolves, for PR 5's launch listener. */
export function profiledAgents(
	user: ProfileFile,
	project: ProfileFile,
	trusted: boolean,
): ReadonlySet<string> {
	// Placeholders: only `choice.state` is read, so `variable` and `normal` are unused.
	const normal: Normal = { levels: {}, rules: [], startMode: "off" };
	const names = new Set([
		...Object.keys(user.agents ?? {}),
		...Object.keys(project.agents ?? {}),
	]);
	return new Set(
		[...names].filter((name) => {
			const agent = { name, variable: "" };
			const { choice } = chooseProfile(agent, user, project, trusted, normal);
			return choice?.state === "profile";
		}),
	);
}
