// The indefinite article a sentence writes before a value it interpolates. A value read from a type,
// a kind or a status can begin with a vowel sound, so "a" written by hand before it reads "a object",
// "a issue" or "a HTML mockup". Every sentence that puts an article before an interpolated value takes
// it from here.

/** Letters whose spoken name begins with a vowel sound: "an F", "an HTML", "an RFI", "an SMS". */
const VOWEL_NAMED_LETTERS = "AEFHILMNORSX";

/** Words spelt with a vowel that are said with a consonant first: "a unit", "a user", "a one". */
const SAID_WITH_A_CONSONANT = /^(uni|use|usu|uti|ure|uro|eu|ewe|one(\b|[^a-z])|once)/i;

/** Words spelt with an h that is not said: "an hour", "an honest". */
const SILENT_H = /^(hour|honest|honou?r|heir)/i;

/**
 * Read letter by letter: written in capitals ("RFI", "HTML", "UI"), or with no vowel letter in its
 * first part ("html", "mcp", "sms"), where there is nothing to say but the letters.
 */
function readAsLetters(head: string): boolean {
	if (head.length >= 2 && head === head.toUpperCase() && /[A-Z]/.test(head)) return true;
	return /^[a-z]+$/i.test(head) && !/[aeiouy]/i.test(head);
}

/**
 * "an" where the word is said starting with a vowel sound, else "a". A number is said as a number:
 * "an 8", "an 11", "an 18", "an 80", "a 100".
 */
export function articleFor(word: string): "a" | "an" {
	const w = word.trim();
	if (w === "") return "a";
	if (/^\d/.test(w)) return /^(8|1[18](\d{3})*(?!\d))/.test(w) ? "an" : "a";
	const head = w.split(/[\s_\-./:]/)[0] ?? w;
	if (readAsLetters(head)) return VOWEL_NAMED_LETTERS.includes(head[0]?.toUpperCase() ?? "") ? "an" : "a";
	if (SAID_WITH_A_CONSONANT.test(w)) return "a";
	if (SILENT_H.test(w)) return "an";
	return /^[aeiou]/i.test(w) ? "an" : "a";
}

/** The word with its indefinite article: "an issue", "a list", "an RFI", "a unit". */
export function withArticle(word: string): string {
	return `${articleFor(word)} ${word}`;
}

/**
 * What a value is, by its JavaScript type, with its article, for a sentence saying what arrived:
 * "an object", "a list", "a string", "a number", "null". Never `a ${typeof value}`, which reads
 * "a object" and "a undefined".
 */
export function typeWithArticle(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "a list";
	return withArticle(typeof value);
}
