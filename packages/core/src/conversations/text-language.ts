// The language a person wrote in, as far as a text can tell it: what a reply is held to
// (`assistant/screened-reply.ts:withReplyLanguage`), what a turn is told to answer in, and what a
// room speaks (`room-language.ts`). Only Vietnamese and English are told apart.

import { VIETNAMESE_LETTER } from '@forge/contracts/content-language';

export type ReplyLanguage = 'en' | 'vi';

const WORD = /\p{L}+/gu;

/** A message's share of Vietnamese-marked words at which it reads as Vietnamese, not as English quoting a name. */
const VIETNAMESE_SHARE = 0.4;

/** The language a message was written in, as far as these lines can tell: null where it has no words. */
export function replyLanguageOf(text: string | null | undefined): ReplyLanguage | null {
  const words = (text ?? '').match(WORD) ?? [];
  if (words.length === 0) return null;
  const marked = words.filter((w) => VIETNAMESE_LETTER.test(w)).length;
  return marked / words.length >= VIETNAMESE_SHARE ? 'vi' : 'en';
}

// words Vietnamese typed without its marks still carries, none of them an English word
const VIETNAMESE_BARE: ReadonlySet<string> = new Set([
  'cho',
  'nha',
  'nhe',
  'roi',
  'thi',
  'vay',
  'kia',
  'nhung',
  'luon',
  'toi',
  'minh',
  'giup',
  'xin',
  'duoc',
  'khong',
  'chua',
  'nay',
  'cua',
]); // i18n-allow: unmarked Vietnamese function words
const ENGLISH_FUNCTION: ReadonlySet<string> = new Set([
  'the',
  'is',
  'are',
  'was',
  'what',
  'how',
  'why',
  'when',
  'where',
  'which',
  'please',
  'can',
  'could',
  'you',
  'to',
  'of',
  'and',
  'for',
  'this',
  'that',
  'with',
  'it',
  'do',
  'does',
  'did',
  'will',
  'should',
  'have',
  'has',
  'not',
  'in',
  'on',
  'my',
  'we',
  'our',
  'be',
  'a',
  'an',
]);

/**
 * The language a text is written in when it can be told with confidence, else null: the check a
 * reply's language is held to judges only what it can tell, so a short or mixed text is passed.
 */
export function confidentLanguageOf(text: string | null | undefined): ReplyLanguage | null {
  const words = ((text ?? '').match(WORD) ?? []).map((w) => w.toLowerCase());
  if (words.length < 3) return null;
  const vi = words.filter((w) => VIETNAMESE_LETTER.test(w) || VIETNAMESE_BARE.has(w)).length;
  if (vi / words.length >= VIETNAMESE_SHARE) return 'vi';
  if (vi / words.length > 0.05) return null;
  const en = words.filter((w) => ENGLISH_FUNCTION.has(w)).length;
  return en / words.length >= 0.15 ? 'en' : null;
}

/** Vietnamese where any of a room's texts reads Vietnamese with confidence, else English. */
export function roomTextsLanguageOf(texts: readonly string[]): ReplyLanguage {
  return texts.some((t) => confidentLanguageOf(t) === 'vi') ? 'vi' : 'en';
}

// the letters only Vietnamese spells with: d-bar, the circumflex, breve and horn vowels, and the hook, tilde and
// dot tones; the acute and grave tones are left out because French, Italian and loanwords carry them
const VIETNAMESE_ONLY_LETTER = /[ảãạăằắẳẵặâầấẩẫậẻẽẹêềếểễệỉĩịỏõọôồốổỗộơờớởỡợủũụưừứửữựỷỹỵđ]/i; // i18n-allow: Vietnamese letters

/** Whether a text spells any word with a letter only Vietnamese uses. */
export function hasVietnameseOnlyLetter(text: string | null | undefined): boolean {
  return (text ?? '').match(WORD)?.some((w) => VIETNAMESE_ONLY_LETTER.test(w)) ?? false;
}

/** Whether a text spells any word with a letter only Vietnamese uses, or is one of its unmarked function words. */
export function hasVietnameseOnlyWord(text: string | null | undefined): boolean {
  return (
    (text ?? '')
      .match(WORD)
      ?.some((w) => VIETNAMESE_ONLY_LETTER.test(w) || VIETNAMESE_BARE.has(w.toLowerCase())) ?? false
  );
}

/** A message up to this many words is short enough for one Vietnamese-only letter or word to decide it. */
const SHORT_MESSAGE_WORDS = 5;

/**
 * The language the person asked in, where it can be told: a confident reading, or a short message
 * that spells a word only Vietnamese spells, by a marked letter or by an unmarked function word
 * ("ok nhe"). A short message without one is not told, because "ok" reads the same in either language,
 * and an English one with a stray accented loanword ("café") stays English.
 */
export function askerLanguageOf(text: string | null | undefined): ReplyLanguage | null {
  const confident = confidentLanguageOf(text);
  if (confident) return confident;
  const words = (text ?? '').match(WORD) ?? [];
  return words.length > 0 && words.length <= SHORT_MESSAGE_WORDS && hasVietnameseOnlyWord(text)
    ? 'vi'
    : null;
}
