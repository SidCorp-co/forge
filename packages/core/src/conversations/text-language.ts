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

// Words Vietnamese typed without its marks still carries. They are weak: names, places and English words
// spell them too, so one of them is only ever the SECOND signal of a reading (never the first)
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

// The strict set: function words and particles no name, place, English or French word spells, so that
// ONE of them, with no English evidence beside it, tells a message Vietnamese. Typed without marks
// ("nhe", "luon", "giup", "duoc", "khong", "cua") or with them. "minh", "toi", "kia", "nay", "cho", "thi",
// "xin", "roi", "vay", "chua" are also names or English words, "nhung" a given name and "nha" a place name
// ("Nha Trang"), so they stay out. "the" with its tone mark is also a given name: it counts only lowercase, as every word
// does (a capitalised word is a possible name, `wordsWithNames`).
const VIETNAMESE_STRICT: ReadonlySet<string> = new Set([
  ...'nhe luon giup duoc khong cua'.split(' '),
  ...'nhé nhỉ ạ dạ ừ ơi vâng rồi thế vậy đã đây đó để với một những người'.split(' '), // i18n-allow: Vietnamese function words no name or English word spells
  ...'được chưa của giúp luôn không tôi bạn cũng sẽ đang đúng vẫn nếu'.split(' '), // i18n-allow: Vietnamese function words no name or English word spells
]);

// The letters only Vietnamese spells with: d-bar, the breve and horn vowels, and the hook, tilde and dot
// tones, alone or under a circumflex. A plain circumflex and the acute and grave tones on a plain vowel
// are left out: French loanwords (rose, cafe, crepe, pate, role typed with their marks) carry them into English messages.
const VIETNAMESE_ONLY_LETTER = /[ảãạăằắẳẵặầấẩẫậẻẽẹềếểễệỉĩịỏõọồốổỗộơờớởỡợủũụưừứửữựỷỹỵđ]/i; // i18n-allow: Vietnamese letters

// Words English spells and Vietnamese does not, typed with or without marks. Words a Vietnamese phrase
// also spells once its marks are dropped are left out on purpose: a, an, it, do, can, the, be, to, no, me,
// on, in, at, so, he, la. "ok" is shared and decides nothing. The one stoplist, for every English reading.
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
  'been',
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
  'who',
  'from',
  'about',
  'there',
  'they',
  'then',
  'than',
  'here',
  'also',
  'only',
  'very',
  'more',
  'some',
  'still',
  'just',
  'yet',
  'now',
  'right',
  'continue',
  'by',
  'every',
  'its',
  'their',
  'each',
  'other',
  'because',
  'into',
  'after',
  'before',
  'while',
  'such',
  'both',
  'without',
  'through',
  'over',
  'next',
  'again',
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

/** A message up to this many words is short enough for one strict Vietnamese word to decide it. */
const SHORT_MESSAGE_WORDS = 5;
/** The share of a text's words that are Vietnamese signals at which a longer text reads Vietnamese. */
const LONG_SHARE = 0.25;
/** The same share where English evidence stands beside the signals. */
const MIXED_SHARE = 0.4;
/** The share of a text's words English alone spells at which it reads English. */
const ENGLISH_SHARE = 0.15;

/**
 * The language a text is written in when it can be told with confidence, else null. What the reply
 * language checks hold a reply to fail only here: where the evidence is weak, mixed or one word, the
 * text is untold and no check fails anything over it. Confident means strong evidence on one side and none
 * on the other:
 * - Vietnamese needs a strict word (`VIETNAMESE_STRICT`) and, beside English evidence, a second signal
 *   (a Vietnamese-only letter, a strict or a bare word in another token) at a 0.4 share. A letter alone
 *   never decides: a lowercase name or food word (a given name or a dish, typed lowercase) carries the same letters in an English message.
 * - English needs three words, a 0.15 share of `ENGLISH_EVIDENCE`, and no Vietnamese signal at all.
 * Names (`wordsWithNames`) carry no signal.
 */
export function confidentLanguageOf(text: string | null | undefined): ReplyLanguage | null {
  const tokens = wordsWithNames((text ?? '').normalize('NFC'));
  if (tokens.length === 0) return null;
  const open = tokens.filter((t) => !t.name).map((t) => t.word.toLowerCase());
  const strict = open.filter((w) => VIETNAMESE_STRICT.has(w)).length;
  const signals = open.filter(
    (w) => VIETNAMESE_STRICT.has(w) || VIETNAMESE_BARE.has(w) || VIETNAMESE_ONLY_LETTER.test(w),
  ).length;
  const english = tokens.filter((t) => ENGLISH_EVIDENCE.has(t.word.toLowerCase())).length;
  if (strict > 0) {
    const share = signals / tokens.length;
    if (english === 0) {
      return tokens.length <= SHORT_MESSAGE_WORDS || (signals >= 2 && share >= LONG_SHARE)
        ? 'vi'
        : null;
    }
    return signals >= 2 && share >= MIXED_SHARE ? 'vi' : null;
  }
  if (signals > 0 || tokens.length < 3) return null;
  return english / tokens.length >= ENGLISH_SHARE ? 'en' : null;
}

/** Vietnamese where any of a room's texts reads Vietnamese with confidence, else English: the room's default for a line core writes, never a ground to fail a reply. */
export function roomTextsLanguageOf(texts: readonly string[]): ReplyLanguage {
  return texts.some((t) => confidentLanguageOf(t) === 'vi') ? 'vi' : 'en';
}
