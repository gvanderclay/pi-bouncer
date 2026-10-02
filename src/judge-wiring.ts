import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Ask } from "./ask.ts";
import { readGitState, readRemotes, remoteFacts } from "./facts.ts";
import type { Judge } from "./gate.ts";
import { type JudgeSent, recentEarlier, userTexts } from "./history.ts";
import { NOT_FOUND } from "./judge.ts";
import { judgeRequest } from "./judge-request.ts";
import type { ModeHolder } from "./mode.ts";
import {
	registryOf,
	type SessionState,
	SKILL,
	STATUS_KEY,
	showMode,
} from "./mode-switch.ts";
import { type Ruling, ruleLine, rulingFailures } from "./ruling.ts";

function showJudging(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", "🤖 judging…"));
}

function notifyFailures(
	result: Ruling,
	session: SessionState,
	ctx: ExtensionContext,
): void {
	const tried = rulingFailures(result);
	for (const { model, error } of tried) session.lastFailure.set(model, error);
	const fresh = tried.filter(({ model }) => !session.reported.has(model));
	for (const { model } of fresh) session.reported.add(model);
	if (!ctx.hasUI || fresh.length === 0) return;
	if (result.kind === "none") {
		const all = tried.map(({ model, error }) => `${model}: ${error}`);
		ctx.ui.notify(
			`Auto: no judge available (${all.join("; ")}). The ${SKILL} skill can fix the list.`,
			"warning",
		);
		return;
	}
	for (const { model, error } of fresh) {
		const gone =
			error === NOT_FOUND
				? `; it is not in Pi's model catalogue. The ${SKILL} skill can fix the list.`
				: "";
		ctx.ui.notify(
			`Auto: ${model} unavailable, using ${result.model}${gone}`,
			"warning",
		);
	}
}

export function judgeFor(
	command: string,
	ctx: ExtensionContext,
	holder: ModeHolder,
	session: SessionState,
	onSent: (sent: JudgeSent) => void = () => {},
): Judge {
	return async (asks: readonly Ask[]): Promise<Ruling> => {
		// A result that lands while Jev or the judge list is out reaches neither:
		// recording never changes an entry, so a shallow copy is a snapshot,
		// taken before the first await. `judgeRequest` applies the budgets.
		const history = [...session.history.entries];
		showJudging(ctx);
		try {
			const { cwd } = ctx;
			const [git, now, snapshot] = await Promise.all([
				readGitState(cwd),
				readRemotes(cwd),
				session.remotes ?? new Map<string, string>(),
			]);
			const texts = userTexts(ctx.sessionManager.getBranch?.() ?? []);
			// An empty last message gives no user_message: no fallback.
			const userMessage = texts.at(-1);
			const earlier = recentEarlier(
				texts.slice(0, -1).filter((text) => text !== ""),
			);
			const environment = session.config?.auto?.environment ?? [];
			const request = judgeRequest({
				command,
				asks,
				cwd,
				git,
				remotes: remoteFacts(snapshot, now),
				environment,
				earlierUserMessages: earlier,
				history,
				...(userMessage && { userMessage }),
			});
			onSent({
				history: request.history?.length ?? 0,
				earlierMessages: request.earlierUserMessages?.length ?? 0,
			});
			const run = {
				registry: registryOf(ctx),
				sessionId: ctx.sessionManager.getSessionId(),
				...(ctx.signal && { signal: ctx.signal }),
			};
			const auto = session.config?.auto;
			const result = await ruleLine(request, auto, ctx.model?.provider, run);
			notifyFailures(result, session, ctx);
			return result;
		} finally {
			showMode(holder, session, ctx);
		}
	};
}
