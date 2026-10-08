// The language a person or a model wrote a text in (issue titles and bodies, feedback, comments,
// requirement revisions, harness reports), stored beside the text so a reader in another language
// sees it marked as written, never machine-translated in silence. Null is a text written before the
// language was stored: it shows as written with no mark, and no language is guessed for it.

import { z } from "zod";
import { SCRIPT_CHECK_MIN_WORDS, VIETNAMESE_LETTER } from "./content-language.js";

export const WRITTEN_LANGS = ["en", "vi"] as const;
export type WrittenLang = (typeof WRITTEN_LANGS)[number];

/** What a writer may declare it wrote in: a value outside the list is refused by name, never coerced. */
export const writtenLangSchema = z.enum(WRITTEN_LANGS, {
	error: (issue) =>
		`WRITTEN_LANG_INVALID: writtenLang must be one of ${WRITTEN_LANGS.join(", ")}; got ${JSON.stringify(issue.input)}`,
});

export const WRITTEN_LANG_SHAPE = `writtenLang?: ${WRITTEN_LANGS.join(" | ")}`;

// English words that carry a sentence; prose of a Latin script with none of them is not read as English
const ENGLISH_FUNCTION_WORD = /^(the|a|an|is|are|was|were|of|to|in|on|for|and|or|but|not|no|it|its|this|that|with|from|by|be|as|at|so|if|has|have|had|does|do|can|cannot|when|which|who|what)$/i;

/**
 * What a text's own letters settle about the language it was written in, or null where they settle
 * nothing. A Vietnamese letter (đ, a vowel or tone mark) is Vietnamese, as English never spells with
 * one. Prose of at least `SCRIPT_CHECK_MIN_WORDS` words with no Vietnamese letter is not Vietnamese
 * (the content-language script rule, `contentLanguageScriptWarning`), and is English only where at
 * least two of its words are English function words. Short or wordless text settles nothing.
 */
export function writtenLangOfText(text: string | null | undefined): WrittenLang | null {
	const words = (text ?? "").split(/\s+/).filter((w) => /\p{L}/u.test(w));
	if (words.length === 0) return null;
	if (VIETNAMESE_LETTER.test(text ?? "")) return "vi";
	if (words.length < SCRIPT_CHECK_MIN_WORDS) return null;
	const english = words.filter((w) => ENGLISH_FUNCTION_WORD.test(w.replace(/[^\p{L}]/gu, ""))).length;
	return english >= 2 ? "en" : null;
}

/** The written language a BCP-47 tag names (`vi-VN` is `vi`), or null for a language not in the list. */
export function writtenLangOfTag(tag: string | null | undefined): WrittenLang | null {
	const base = (tag ?? "").toLowerCase().split("-")[0];
	return (WRITTEN_LANGS as readonly string[]).includes(base ?? "") ? (base as WrittenLang) : null;
}
