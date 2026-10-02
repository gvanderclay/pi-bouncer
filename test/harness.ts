// Drives the bouncer through its one seam: the handlers it registers with Pi,
// `tool_call` above all.
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createEventBus,
	type EventBus,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import bouncer, { type ParserLoader } from "../src/index.ts";
import { createModeHolder, type ModeHolder } from "../src/mode.ts";

export type Handler = (
	event: ToolCallEvent,
	ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined;

export type SessionReason = "startup" | "reload" | "new" | "resume" | "fork";

export type ToolResultMessage = {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: readonly { type: string; text?: string }[];
	readonly isError: boolean;
	readonly timestamp: number;
};

/** What a `message_end` handler returned: a replacement, or nothing. */
export type MessageEndResult = { readonly message?: unknown } | undefined;

export type LoadedGate = {
	readonly handler: Handler;
	/** The bouncer's log directory: a fresh temp path unless one was given. */
	readonly logDir: string;
	/** The bouncer's agent dir: a fresh temp path, never the real route's. */
	readonly agentDir: string;
	/**
	 * Writes the route's bouncer config, `<agentDir>/bouncer.json`: a
	 * string as is, anything else as JSON. It applies from the next session start.
	 */
	readonly writeRouteConfig: (config: unknown) => void;
	/** Every record in the bouncer's `log.jsonl`, parsed; none if it is absent. */
	readonly records: () => LogRecord[];
	/**
	 * Fires the `session_start` handler the bouncer registered, if any, with
	 * `ctx` (by default a UI-less context in /work).
	 */
	readonly startSession: (
		reason: SessionReason,
		ctx?: ExtensionContext,
	) => Promise<void>;
	/** Fires the `message_end` handler the bouncer registered, if any. */
	readonly endMessage: (message: unknown) => Promise<MessageEndResult>;
	/**
	 * Fires the `tool_result` handler the bouncer registered, as Pi does once
	 * an executed call finishes, with `ctx` (by default UI-less, in /work).
	 * Returns what the handler returned.
	 */
	readonly finishTool: (
		event: ToolResultEvent,
		ctx?: ExtensionContext,
	) => Promise<unknown>;
	/**
	 * Runs the slash command `name` the bouncer registered with `args`, as the
	 * user typing `/name args` does, with `ctx` (by default UI-less).
	 */
	readonly runCommand: (
		name: string,
		args?: string,
		ctx?: ExtensionContext,
	) => Promise<void>;
	/** The bouncer-mode holder this load was given. */
	readonly mode: ModeHolder;
	/**
	 * The bouncer's event bus: how a test emits a hook, as the provider would.
	 * `emit` runs every listener's synchronous code before it returns.
	 */
	readonly events: EventBus;
};

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

/** What a test can pass to `loadGateSession` beyond the parser and log dir. */
export type GateOptions = {
	/** An existing holder, to load the bouncer again as `/reload` does. */
	readonly mode?: ModeHolder;
	/** The CLI flags `pi.getFlag` returns, as `pi --yolo` would set them. */
	readonly flags?: Readonly<Record<string, boolean | string>>;
};

type SessionHandler = (
	event: { type: "session_start"; reason: SessionReason },
	ctx: ExtensionContext,
) => unknown;

type MessageEndHandler = (event: {
	type: "message_end";
	message: unknown;
}) => MessageEndResult | Promise<MessageEndResult>;

type ToolResultHandler = (
	event: ToolResultEvent,
	ctx: ExtensionContext,
) => unknown;

/** How a built tool result ended, and the output text it carries. */
export type ResultOptions = {
	readonly isError?: boolean;
	/** The result's output text, where a test plants markers. */
	readonly text?: string;
	readonly id?: string;
};

/** The `tool_result` event Pi fires once `toolName` ran with `input`. */
export function toolResult(
	toolName: string,
	input: Record<string, unknown>,
	{ isError = false, text = "", id = "t1" }: ResultOptions = {},
): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: id,
		toolName,
		input,
		content: [{ type: "text", text }],
		isError,
		details: undefined,
	} as ToolResultEvent;
}

/** A finished bash call; `background` is set as pi-bg-bash's input sets it. */
export function bashResult(
	command: string,
	options: ResultOptions & { readonly background?: boolean } = {},
): ToolResultEvent {
	const input = options.background
		? { command, background: true }
		: { command };
	return toolResult("bash", input, options);
}

/** A finished `write` of `content` to `path`. */
export function writeResult(
	path: string,
	content: string,
	options: ResultOptions = {},
): ToolResultEvent {
	return toolResult("write", { path, content }, options);
}

/** A finished `edit` of `path` replacing `oldText` with `newText`. */
export function editResult(
	path: string,
	newText: string,
	options: ResultOptions = {},
): ToolResultEvent {
	const edits = [{ oldText: "before", newText }];
	return toolResult("edit", { path, edits }, options);
}

/** The tool result Pi records for a call aborted after `tool_call`. */
export function abortedResult(toolCallId = "t1"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "Operation aborted" }],
		isError: true,
		timestamp: 1,
	};
}

/** One parsed line of the bouncer log; which fields exist depends on `type`. */
export type LogRecord = {
	readonly v?: unknown;
	readonly type?: unknown;
	readonly time?: unknown;
	readonly sessionId?: unknown;
	readonly sessionFile?: unknown;
	readonly cwd?: unknown;
	readonly reason?: unknown;
	readonly parser?: unknown;
	readonly config?: unknown;
	readonly command?: unknown;
	readonly ui?: unknown;
	readonly outcome?: unknown;
	readonly matches?: unknown;
	readonly asks?: unknown;
	readonly on?: unknown;
	readonly how?: unknown;
	readonly yolo?: unknown;
	readonly withoutYolo?: unknown;
	readonly auto?: unknown;
	readonly withoutAuto?: unknown;
};

// Every bouncer's log and agent dir live below one temp root, removed when the
// process exits, so no test reads a real route's config or writes its log.
let tempRoot: string | undefined;
let tempCount = 0;

/** A fresh, not yet created directory named `name` below the temp root. */
function tempDir(name: string): string {
	if (!tempRoot) {
		const root = mkdtempSync(join(tmpdir(), "pi-gate-log-"));
		tempRoot = root;
		process.on("exit", () => rmSync(root, { recursive: true, force: true }));
	}
	tempCount += 1;
	return join(tempRoot, `gate-${tempCount}`, name);
}

/** A fresh, not yet created log directory below the temp root. */
export function tempLogDir(): string {
	return tempDir("pi-bouncer");
}

/** A fresh, not yet created agent dir below the temp root. */
export function tempAgentDir(): string {
	return tempDir("agent");
}

/** A fresh, not yet created project directory below the temp root. */
export function tempProjectDir(): string {
	return tempDir("project");
}

/** A project's bouncer config path, `<cwd>/.pi/extensions/bouncer/config.json`; written out here so the tests pin it apart from project-config.ts. */
export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "extensions", "bouncer", "config.json");
}

/**
 * Writes a project's bouncer config,
 * `<cwd>/.pi/extensions/bouncer/config.json`.
 */
export function writeProjectConfig(cwd: string, config: unknown): void {
	writeConfig(projectConfigPath(cwd), config);
}

/** Writes a project config at the old path, `<cwd>/.pi/bouncer.json`. */
export function writeOldProjectConfig(cwd: string, config: unknown): void {
	writeConfig(join(cwd, ".pi", "bouncer.json"), config);
}

/** Writes `config` to `path` (a string as is, else as JSON), creating dirs. */
export function writeConfig(path: string, config: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const text = typeof config === "string" ? config : JSON.stringify(config);
	writeFileSync(path, text);
}

export function readRecords(logDir: string): LogRecord[] {
	let text: string;
	try {
		text = readFileSync(join(logDir, "log.jsonl"), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as LogRecord);
}

/**
 * Loads the bouncer with a fresh temp log directory, or `logDir` when given;
 * `null` lets the bouncer pick its default from the environment. The agent dir
 * is always a fresh temp path.
 */
export async function loadGateSession(
	loadParser?: ParserLoader,
	logDir: string | null = tempLogDir(),
	options: GateOptions = {},
): Promise<LoadedGate> {
	const agentDir = tempAgentDir();
	const mode = options.mode ?? createModeHolder();
	let handler: Handler | undefined;
	let sessionHandler: SessionHandler | undefined;
	let messageEndHandler: MessageEndHandler | undefined;
	let resultHandler: ToolResultHandler | undefined;
	const commands = new Map<string, CommandHandler>();
	const registered = new Set<string>();
	const events = createEventBus();
	const pi = {
		events,
		on(
			event: string,
			fn: Handler & SessionHandler & MessageEndHandler & ToolResultHandler,
		): void {
			if (event === "tool_call") handler = fn;
			if (event === "session_start") sessionHandler = fn;
			if (event === "message_end") messageEndHandler = fn;
			if (event === "tool_result") resultHandler = fn;
		},
		registerCommand(name: string, command: { handler: CommandHandler }): void {
			commands.set(name, command.handler);
		},
		registerFlag(name: string): void {
			registered.add(name);
		},
		// Like Pi's, only a registered flag has a value.
		getFlag: (name: string): boolean | string | undefined =>
			registered.has(name) ? options.flags?.[name] : undefined,
	};
	await bouncer(
		pi as unknown as ExtensionAPI,
		loadParser,
		logDir ?? undefined,
		agentDir,
		mode,
	);
	if (!handler) throw new Error("the bouncer registered no tool_call handler");
	const dir = logDir ?? "";
	return {
		handler,
		logDir: dir,
		agentDir,
		writeRouteConfig: (config: unknown): void =>
			writeConfig(join(agentDir, "bouncer.json"), config),
		records: (): LogRecord[] => readRecords(dir),
		startSession: async (
			reason: SessionReason,
			ctx: ExtensionContext = fakeContext(),
		): Promise<void> => {
			await sessionHandler?.({ type: "session_start", reason }, ctx);
		},
		endMessage: async (message: unknown): Promise<MessageEndResult> =>
			await messageEndHandler?.({ type: "message_end", message }),
		finishTool: async (
			event: ToolResultEvent,
			ctx: ExtensionContext = fakeContext(),
		): Promise<unknown> => {
			if (!resultHandler) {
				throw new Error("the bouncer registered no tool_result handler");
			}
			return await resultHandler(event, ctx);
		},
		runCommand: async (
			name: string,
			args = "",
			ctx: ExtensionContext = fakeContext(),
		): Promise<void> => {
			const command = commands.get(name);
			if (!command)
				throw new Error(`the bouncer registered no /${name} command`);
			await command(args, ctx);
		},
		mode,
		events,
	};
}

export async function loadGate(loadParser?: ParserLoader): Promise<Handler> {
	return (await loadGateSession(loadParser)).handler;
}

export type Notice = { readonly message: string; readonly level: string };

/** The footer statuses set through `ctx.ui.setStatus`, by key. */
export type Statuses = Record<string, string | undefined>;

/**
 * The part of Pi's theme the bouncer styles text with, writing each style as
 * markup (`<error>…</error>`, `<b>…</b>`) so a test can see it.
 */
export const markupTheme = {
	fg: (color: string, text: string): string => `<${color}>${text}</${color}>`,
	bold: (text: string): string => `<b>${text}</b>`,
};

export const SESSION_ID = "session-1";
export const SESSION_FILE = "/sessions/session-1.jsonl";

/** The part of Pi's session manager the bouncer reads. */
export function sessionManager(
	id = SESSION_ID,
	file: string | undefined = SESSION_FILE,
): { getSessionId(): string; getSessionFile(): string | undefined } {
	return { getSessionId: () => id, getSessionFile: () => file };
}

/**
 * A context without a UI. `trusted` backs `isProjectTrusted()`; like Pi for a
 * folder that needs no trust decision, it defaults to trusted.
 */
export function fakeContext(cwd = "/work", trusted = true): ExtensionContext {
	return {
		hasUI: false,
		cwd,
		isProjectTrusted: (): boolean => trusted,
		sessionManager: sessionManager(),
	} as unknown as ExtensionContext;
}

/** A UI context that records notices; `trusted` as in `fakeContext`. */
export function uiContext(
	cwd = "/work",
	trusted = true,
): {
	ctx: ExtensionContext;
	notices: Notice[];
	statuses: Statuses;
} {
	const notices: Notice[] = [];
	const statuses: Statuses = {};
	const ui = {
		notify(message: string, level: string): void {
			notices.push({ message, level });
		},
		setStatus(key: string, text: string | undefined): void {
			statuses[key] = text;
		},
		theme: markupTheme,
	};
	const ctx = {
		hasUI: true,
		ui,
		cwd,
		isProjectTrusted: (): boolean => trusted,
		sessionManager: sessionManager(),
	};
	return { ctx: ctx as unknown as ExtensionContext, notices, statuses };
}

export type DialogOptions = { readonly signal?: AbortSignal; timeout?: number };

export type DialogCall = {
	readonly kind: "select" | "input";
	readonly title: string;
	readonly options: readonly string[] | string | undefined;
	readonly opts: DialogOptions | undefined;
};

export type ScriptedUI = {
	readonly ctx: ExtensionContext;
	readonly notices: Notice[];
	readonly statuses: Statuses;
	readonly dialogs: DialogCall[];
	readonly aborts: { count: number };
	readonly signal: AbortSignal;
	/** Aborts `signal`, as Ctrl-C does to the turn. */
	readonly cancelTurn: () => void;
};

/**
 * A UI context whose dialogs answer from a script: each `select` or `input`
 * call takes the next answer in order (a string, or `undefined` for Escape).
 * Running out of answers fails the test.
 */
export function scriptedUI(
	answers: readonly (string | undefined)[] = [],
	cwd = "/work",
): ScriptedUI {
	const queue = [...answers];
	const notices: Notice[] = [];
	const statuses: Statuses = {};
	const dialogs: DialogCall[] = [];
	const aborts = { count: 0 };
	const controller = new AbortController();
	const { signal } = controller;
	const answer = (call: DialogCall): Promise<string | undefined> => {
		dialogs.push(call);
		if (queue.length === 0) throw new Error(`unscripted ${call.kind}`);
		return Promise.resolve(queue.shift());
	};
	const ui = {
		notify(message: string, level: string): void {
			notices.push({ message, level });
		},
		setStatus(key: string, text: string | undefined): void {
			statuses[key] = text;
		},
		theme: markupTheme,
		select: (
			title: string,
			options: string[],
			opts?: DialogOptions,
		): Promise<string | undefined> =>
			answer({ kind: "select", title, options, opts }),
		input: (
			title: string,
			placeholder?: string,
			opts?: DialogOptions,
		): Promise<string | undefined> =>
			answer({ kind: "input", title, options: placeholder, opts }),
	};
	const ctx = {
		hasUI: true,
		ui,
		cwd,
		signal,
		isProjectTrusted: (): boolean => true,
		sessionManager: sessionManager(),
		// Like Pi's, the real abort waits for idle; this one never settles, so a
		// handler that awaited it would hang the test.
		abort(): Promise<never> {
			aborts.count += 1;
			return new Promise<never>(() => {});
		},
	};
	return {
		ctx: ctx as unknown as ExtensionContext,
		notices,
		statuses,
		dialogs,
		aborts,
		signal,
		cancelTurn: (): void => controller.abort(),
	};
}

export function toolCall(
	toolName: string,
	input: Record<string, unknown>,
): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "t1",
		toolName,
		input,
	} as ToolCallEvent;
}

export function bashCall(command: string): ToolCallEvent {
	return toolCall("bash", { command });
}

// The quoted command in a reason: the text between "Command: `" and "`.".
function quotedCommand(reason: string): string | undefined {
	return /Command: `([\s\S]*)`\./.exec(reason)?.[1];
}

/**
 * Asserts a rule deny when no one can be asked (no UI), where ask and deny
 * rules block alike: blocked with the rule marker and the retry warning, and
 * `terminate` unset. The quoted command must equal `quote` when given, and
 * otherwise appear in the input. Levels are pinned in `levels.test.ts`.
 */
export async function expectDeny(
	command: string,
	rule: string,
	quote?: string,
): Promise<void> {
	const handler = await loadGate();
	const result = await handler(bashCall(command), fakeContext());
	const reason = result?.reason ?? "";
	assert.equal(result?.block, true, `expected ${command} to be blocked`);
	assert.ok(reason.includes(`(rule: ${rule})`), reason);
	assert.match(reason, /Do not retry/);
	const quoted = quotedCommand(reason);
	if (quote !== undefined) assert.equal(quoted, quote);
	else assert.ok(quoted && command.includes(quoted), reason);
	assert.equal(result?.terminate, undefined);
}

/** Asserts the handler returns nothing and notifies nothing. */
export async function expectAllow(command: string): Promise<void> {
	const handler = await loadGate();
	const { ctx, notices } = uiContext();
	const result = await handler(bashCall(command), ctx);
	assert.equal(
		result,
		undefined,
		`expected ${command} to be allowed: ${result?.reason}`,
	);
	assert.equal(notices.length, 0);
}

/** What a scripted model sends back for one call. */
export type ModelReply =
	/** A text reply with stop reason `stop`. */
	| string
	/** A reply with stop reason `error` and this message. */
	| { readonly error: string }
	/**
	 * A usage-policy refusal as Pi's Anthropic adapter reports it: stop reason
	 * `error`, raw stop reason `refusal`, no content, and this message.
	 */
	| { readonly refuses: string }
	/** `result()` rejects with this message. */
	| { readonly throws: string }
	/** Never answers; aborting the call's signal ends it as `aborted`. */
	| "hang"
	/** Answers with whatever the promise gives, unless the call is aborted first. */
	| { readonly later: Promise<ModelReply> };

/** One scripted model: what `find` returns for it and how it answers. */
export type ModelScript = {
	readonly reasoning?: boolean;
	readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
	/** Whether `hasConfiguredAuth` holds; true unless set. */
	readonly auth?: boolean;
	/**
	 * The reply to every call, or one per call in order (the last repeats), or
	 * a reply worked out from the judge input of each call.
	 */
	readonly reply:
		| ModelReply
		| readonly ModelReply[]
		| ((input: string) => ModelReply);
};

/** One call the fake registry saw. */
export type ModelRequest = {
	readonly model: string;
	readonly sessionId: unknown;
	readonly reasoning: unknown;
	readonly systemPrompt: string;
	readonly input: string;
	readonly signal: AbortSignal | undefined;
};

export type FakeRegistry = {
	readonly registry: unknown;
	/** Every model call, in order. */
	readonly requests: ModelRequest[];
	/** Every `find` lookup, as `provider/id`. */
	readonly finds: string[];
};

type FakeModel = {
	id: string;
	provider: string;
	reasoning: boolean;
	thinkingLevelMap?: Readonly<Record<string, string | null>>;
};

type FakeMessage = {
	role: "assistant";
	content: { type: "text"; text: string }[];
	stopReason: string;
	errorMessage?: string;
	rawStopReason?: string;
};

function message(
	text: string,
	stopReason = "stop",
	error?: string,
): FakeMessage {
	const base: FakeMessage = {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		stopReason,
	};
	return error === undefined ? base : { ...base, errorMessage: error };
}

const ABORTED = message("", "aborted", "Request was aborted");

// Settles like pi-ai's streams: an abort ends the call as `aborted`.
function settle(reply: ModelReply, signal?: AbortSignal): Promise<FakeMessage> {
	if (signal?.aborted) return Promise.resolve(ABORTED);
	if (typeof reply === "string" && reply !== "hang") {
		return Promise.resolve(message(reply));
	}
	if (typeof reply === "object" && "error" in reply) {
		return Promise.resolve(message("", "error", reply.error));
	}
	if (typeof reply === "object" && "refuses" in reply) {
		const refused = message("", "error", reply.refuses);
		return Promise.resolve({ ...refused, rawStopReason: "refusal" });
	}
	if (typeof reply === "object" && "throws" in reply) {
		return Promise.reject(new Error(reply.throws));
	}
	return new Promise<FakeMessage>((resolve, reject) => {
		signal?.addEventListener("abort", () => resolve(ABORTED), { once: true });
		if (typeof reply === "object") {
			reply.later.then((next) => settle(next, signal)).then(resolve, reject);
		}
	});
}

/**
 * A fake `ctx.modelRegistry` whose models are scripted by `provider/id`; an
 * entry absent from `models` is missing from `find`. It never touches a
 * network or `auth.json`.
 */
export function fakeRegistry(
	models: Readonly<Record<string, ModelScript>> = {},
	/** The key `getApiKeyForProvider` gives for each provider; none unless set. */
	keys: Readonly<Record<string, string>> = {},
): FakeRegistry {
	const requests: ModelRequest[] = [];
	const finds: string[] = [];
	const calls = new Map<string, number>();
	const registry = {
		find(provider: string, id: string): FakeModel | undefined {
			finds.push(`${provider}/${id}`);
			const script = models[`${provider}/${id}`];
			if (!script) return undefined;
			const model = { id, provider, reasoning: script.reasoning ?? false };
			const { thinkingLevelMap } = script;
			return thinkingLevelMap ? { ...model, thinkingLevelMap } : model;
		},
		hasConfiguredAuth(model: FakeModel): boolean {
			return models[`${model.provider}/${model.id}`]?.auth ?? true;
		},
		getApiKeyForProvider(provider: string): Promise<string | undefined> {
			return Promise.resolve(keys[provider]);
		},
		streamSimple(
			model: FakeModel,
			context: { systemPrompt: string; messages: { content: string }[] },
			options: { sessionId?: string; reasoning?: string; signal?: AbortSignal },
		): { result(): Promise<FakeMessage> } {
			const key = `${model.provider}/${model.id}`;
			const input = context.messages.map((m) => m.content).join("\n");
			requests.push({
				model: key,
				sessionId: options.sessionId,
				reasoning: options.reasoning,
				systemPrompt: context.systemPrompt,
				input,
				signal: options.signal,
			});
			const count = calls.get(key) ?? 0;
			calls.set(key, count + 1);
			const script = models[key];
			const replies = script?.reply ?? "";
			let reply: ModelReply;
			if (typeof replies === "function") reply = replies(input);
			else if (Array.isArray(replies)) {
				reply = replies[Math.min(count, replies.length - 1)] as ModelReply;
			} else reply = replies as ModelReply;
			const settled = settle(reply, options.signal);
			return { result: (): Promise<FakeMessage> => settled };
		},
	};
	return { registry, requests, finds };
}

/** `ctx` with `registry` as its `modelRegistry`. */
export function withRegistry(
	ctx: ExtensionContext,
	fake: FakeRegistry,
): ExtensionContext {
	return {
		...(ctx as object),
		modelRegistry: fake.registry,
	} as unknown as ExtensionContext;
}

/** A judge reply as the prompt asks for it. */
export function verdict(verdict: string, reason: string): string {
	return JSON.stringify({ verdict, reason });
}

/** `ctx` whose session manager's current branch holds `entries`. */
export function withBranch(
	ctx: ExtensionContext,
	entries: readonly unknown[],
): ExtensionContext {
	const manager = {
		...sessionManager(),
		getBranch: (): unknown[] => [...entries],
	};
	return {
		...(ctx as object),
		sessionManager: manager,
	} as unknown as ExtensionContext;
}

/** A session branch entry holding one message. */
export function messageEntry(message: object): object {
	return { type: "message", id: "e", parentId: null, timestamp: "", message };
}
