// The language a room reply is held to (ISS-1377, FB-789): the language the room is answered in. The
// person's own message decides first, then the language the room's persona names, then what the
// room's people wrote. The project's content language is for Forge's records and never decides it:
// a project writing its records in English still answers a Vietnamese member in Vietnamese.

import {
  askerLanguageOf,
  hasVietnameseOnlyWord,
  type ReplyLanguage,
  readsVietnameseBesideNames,
  roomTextsLanguageOf,
} from '../../conversations/index.js';

/** Where the answering language was read: the message answered, the persona, or the room's texts. */
export type AnsweringFrom = 'asker' | 'persona' | 'room';

export interface AnsweringLanguage {
  language: ReplyLanguage;
  from: AnsweringFrom;
  /**
   * Where the asker could not be told, the language the asked message itself reads in: Vietnamese
   * where it spells a Vietnamese-only letter or word, else English where it carries no Vietnamese
   * mark. A reply matching it is not failed for differing from the room's (ISS-1442).
   */
  askedAs?: ReplyLanguage;
}

/** How a persona names each language, in English or in Vietnamese. */
const NAMED: Readonly<Record<ReplyLanguage, RegExp>> = {
  vi: /\bvietnamese\b|tiếng việt|tieng viet/iu, // i18n-allow: a persona naming Vietnamese
  en: /\benglish\b|tiếng anh|tieng anh/iu, // i18n-allow: a persona naming English
};

/** The one language a persona names, or null where it names none or both. */
export function personaLanguageOf(persona: string | null | undefined): ReplyLanguage | null {
  if (!persona) return null;
  const named = (Object.keys(NAMED) as ReplyLanguage[]).filter((l) => NAMED[l].test(persona));
  return named.length === 1 ? (named[0] ?? null) : null;
}

/** English where the message has two words or more and none carries a Vietnamese mark; "ok" alone reads as either. */
function englishAsked(asked: string | null): ReplyLanguage | undefined {
  const words = (asked ?? '').match(/\p{L}+/gu) ?? [];
  return words.length >= 2 && !readsVietnameseBesideNames(asked) ? 'en' : undefined;
}

/**
 * The language the room answers in: the one `asked` (the message the reply answers) was written in,
 * else the one the persona names, else Vietnamese where a text the room's people wrote reads
 * Vietnamese, else English.
 */
export function answeringLanguageOf(input: {
  asked: string | null;
  persona: string | null;
  texts: readonly string[];
}): AnsweringLanguage {
  const asker = askerLanguageOf(input.asked);
  if (asker) return { language: asker, from: 'asker' };
  const askedAs: ReplyLanguage | undefined = hasVietnameseOnlyWord(input.asked)
    ? 'vi'
    : englishAsked(input.asked);
  const persona = personaLanguageOf(input.persona);
  if (persona) return { language: persona, from: 'persona', ...(askedAs && { askedAs }) };
  return { language: roomTextsLanguageOf(input.texts), from: 'room', ...(askedAs && { askedAs }) };
}
