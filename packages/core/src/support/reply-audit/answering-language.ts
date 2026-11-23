// The language a room reply is held to (ISS-1377, FB-789): the language the room is answered in. The
// person's own message decides first, then the language the room's persona names, then what the
// room's people wrote. The project's content language is for Forge's records and never decides it:
// a project writing its records in English still answers a Vietnamese member in Vietnamese.

import {
  askerLanguageOf,
  hasVietnameseOnlyLetter,
  type ReplyLanguage,
  roomTextsLanguageOf,
} from '../../conversations/index.js';

/** Where the answering language was read: the message answered, the persona, or the room's texts. */
export type AnsweringFrom = 'asker' | 'persona' | 'room';

export interface AnsweringLanguage {
  language: ReplyLanguage;
  from: AnsweringFrom;
  /** Where the asker could not be told: Vietnamese where the asked message spells a Vietnamese-only letter, which a reply is not failed for matching. */
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
  const askedAs: ReplyLanguage | undefined = hasVietnameseOnlyLetter(input.asked)
    ? 'vi'
    : undefined;
  const persona = personaLanguageOf(input.persona);
  if (persona) return { language: persona, from: 'persona', ...(askedAs && { askedAs }) };
  return { language: roomTextsLanguageOf(input.texts), from: 'room', ...(askedAs && { askedAs }) };
}
