// Turns a bash command string into the ordered list of simple commands
// (invocations) it would run, wherever they sit: in lists and compound
// commands, and in every substitution nested in words and redirects.
// The only module family that reads unbash types.
import type {
	ArithmeticExpression,
	AssignmentPrefix,
	Command,
	Node,
	ParsedScript,
	Redirect,
	TestExpression,
	Word,
	WordPart,
} from "unbash";
import {
	inlineScript,
	MAX_INLINE_DEPTH,
	splitCommand,
} from "./inline-scripts.ts";
import { commandName } from "./normalize.ts";
import { type Peeled, peel } from "./wrappers.ts";

export type ParseFn = (source: string) => ParsedScript;

export type Invocation = {
	readonly name: string;
	readonly args: readonly string[];
	readonly source: string;
	/** Every invocation in earlier stages of every enclosing pipeline. */
	readonly upstream: readonly Invocation[];
	/** Every invocation nested, recursively, in this command's words and redirects. */
	readonly substitutions: readonly Invocation[];
};

export type Scan =
	| { readonly kind: "ok"; readonly invocations: readonly Invocation[] }
	| { readonly kind: "unparseable"; readonly message: string }
	| { readonly kind: "too-deep" };

/** State shared by the whole scan. */
type ScanState = {
	readonly parse: ParseFn;
	readonly invocations: Invocation[];
	readonly errors: string[];
	tooDeep: boolean;
};

/**
 * Where the walk is. `source` is the string positions index. Inside an inline
 * script, `origin` is the invoking command's text: invocations quote that,
 * so a reason always quotes text from the user's input.
 */
type Frame = {
	readonly state: ScanState;
	readonly source: string;
	readonly depth: number;
	readonly origin?: string;
	/** Invocations upstream of the current pipeline stage. */
	readonly upstream: readonly Invocation[];
};

// A missing case fails tsc here: every unbash node type must be handled.
function unreachable(value: never): never {
	throw new Error(`unhandled unbash node: ${JSON.stringify(value)}`);
}

// Positions index the nearest parsed string; a decoded backtick script
// carries its own (non-enumerable) `source`.
function visitScript(script: ParsedScript, parent: Frame): void {
	const error = script.errors?.[0];
	if (error) parent.state.errors.push(error.message);
	const frame: Frame = { ...parent, source: script.source ?? parent.source };
	for (const statement of script.commands) visit(statement, frame);
}

function visitWords(words: readonly (Word | undefined)[], frame: Frame): void {
	for (const word of words) {
		// `parts` is a lazy getter: read it explicitly.
		if (word) visitParts(word.parts ?? [], frame);
	}
}

function visitParts(parts: readonly WordPart[], frame: Frame): void {
	for (const part of parts) visitPart(part, frame);
}

function visitPart(part: WordPart, frame: Frame): void {
	switch (part.type) {
		case "Literal":
		case "SingleQuoted":
		case "AnsiCQuoted":
		case "SimpleExpansion":
			return;
		case "DoubleQuoted":
		case "LocaleString":
			visitParts(part.parts, frame);
			return;
		case "ExtendedGlob":
		case "BraceExpansion":
			visitParts(part.parts ?? [], frame);
			return;
		case "CommandExpansion":
		case "ProcessSubstitution":
			if (part.script) visitScript(part.script, frame);
			return;
		case "ArithmeticExpansion":
			visitArithmetic(part.expression, frame);
			return;
		case "ParameterExpansion":
			visitParts(part.indexParts ?? [], frame);
			visitWords(
				[
					part.operand,
					part.slice?.offset,
					part.slice?.length,
					part.replace?.pattern,
					part.replace?.replacement,
				],
				frame,
			);
			return;
		default:
			unreachable(part);
	}
}

function visitArithmetic(
	expression: ArithmeticExpression | undefined,
	frame: Frame,
): void {
	if (!expression) return;
	switch (expression.type) {
		case "ArithmeticBinary":
			visitArithmetic(expression.left, frame);
			visitArithmetic(expression.right, frame);
			return;
		case "ArithmeticUnary":
			visitArithmetic(expression.operand, frame);
			return;
		case "ArithmeticTernary":
			visitArithmetic(expression.test, frame);
			visitArithmetic(expression.consequent, frame);
			visitArithmetic(expression.alternate, frame);
			return;
		case "ArithmeticGroup":
			visitArithmetic(expression.expression, frame);
			return;
		case "ArithmeticWord":
			visitParts(expression.parts ?? [], frame);
			return;
		case "ArithmeticCommandExpansion":
			if (expression.script) visitScript(expression.script, frame);
			return;
		default:
			unreachable(expression);
	}
}

function visitTest(expression: TestExpression, frame: Frame): void {
	switch (expression.type) {
		case "TestUnary":
			visitWords([expression.operand], frame);
			return;
		case "TestBinary":
			visitWords([expression.left, expression.right], frame);
			return;
		case "TestLogical":
			visitTest(expression.left, frame);
			visitTest(expression.right, frame);
			return;
		case "TestNot":
			visitTest(expression.operand, frame);
			return;
		case "TestGroup":
			visitTest(expression.expression, frame);
			return;
		default:
			unreachable(expression);
	}
}

function visitRedirects(redirects: readonly Redirect[], frame: Frame): void {
	for (const redirect of redirects) {
		visitWords([redirect.target], frame);
		// A quoted heredoc (<<'EOF') is data: it has no parts to walk.
		if (!redirect.heredocQuoted) visitWords([redirect.body], frame);
	}
}

function visitAssignments(
	prefix: readonly AssignmentPrefix[],
	frame: Frame,
): void {
	for (const assignment of prefix) {
		visitParts(assignment.indexParts ?? [], frame);
		visitWords([assignment.value, ...(assignment.array ?? [])], frame);
	}
}

/** Parses a string a command runs as bash, one level deeper; undefined if too deep. */
function reparse(
	script: string,
	origin: string,
	frame: Frame,
): { script: ParsedScript; frame: Frame } | undefined {
	if (frame.depth >= MAX_INLINE_DEPTH) {
		frame.state.tooDeep = true;
		return undefined;
	}
	const inner: Frame = {
		state: frame.state,
		source: script,
		depth: frame.depth + 1,
		origin: frame.origin ?? origin,
		upstream: frame.upstream,
	};
	return { script: frame.state.parse(script), frame: inner };
}

function visitInline(invocation: Invocation, frame: Frame): void {
	const script = inlineScript(invocation);
	if (script === undefined) return;
	const parsed = reparse(script, invocation.source, frame);
	if (parsed) visitScript(parsed.script, parsed.frame);
}

/** The command a wrapper runs, re-parsing an env -S string if needed. */
function unwrap(
	peeled: Peeled | undefined,
	frame: Frame,
): Invocation | undefined {
	if (peeled?.kind !== "split") return peeled?.invocation;
	const parsed = reparse(peeled.script, peeled.parent.source, frame);
	if (!parsed) return undefined;
	const error = parsed.script.errors?.[0];
	if (error) frame.state.errors.push(error.message);
	const words = splitCommand(parsed.script);
	if (typeof words !== "string") {
		return { ...peeled.parent, args: [...words, ...peeled.rest] };
	}
	frame.state.errors.push(words);
	return undefined;
}

function visitCommand(command: Command, frame: Frame): void {
	// Filled after the words are walked; peeled invocations share it.
	const substitutions: Invocation[] = [];
	let invocation: Invocation | undefined = {
		name: commandName(command.name?.value ?? ""),
		args: command.suffix.map((word) => word.value),
		source: frame.origin ?? frame.source.slice(command.pos, command.end),
		upstream: frame.upstream,
		substitutions,
	};
	// A wrapper's command is listed right after it, and is peeled again.
	while (invocation) {
		frame.state.invocations.push(invocation);
		visitInline(invocation, frame);
		invocation = unwrap(peel(invocation), frame);
	}
	const start = frame.state.invocations.length;
	visitAssignments(command.prefix, frame);
	visitWords([command.name, ...command.suffix], frame);
	visitRedirects(command.redirects, frame);
	substitutions.push(...frame.state.invocations.slice(start));
}

/** Each stage sees every invocation of the stages before it as upstream. */
function visitPipeline(stages: readonly Node[], frame: Frame): void {
	const start = frame.state.invocations.length;
	for (const stage of stages) {
		const upstream = [
			...frame.upstream,
			...frame.state.invocations.slice(start),
		];
		visit(stage, { ...frame, upstream });
	}
}

function visitAll(nodes: readonly Node[], frame: Frame): void {
	for (const node of nodes) visit(node, frame);
}

function visit(node: Node, frame: Frame): void {
	switch (node.type) {
		case "Command":
			visitCommand(node, frame);
			return;
		case "Statement":
			visit(node.command, frame);
			visitRedirects(node.redirects, frame);
			return;
		case "Pipeline":
			visitPipeline(node.commands, frame);
			return;
		case "AndOr":
		case "CompoundList":
			visitAll(node.commands, frame);
			return;
		case "If":
			visitAll([node.clause, node.then], frame);
			if (node.else) visit(node.else, frame);
			return;
		case "While":
			visitAll([node.clause, node.body], frame);
			return;
		case "Case":
			visitWords([node.word], frame);
			for (const item of node.items) {
				visitWords(item.pattern, frame);
				visit(item.body, frame);
			}
			return;
		case "For":
		case "Select":
			visitWords(node.wordlist, frame);
			visit(node.body, frame);
			return;
		case "ArithmeticFor":
			visitArithmetic(node.initialize, frame);
			visitArithmetic(node.test, frame);
			visitArithmetic(node.update, frame);
			visit(node.body, frame);
			return;
		case "Function":
		case "Coproc":
			visit(node.body, frame);
			visitRedirects(node.redirects, frame);
			return;
		case "Subshell":
		case "BraceGroup":
			visit(node.body, frame);
			return;
		case "TestCommand":
			visitTest(node.expression, frame);
			return;
		case "ArithmeticCommand":
			visitArithmetic(node.expression, frame);
			return;
		default:
			unreachable(node);
	}
}

export function scan(parse: ParseFn, command: string): Scan {
	const state: ScanState = {
		parse,
		invocations: [],
		errors: [],
		tooDeep: false,
	};
	visitScript(parse(command), {
		state,
		source: command,
		depth: 0,
		upstream: [],
	});
	const message = state.errors[0];
	if (message !== undefined) return { kind: "unparseable", message };
	if (state.tooDeep) return { kind: "too-deep" };
	return { kind: "ok", invocations: state.invocations };
}
