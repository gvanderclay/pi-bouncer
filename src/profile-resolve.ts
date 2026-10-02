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

type Picked =
	| { readonly state: "unmapped" }
	| { readonly state: "broken"; readonly name: string }
	| {
			readonly state: "profile";
			readonly name: string;
			readonly mine: ParsedProfile | undefined;
			readonly theirs: ParsedProfile | undefined;
	  };

// Steps 1 and 2 and the broken check, once: what the agent name resolves to.
function pick(
	agent: string,
	user: ProfileFile,
	project: ProfileFile,
	trusted: boolean,
	problems: string[],
): Picked {
	const name = profileName(agent, user, project, trusted, problems);
	if (name === undefined) return { state: "unmapped" };
	const mine = own(user.profiles, name);
	const theirs = own(project.profiles, name);
	const broken = mine?.kind === "broken" || (!mine && theirs?.kind !== "ok");
	if (broken) return { state: "broken", name };
	return { state: "profile", name, mine, theirs };
}

/** Whether the agent resolves to a usable profile. */
export function resolves(
	agent: Pick<AgentSource, "name">,
	user: ProfileFile,
	project: ProfileFile,
	trusted: boolean,
): boolean {
	return pick(agent.name, user, project, trusted, []).state === "profile";
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
	const problems: string[] = [];
	const picked = pick(agent.name, user, project, trusted, problems);
	if (picked.state === "unmapped") {
		return { choice: { state: "unmapped", agent }, problems };
	}
	const { name } = picked;
	if (picked.state === "broken") {
		return { choice: { state: "broken", agent, name }, problems };
	}
	const refused: string[] = [];
	const layer = layered(
		okProfile(picked.mine),
		okProfile(picked.theirs),
		normal,
		trusted,
		refused,
	);
	problems.push(...refused.map((problem) => `profiles.${name}.${problem}`));
	return { choice: { state: "profile", agent, name }, layer, problems };
}

/** Every agent name whose profile resolves, for PR 5's launch listener. */
export function profiledAgents(
	user: ProfileFile,
	project: ProfileFile,
	trusted: boolean,
): ReadonlySet<string> {
	const names = new Set([
		...Object.keys(user.agents ?? {}),
		...Object.keys(project.agents ?? {}),
	]);
	return new Set(
		[...names].filter((name) => resolves({ name }, user, project, trusted)),
	);
}
