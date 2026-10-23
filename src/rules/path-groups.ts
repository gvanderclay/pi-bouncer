// The built-in path groups, in evaluation order, each at its shipped levels:
// the last match wins, so the broad folder groups come first and the secret
// groups after them, and a secret group decides its own paths. path-bouncer
// is listed first but ranked before the walk (`src/rules/path-rank.ts`).
import { posix } from "node:path";
import { PACKAGE_DIR } from "../package-dir.ts";
import { realOf } from "../path-spellings.ts";
import type { RuleName } from "../verdict.ts";
import {
	compilePattern,
	type PathPattern,
	type PathWhere,
} from "./path-patterns.ts";
import type { DirectionLevels, PathEntry } from "./rule.ts";

export type PathGroup = PathEntry & { readonly secret: boolean };

type GroupDef = {
	readonly name: RuleName;
	readonly summary: string;
	readonly patterns: readonly string[];
	readonly except?: readonly string[];
	readonly levels: DirectionLevels;
	/** 08 keeps a secret group's content away from the judge and Jev. */
	readonly secret: boolean;
};

const DENY: DirectionLevels = { read: "deny", write: "deny" };
const DENY_READ: DirectionLevels = { read: "deny", write: "ask" };
const ASK_WRITE: DirectionLevels = { read: "allow", write: "ask" };

// The agent dir is known where a call is decided, so a test's temporary agent
// dir is the one matched.
const AGENT_DIR = "<agent dir>/";
// The session's working directory: the project whose own config Pi and the
// bouncer load, so a symlink there is followed to the file it names.
const PROJECT = "<project>/";
const PACKAGE = "<package dir>/**";

const DEFS: readonly GroupDef[] = [
	{
		name: "path-bouncer",
		summary:
			"the bouncer's config, its code and Pi's settings decide what the bouncer guards",
		patterns: [
			`${AGENT_DIR}bouncer.json`,
			"**/.pi/extensions/bouncer/config.json",
			`${PROJECT}.pi/extensions/bouncer/config.json`,
			PACKAGE,
			`${AGENT_DIR}settings.json`,
			"**/.pi/settings.json",
			`${PROJECT}.pi/settings.json`,
		],
		levels: { read: "allow", write: "deny" },
		secret: false,
	},
	{
		name: "path-system",
		summary: "a system folder changes software for the whole machine",
		patterns: [
			"/etc/**",
			"/usr/**",
			"/bin/**",
			"/sbin/**",
			"/opt/**",
			"/System/**",
			"/Library/**",
			"/Applications/**",
			"/boot/**",
			"/lib/**",
			"/lib64/**",
			"/srv/**",
			"/dev/**",
			"/proc/**",
			"/sys/**",
			"/snap/**",
			"/nix/**",
			"/private/etc/**",
		],
		levels: ASK_WRITE,
		secret: false,
	},
	{
		name: "path-git",
		summary: "a .git folder holds the repository's config, hooks and history",
		patterns: ["**/.git/**"],
		levels: ASK_WRITE,
		secret: false,
	},
	{
		name: "path-shell-rc",
		summary: "shell startup files run on every new shell",
		patterns: [
			".zshrc",
			".zshenv",
			".zprofile",
			".bashrc",
			".bash_profile",
			".bash_login",
			".profile",
			"~/.config/fish/config.fish",
		],
		levels: ASK_WRITE,
		secret: false,
	},
	{
		name: "path-keys",
		summary:
			"private keys and certificates are secrets to keep out of the model",
		patterns: ["*.pem", "*.key", "id_rsa*", "id_ed25519*"],
		except: ["*.pub"],
		levels: DENY,
		secret: true,
	},
	{
		name: "path-ssh",
		summary: "~/.ssh holds SSH keys and their settings",
		patterns: ["~/.ssh/**"],
		levels: DENY,
		secret: true,
	},
	{
		name: "path-gnupg",
		summary: "~/.gnupg holds GPG keys and its trust database",
		patterns: ["~/.gnupg/**"],
		levels: DENY,
		secret: true,
	},
	{
		name: "path-aws",
		summary: "~/.aws holds AWS credentials and settings",
		patterns: ["~/.aws/**"],
		levels: DENY,
		secret: true,
	},
	{
		name: "path-gcloud",
		summary: "~/.config/gcloud holds Google Cloud credentials",
		patterns: ["~/.config/gcloud/**"],
		levels: DENY,
		secret: true,
	},
	{
		name: "path-azure",
		summary: "~/.azure holds Azure credentials",
		patterns: ["~/.azure/**"],
		levels: DENY,
		secret: true,
	},
	{
		name: "path-kube",
		summary: "~/.kube holds Kubernetes cluster credentials",
		patterns: ["~/.kube/**"],
		levels: DENY,
		secret: true,
	},
	{
		name: "path-docker",
		summary: "~/.docker/config.json holds registry logins",
		patterns: ["~/.docker/config.json"],
		levels: DENY,
		secret: true,
	},
	{
		name: "path-pi-auth",
		summary: "Pi's auth.json holds the credentials Pi uses for you",
		patterns: [`${AGENT_DIR}auth.json`],
		levels: DENY,
		secret: true,
	},
	{
		name: "path-env",
		summary: "a .env file holds a project's secrets",
		patterns: [".env*"],
		except: [".env.example", ".env.sample", ".env.template"],
		levels: DENY_READ,
		secret: true,
	},
	{
		name: "path-npmrc",
		summary: ".npmrc holds registry tokens",
		patterns: [".npmrc"],
		levels: DENY_READ,
		secret: true,
	},
	{
		name: "path-pypirc",
		summary: ".pypirc holds package registry tokens",
		patterns: [".pypirc"],
		levels: DENY_READ,
		secret: true,
	},
	{
		name: "path-netrc",
		summary: ".netrc holds server logins",
		patterns: [".netrc"],
		levels: DENY_READ,
		secret: true,
	},
	{
		name: "path-git-credentials",
		summary: ".git-credentials holds saved git logins",
		patterns: [".git-credentials"],
		levels: DENY_READ,
		secret: true,
	},
];

// `<agent dir>/…` and `<project>/…` are one absolute path, whose leading
// folder comes from the decision; `base` is the whole path, so a search above
// it still fires. The file's own target matches too: when the file is a
// symlink, whatever reads it reads the target. Resolved per call, inside the
// decision that blocks on an error.
function fixedFile(
	source: string,
	pathOf: (where: PathWhere) => string,
): PathPattern {
	return {
		source,
		anchor: "root",
		base: pathOf,
		test: (path: string, where: PathWhere): boolean => {
			const file = pathOf(where);
			return path === file || path === realOf(file);
		},
	};
}

// The folder the bouncer was loaded from and everything in it, by the
// spelling it was loaded from and by its real path: a loader may keep a
// symlinked `pi -e` path as given. Resolved per call, so a failure blocks
// that call rather than the bouncer's load.
const packageFolder: PathPattern = {
	source: PACKAGE,
	anchor: "root",
	base: (): string => PACKAGE_DIR,
	test: (path: string): boolean =>
		[PACKAGE_DIR, realOf(PACKAGE_DIR)].some(
			(dir) => path === dir || path.startsWith(`${dir}/`),
		),
};

function compile(source: string): PathPattern {
	if (source === PACKAGE) return packageFolder;
	if (source.startsWith(AGENT_DIR)) {
		const file = source.slice(AGENT_DIR.length);
		return fixedFile(source, (where) => posix.join(where.agentDir, file));
	}
	if (source.startsWith(PROJECT)) {
		const file = source.slice(PROJECT.length);
		return fixedFile(source, (where) => posix.join(where.cwd, file));
	}
	const compiled = compilePattern(source);
	if (!compiled) throw new Error(`bad built-in path pattern: ${source}`);
	return compiled;
}

function entry(def: GroupDef): PathGroup {
	const { name, summary, patterns, except, levels, secret } = def;
	return {
		kind: "path",
		rule: {
			name,
			summary,
			patterns: patterns.map(compile),
			...(except && {
				except: except.map(compile),
			}),
		},
		levels,
		secret,
	};
}

export function pathGroups(): readonly PathGroup[] {
	return DEFS.map(entry);
}

const SECRET: ReadonlySet<RuleName> = new Set(
	DEFS.filter((def) => def.secret).map((def) => def.name),
);

export function isSecretGroup(name: RuleName): boolean {
	return SECRET.has(name);
}
