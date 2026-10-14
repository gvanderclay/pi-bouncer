// The one invocation of a line that is a single foreground simple command.
// Relative paths are safe to resolve only then: a `cd`, wrapper, redirect,
// background job or second command can change what runs. The scanner flattens
// commands, so it cannot prove that itself.
import type { ParsedScript, Word, WordPart } from "unbash";
import type { Invocation, ParseFn } from "./scan/walk.ts";
import { peel } from "./scan/wrappers.ts";

// `parts` is absent on a plain word; a quoted word lists its parts instead.
function plainParts(parts: readonly WordPart[] | undefined): boolean {
	for (const part of parts ?? []) {
		switch (part.type) {
			case "Literal":
			case "SingleQuoted":
				break;
			case "DoubleQuoted":
			case "LocaleString":
				if (!plainParts(part.parts)) return false;
				break;
			default:
				return false;
		}
	}
	return true;
}

// `a\ b` and `$'a\tb'` decode to a literal, but the code only trusts a
// spelling it can read without decoding.
function plainWord(word: Word): boolean {
	return !word.text.includes("\\") && plainParts(word.parts);
}

// One statement, one foreground command, no assignment, redirect, expansion
// or background job.
function simpleShape(script: ParsedScript): boolean {
	const [statement, ...rest] = script.commands;
	if (!statement || rest.length > 0) return false;
	if (statement.background === true || statement.redirects.length > 0) {
		return false;
	}
	const { command } = statement;
	if (command.type !== "Command") return false;
	if (command.prefix.length > 0 || command.redirects.length > 0) return false;
	if (!command.name || !plainWord(command.name)) return false;
	return command.suffix.every(plainWord);
}

/**
 * The invocation when the whole line is one foreground simple command that is
 * not a wrapper; `undefined` when anything else could change what the command
 * reads or writes.
 */
export function soleDirectInvocation(
	parse: ParseFn,
	source: string,
	invocations: readonly Invocation[],
): Invocation | undefined {
	if (invocations.length !== 1) return undefined;
	const script = parse(source);
	if (script.errors?.length) return undefined;
	if (!simpleShape(script)) return undefined;
	const [only] = invocations;
	if (!only || peel(only) !== undefined) return undefined;
	return only;
}
