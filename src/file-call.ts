// Pi's six file tools, and their input read into a file access. Tool input
// comes from the model and is untrusted: input that has no usable path is
// unreadable, and blocks.
import { isObject } from "./json.ts";
import { clip, type Verdict } from "./verdict.ts";

export type FileTool = "read" | "write" | "edit" | "grep" | "find" | "ls";
export type Direction = "read" | "write";
export type FileEdit = { readonly oldText: string; readonly newText: string };
export type FileChange =
	| { readonly kind: "write"; readonly content: string }
	| { readonly kind: "edit"; readonly edits: readonly FileEdit[] };
export type FileAccess = {
	readonly tool: FileTool;
	readonly direction: Direction;
	/** As the agent typed it; "." when grep, find or ls omitted it. */
	readonly path: string;
	/** true for grep, find and ls. */
	readonly search: boolean;
	readonly change?: FileChange;
};
export type FileCallRead =
	| { readonly kind: "ok"; readonly access: FileAccess }
	| { readonly kind: "unreadable"; readonly verdict: Verdict };

const FILE_TOOLS: ReadonlySet<string> = new Set<FileTool>([
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"ls",
]);

export function isFileTool(name: string): name is FileTool {
	return FILE_TOOLS.has(name);
}

function isSearch(tool: FileTool): boolean {
	return tool === "grep" || tool === "find" || tool === "ls";
}

function isEdit(value: unknown): value is FileEdit {
	return (
		isObject(value) &&
		typeof value["oldText"] === "string" &&
		typeof value["newText"] === "string"
	);
}

// Pi's edit also takes one top-level oldText/newText pair (`prepareEditArguments`).
function editsOf(input: Readonly<Record<string, unknown>>): FileEdit[] {
	const { edits } = input;
	const listed = Array.isArray(edits) ? edits.filter(isEdit) : [];
	return isEdit(input) ? [...listed, input] : listed;
}

function changeOf(
	tool: FileTool,
	input: Readonly<Record<string, unknown>>,
): FileChange | undefined {
	if (tool === "write" && typeof input["content"] === "string") {
		return { kind: "write", content: input["content"] };
	}
	if (tool === "edit") return { kind: "edit", edits: editsOf(input) };
	return undefined;
}

function unreadable(tool: FileTool, input: unknown): FileCallRead {
	let shown: string;
	try {
		shown = JSON.stringify(input) ?? String(input);
	} catch {
		shown = String(input);
	}
	return {
		kind: "unreadable",
		verdict: {
			level: "deny",
			rule: "unparseable",
			reason: `Blocked by the user's bouncer (rule: unparseable): the ${tool} tool's input has no usable path (a string). Input: \`${clip(shown)}\`. None of the call ran. Call ${tool} again with \`path\` as a string.`,
			command: tool,
		},
	};
}

export function readFileCall(tool: FileTool, input: unknown): FileCallRead {
	if (!isObject(input)) return unreadable(tool, input);
	const search = isSearch(tool);
	const given = input["path"];
	const omitted = given === undefined && search;
	if (typeof given !== "string" && !omitted) return unreadable(tool, input);
	const change = changeOf(tool, input);
	return {
		kind: "ok",
		access: {
			tool,
			direction: tool === "write" || tool === "edit" ? "write" : "read",
			path: typeof given === "string" ? given : ".",
			search,
			...(change && { change }),
		},
	};
}
