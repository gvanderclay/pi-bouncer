export type Four = {
	readonly effect: {
		readonly routine: number;
		readonly destroys_or_shared: number;
		readonly harmful: number;
		readonly other: number;
	};
	readonly created: number;
	readonly user_intent: {
		readonly asked_for_this: number;
		readonly asked_to_keep: number;
		readonly no_explicit_request: number;
	};
	readonly risky_target: number;
};

/** Four answers whose deny score is `deny`: routine work, up to `deny` destructive. */
export function fourFor(deny: number): Four {
	return {
		effect: {
			routine: 1 - deny,
			destroys_or_shared: deny,
			harmful: 0,
			other: 0,
		},
		created: 0,
		user_intent: {
			asked_for_this: 0,
			asked_to_keep: 0,
			no_explicit_request: 1,
		},
		risky_target: 0,
	};
}

export function answersFor(
	safe: number,
	four: Four,
	confidence: number,
): Record<string, object> {
	const choice = (probabilities: Record<string, number>): object => ({
		type: "choice",
		choice: Object.entries(probabilities).sort(([, a], [, b]) => b - a)[0]?.[0],
		probabilities,
		confidence,
	});
	return {
		safety: choice({ safe, unsafe: 1 - safe }),
		effect: choice(four.effect),
		created: { type: "noul", noul: four.created },
		user_intent: choice(four.user_intent),
		risky_target: { type: "noul", noul: four.risky_target },
	};
}

export function replyWith(safe: number, four: Four, confidence = 0.8): string {
	return JSON.stringify({
		model: "jev-1.13",
		answers: answersFor(safe, four, confidence),
	});
}

export function jevReply(safe: number, deny: number, confidence = 0.8): string {
	return replyWith(safe, fourFor(deny), confidence);
}

export type FileLabels = {
	readonly kind?: "source_code" | "config" | "secrets" | "docs" | "data";
	readonly contains_secret?: number;
	readonly effect?: keyof Four["effect"];
	readonly user_intent?: keyof Four["user_intent"];
};

/** A file-call reply where each choice puts probability 1 on its label. */
export function fileJevReply(labels: FileLabels, confidence = 0.8): string {
	const choice = (names: readonly string[], picked: string): object => ({
		type: "choice",
		choice: picked,
		probabilities: Object.fromEntries(
			names.map((name) => [name, name === picked ? 1 : 0]),
		),
		confidence,
	});
	const kinds = ["source_code", "config", "secrets", "docs", "data"];
	const effects = ["routine", "destroys_or_shared", "harmful", "other"];
	const intents = ["asked_for_this", "asked_to_keep", "no_explicit_request"];
	return JSON.stringify({
		model: "jev-1.13",
		answers: {
			kind: choice(kinds, labels.kind ?? "config"),
			contains_secret: { type: "noul", noul: labels.contains_secret ?? 0 },
			effect: choice(effects, labels.effect ?? "routine"),
			user_intent: choice(intents, labels.user_intent ?? "no_explicit_request"),
		},
	});
}
