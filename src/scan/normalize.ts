/**
 * The name rules compare against: the basename of the command word's dequoted
 * value, so `/bin/rm` and `./rm` are `rm`. unbash has already removed quotes
 * and backslashes (`\rm`, `'rm'`).
 */
export function commandName(value: string): string {
	return value.slice(value.lastIndexOf("/") + 1);
}
