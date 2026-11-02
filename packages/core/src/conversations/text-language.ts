// The language a person wrote in, as far as a text can tell it: what a reply is held to
// (`assistant/screened-reply.ts:withReplyLanguage`), what a turn is told to answer in, and what a
// room speaks (`room-language.ts`). Only Vietnamese and English are told apart.

export type ReplyLanguage = 'en' | 'vi';

// letters only Vietnamese writes among the Latin scripts: the breve and circumflex vowels, the
// horn vowels, d-stroke, and every vowel carrying a tone mark
const VIETNAMESE_LETTER = /[ăâđêôơưàảãáạằẳẵắặầẩẫấậèẻẽéẹềểễếệìỉĩíịòỏõóọồổỗốộờởỡớợùủũúụừửữứựỳỷỹýỵ]/i; // i18n-allow: the letters that tell Vietnamese apart
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

/**
 * The language the person asked in, where it can be told: a confident reading, or a short message
 * that spells a word only Vietnamese spells, such as "run ISS-365" typed in Vietnamese. A short message without one is not
 * told, because "ok" and "cho ISS-5" read the same in either language.
 */
export function askerLanguageOf(text: string | null | undefined): ReplyLanguage | null {
  const confident = confidentLanguageOf(text);
  if (confident) return confident;
  const words = (text ?? '').match(WORD) ?? [];
  return words.length > 0 && words.length < 3 && words.some((w) => VIETNAMESE_LETTER.test(w))
    ? 'vi'
    : null;
}
