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
