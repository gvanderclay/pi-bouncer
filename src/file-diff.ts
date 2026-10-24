// The change a `write` or `edit` would make, as the dialog shows it: old lines
// with `-`, new lines with `+`, cut short so a large file stays readable.
import { readFileSync, statSync } from "node:fs";
import { errorText } from "./error-text.ts";
import type { FileAccess, FileEdit } from "./file-call.ts";
import { missing } from "./path-spellings.ts";

const DETAIL_LIMIT = 2000;
const MAX_READ_BYTES = 1024 * 1024;
const NEW_FILE_LINES = 20;

function lines(text: string): string[] {
	const all = text.split("\n");
	// A final newline ends the last line; it is not a line of its own.
	if (all.length > 1 && all[all.length - 1] === "") all.pop();
	return all;
}

function prefixed(prefix: "-" | "+", text: string): string[] {
	return lines(text).map((line) => `${prefix}${line}`);
}

// The changed block only: the lines two versions share at the start and the
// end are left out, so a one-line change reads as one `-` and one `+` line.
function changed(oldText: string, newText: string): string[] {
	const old = lines(oldText);
	const next = lines(newText);
	let start = 0;
	while (
		start < old.length &&
		start < next.length &&
		old[start] === next[start]
	) {
		start += 1;
	}
	let endOld = old.length;
	let endNext = next.length;
	while (
		endOld > start &&
		endNext > start &&
		old[endOld - 1] === next[endNext - 1]
	) {
		endOld -= 1;
		endNext -= 1;
	}
	const diff = [
		...old.slice(start, endOld).map((line) => `-${line}`),
		...next.slice(start, endNext).map((line) => `+${line}`),
	];
	return diff.length > 0 ? diff : ["(no line changes)"];
}

function editDiff(edits: readonly FileEdit[]): string {
	return edits
		.flatMap((edit) => changed(edit.oldText, edit.newText))
		.join("\n");
}

type Existing =
	| { readonly kind: "missing" }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "note"; readonly note: string };

// A file that can't be read for the diff still opens the dialog, with a note.
function readExisting(real: string): Existing {
	try {
		const stat = statSync(real);
		// A device or a FIFO has a size of 0 and never reaches EOF, so reading
		// it would hang the gate or fill memory.
		if (!stat.isFile()) {
			return {
				kind: "note",
				note: "(the existing path is not a regular file)",
			};
		}
		if (stat.size > MAX_READ_BYTES) {
			return {
				kind: "note",
				note: `(the existing file is too large to show, over ${MAX_READ_BYTES} bytes)`,
			};
		}
		const bytes = readFileSync(real);
		if (bytes.includes(0)) {
			return {
				kind: "note",
				note: "(the existing file is binary; no diff shown)",
			};
		}
		return { kind: "text", text: bytes.toString("utf8") };
	} catch (error) {
		if (missing(error)) return { kind: "missing" };
		return {
			kind: "note",
			note: `(could not read the existing file: ${errorText(error)})`,
		};
	}
}

function writeDiff(content: string, real: string): string {
	const existing = readExisting(real);
	if (existing.kind === "missing") {
		const head = lines(content).slice(0, NEW_FILE_LINES).join("\n");
		return `new file\n${head}`;
	}
	if (existing.kind === "note") {
		return `${existing.note}\n${prefixed("+", content).join("\n")}`;
	}
	return changed(existing.text, content).join("\n");
}

function cut(text: string): string {
	return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

/** The dialog's detail for a file access: the diff for a write or edit, else "". */
export function fileDiff(access: FileAccess, real: string): string {
	const { change } = access;
	if (!change) return "";
	const text =
		change.kind === "write"
			? writeDiff(change.content, real)
			: editDiff(change.edits);
	return cut(text);
}
