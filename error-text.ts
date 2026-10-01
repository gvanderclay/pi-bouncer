/** The message of a thrown `Error`, or else the thrown value as a string. */
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
