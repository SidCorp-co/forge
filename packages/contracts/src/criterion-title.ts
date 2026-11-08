// A criterion's short title (ISS-1131, FB-567 point 3): a row shows it, and its full sentence opens on
// demand. A requirement criterion and an issue criterion each take an optional `title` of at most
// eight words, refused by name over that (CRITERION_TITLE_TOO_LONG); the tables hold the same rule
// (migration 0634). A criterion with no title shows its first clause, cut at a word boundary.

import { z } from "zod";

/** The most words a criterion's title holds. */
export const CRITERION_TITLE_MAX_WORDS = 8;

/** A title's words, as the check constraint splits them: runs of non-space. */
export const titleWords = (title: string): string[] =>
	title.trim().split(/\s+/).filter(Boolean);

/** The wire shape: a trimmed title, `null` to clear it; its word count is refused by name, not here. */
export const criterionTitleSchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.nullable()
	.optional();

/** Why `title` cannot be kept, or null: more than eight words. */
export function criterionTitleFault(
	title: string | null | undefined,
): string | null {
	if (title === null || title === undefined) return null;
	const n = titleWords(title).length;
	if (n <= CRITERION_TITLE_MAX_WORDS) return null;
	return `a criterion's title holds at most ${CRITERION_TITLE_MAX_WORDS} words; "${title}" has ${n}. Put the rest in the criterion's sentence, which opens under its title.`;
}

/** How long a first clause shown in place of a title may run, in words and characters, before it is cut. */
const CLAUSE_MAX_WORDS = 10;
const CLAUSE_MAX_CHARS = 72;

/**
 * What a criterion's row shows: its title, else its first clause (up to the first comma, colon,
 * semicolon, dash or sentence end), cut at a word boundary with an ellipsis where it runs past ten
 * words or 72 characters, never inside a word. `cut` says whether anything of the sentence was left
 * out, so the row offers the whole sentence on demand.
 */
export function criterionShortTitle(c: {
	title?: string | null | undefined;
	text: string;
}): { short: string; cut: boolean } {
	const whole = c.text.trim().replace(/\s+/g, " ");
	if (c.title) return { short: c.title, cut: c.title !== whole };
	const clause = whole.split(/(?<=\S)(?:[,;:]\s|\s[–—-]\s|\.\s)/)[0] ?? whole;
	const words = clause.split(" ");
	let short = "";
	for (const [i, w] of words.entries()) {
		const next = short ? `${short} ${w}` : w;
		if (i >= CLAUSE_MAX_WORDS || (short && next.length > CLAUSE_MAX_CHARS))
			break;
		short = next;
	}
	// a sentence of one clause that fits reads whole, its full stop kept: nothing was left out
	if (short === whole) return { short: whole, cut: false };
	const kept = short.replace(/[.,;:]$/, "");
	if (short === clause) return { short: kept, cut: true };
	return { short: `${kept}…`, cut: true };
}
