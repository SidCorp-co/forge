// The language a person wrote in, as far as a text can tell it: what a reply is held to
// (`assistant/screened-reply.ts:withReplyLanguage`), what a turn is told to answer in, and what a
// room speaks (`room-language.ts`). Only Vietnamese and English are told apart.

import { VIETNAMESE_LETTER } from '@forge/contracts/content-language';

export type ReplyLanguage = 'en' | 'vi';

const WORD = /\p{L}+/gu;
const MENTIONED_WORD = /(@?)(\p{L}+)/gu;

// words after which a name follows, even where it is typed lowercase
const ADDRESSING: ReadonlySet<string> = new Set([
  'hi',
  'hello',
  'hey',
  'dear',
  'thanks',
  'thank',
  'cc',
  'ping',
]);

/**
 * The words of a text with the ones that may be a NAME marked: a capitalised word, an @mention, the
 * word after a mention or after a greeting ("hi", "thanks"). A name keeps its accents whatever
 * language the message is in (a name typed with its Vietnamese marks in an English message), so what a
 * name spells says nothing of the message's language. Where the language is in doubt a message is
 * left untold, never told Vietnamese: a false "vi" fails a correct English reply, a missed one fails nothing.
 */
export function wordsWithNames(text: string | null | undefined): { word: string; name: boolean }[] {
  const out: { word: string; name: boolean }[] = [];
  let after = false;
  for (const m of (text ?? '').matchAll(MENTIONED_WORD)) {
    const word = m[2] ?? '';
    const name = m[1] === '@' || after || word !== word.toLowerCase();
    out.push({ word, name });
    after = m[1] === '@' || (!after && ADDRESSING.has(word.toLowerCase()));
  }
  return out;
}

/** A message's share of Vietnamese-marked words at which it reads as Vietnamese, not as English quoting a name. */
const VIETNAMESE_SHARE = 0.4;

/** The language a message was written in, as far as these lines can tell: null where it has no words. */
export function replyLanguageOf(text: string | null | undefined): ReplyLanguage | null {
  const words = (text ?? '').match(WORD) ?? [];
  if (words.length === 0) return null;
  const marked = words.filter((w) => VIETNAMESE_LETTER.test(w)).length;
  return marked / words.length >= VIETNAMESE_SHARE ? 'vi' : 'en';
}

// words Vietnamese typed without its marks still carries; a share of them, with three words, reads Vietnamese
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
  'sao',
]); // i18n-allow: unmarked Vietnamese function words
// the few of them no name and no English word spells, so that ONE of them decides a short message:
// "minh", "toi", "kia", "nay", "cho", "thi", "xin", "roi", "vay" and "chua" are also given names, surnames or English words,
// and "nhung" is a given name and "nha" a place name ("Nha Trang") typed without accents
const VIETNAMESE_ONLY_BARE: ReadonlySet<string> = new Set([
  'nhe',
  'luon',
  'giup',
  'duoc',
  'khong',
  'cua',
]); // i18n-allow: unmarked Vietnamese function words no name or English word spells
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
  const tokens = wordsWithNames(text);
  const words = tokens.map((t) => t.word.toLowerCase());
  if (words.length < 3) return null;
  const vi = tokens.filter(
    (t) => !t.name && (VIETNAMESE_LETTER.test(t.word) || VIETNAMESE_BARE.has(t.word)),
  ).length;
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
  return wordsWithNames(text).some((t) => !t.name && VIETNAMESE_ONLY_LETTER.test(t.word));
}

/** Whether a text, names left out, spells any word with a letter only Vietnamese uses, or is one of its unmarked function words. */
export function hasVietnameseOnlyWord(text: string | null | undefined): boolean {
  return wordsWithNames(text).some(
    (t) => !t.name && (VIETNAMESE_ONLY_LETTER.test(t.word) || VIETNAMESE_ONLY_BARE.has(t.word)),
  );
}

// Words English spells and Vietnamese does not, typed with or without marks. Words a Vietnamese phrase
// also spells once its marks are dropped are left out on purpose: a, an, it, do, can, the, be, to, no, me,
// on, in, at, so, he, la. "ok" is shared and decides nothing.
const ENGLISH_EVIDENCE: ReadonlySet<string> = new Set([
  'is',
  'are',
  'was',
  'were',
  'will',
  'would',
  'could',
  'should',
  'does',
  'did',
  'have',
  'has',
  'you',
  'we',
  'my',
  'our',
  'this',
  'that',
  'any',
  'what',
  'how',
  'why',
  'when',
  'where',
  'which',
  'update',
  'check',
  'please',
  'thanks',
  'thank',
  'thx',
  'for',
  'of',
  'and',
  'or',
  'not',
  'but',
  'if',
  'with',
  'today',
  'done',
  'down',
  'out',
  'up',
  'live',
  'hello',
  'hey',
]);

/**
 * Whether a text carries a word only English spells. English evidence vetoes a Vietnamese reading:
 * a name, place or loanword keeps its marks inside an English message, so no marked letter can tell
 * the two apart, while a Vietnamese message holds none of these words.
 */
export function hasEnglishEvidence(text: string | null | undefined): boolean {
  return (text ?? '').match(WORD)?.some((w) => ENGLISH_EVIDENCE.has(w.toLowerCase())) ?? false;
}

/**
 * Vietnamese evidence a short message can be told by: a marked letter or an unmarked function word,
 * names left out, and no English evidence. Beside another word a lone marked token ("ok" beside a lone marked name) is
 * a lowercase name, so it counts only where every other word is itself a Vietnamese-list word.
 */
export function hasVietnameseEvidence(text: string | null | undefined): boolean {
  if (hasEnglishEvidence(text)) return false;
  const tokens = wordsWithNames(text).filter((t) => !t.name);
  if (
    !tokens.some((t) => VIETNAMESE_ONLY_LETTER.test(t.word) || VIETNAMESE_ONLY_BARE.has(t.word))
  ) {
    return false;
  }
  const strict = tokens.some((t) => VIETNAMESE_ONLY_BARE.has(t.word));
  const marked = tokens.filter((t) => VIETNAMESE_LETTER.test(t.word)).length;
  const total = wordsWithNames(text).length;
  if (strict || total < 2 || marked > 1) return true;
  // an ALL-CAPS word ("ISS" of "ISS-365") is an identifier, a symbol beside the message
  return wordsWithNames(text).every(
    (t) =>
      VIETNAMESE_LETTER.test(t.word) ||
      VIETNAMESE_BARE.has(t.word) ||
      (t.word.length >= 2 && t.word === t.word.toUpperCase()),
  );
}

/** Whether most of a text's words, names left out, carry a Vietnamese mark: the other side of `replyLanguageOf` for a text with names. */
export function readsVietnameseBesideNames(text: string | null | undefined): boolean {
  const tokens = wordsWithNames(text);
  const marked = tokens.filter((t) => !t.name && VIETNAMESE_LETTER.test(t.word)).length;
  return tokens.length > 0 && marked / tokens.length >= VIETNAMESE_SHARE;
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
  // English evidence vetoes a Vietnamese reading unless three words are Vietnamese beside it
  if (confident === 'vi' && hasEnglishEvidence(text)) {
    const vi = wordsWithNames(text).filter(
      (t) => !t.name && (VIETNAMESE_LETTER.test(t.word) || VIETNAMESE_BARE.has(t.word)),
    ).length;
    return vi >= 3 ? 'vi' : null;
  }
  if (confident) return confident;
  const words = (text ?? '').match(WORD) ?? [];
  return words.length > 0 && words.length <= SHORT_MESSAGE_WORDS && hasVietnameseEvidence(text)
    ? 'vi'
    : null;
}
