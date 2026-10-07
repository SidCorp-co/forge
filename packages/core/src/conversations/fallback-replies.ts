import {
  type AssistantTurnFailureCode,
  isAssistantTurnFailureCode,
} from '@forge/contracts/conversations';

/**
 * The lines code says in a room when the model's answer did not land. They answer in the language
 * of the message they answer (content-language `chat`: "Answer the person in the language they
 * wrote in"), and a failure names its code, so the reader is told one thing, in their words.
 */

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

/** A project's content language as one of the languages these lines are written in. */
export function replyLanguageOfTag(tag: string): ReplyLanguage {
  return tag === 'vi' || tag.startsWith('vi-') ? 'vi' : 'en';
}

type Line = Record<ReplyLanguage, (name: string) => string>;

const ERROR: Line = {
  en: (name) =>
    `Sorry, ${name} is overloaded or ran into a problem. Please try again in a few minutes.`,
  vi: (name) => `Xin lỗi, ${name} đang quá tải hoặc gặp sự cố — bạn thử lại sau ít phút nhé.`, // i18n-allow: user-facing channel reply
};

const UNVERIFIED: Line = {
  en: (name) =>
    `Sorry, ${name} could not check the project's figures, so it will not send an answer it is unsure of. This is not about your question; please ask again in a few minutes.`,
  vi: (name) =>
    `Xin lỗi, ${name} chưa đối chiếu được số liệu dự án nên không dám gửi câu trả lời chưa chắc chắn — không phải do câu hỏi của bạn, bạn hỏi lại sau ít phút nhé.`, // i18n-allow: user-facing channel reply
};

const EMPTY: Line = {
  en: (name) => `Sorry, ${name} could not put together an answer to this. Could you rephrase it?`,
  vi: (name) =>
    `Xin lỗi, ${name} chưa đưa ra được câu trả lời cho yêu cầu này — bạn diễn đạt lại giúp ${name} nhé.`, // i18n-allow: user-facing channel reply
};

const NOTHING_POSTED: Line = {
  en: (name) =>
    `${name} received your request but sent no answer. Please ask ${name} again in a few minutes.`,
  vi: (name) =>
    `${name} đã nhận yêu cầu của bạn nhưng chưa gửi được câu trả lời nào — bạn hỏi lại giúp ${name} sau ít phút nhé.`, // i18n-allow: user-facing channel reply
};

const UNCERTAIN: Line = {
  en: (name) =>
    `${name} sent an answer but could not confirm it arrived. Check the room; if it is not there, ask ${name} again.`,
  vi: (name) =>
    `${name} đã gửi câu trả lời nhưng chưa xác nhận được là nó đã đến — bạn kiểm tra lại phòng, nếu không thấy thì hỏi lại giúp ${name} nhé.`, // i18n-allow: user-facing channel reply
};

export type TurnFailureCode = AssistantTurnFailureCode;

const FAILED: Record<TurnFailureCode, Line> = {
  ASSISTANT_TURN_TIMED_OUT: {
    en: (name) =>
      `${name} ran out of time before it finished an answer, so nothing was sent. Ask again, or ask for one thing at a time.`,
    vi: (name) =>
      `${name} hết thời gian trước khi trả lời xong nên chưa gửi gì — bạn hỏi lại, hoặc hỏi từng việc một nhé.`, // i18n-allow: user-facing channel reply
  },
  ASSISTANT_TURN_FAILED: {
    en: (name) =>
      `${name} could not reach its model, so nothing was sent. Please ask again in a few minutes.`,
    vi: (name) => `${name} không gọi được mô hình nên chưa gửi gì — bạn hỏi lại sau ít phút nhé.`, // i18n-allow: user-facing channel reply
  },
};

/**
 * What a turn that ran past its first ceiling posts while it keeps working: what it did, what it
 * read, and that the rest follows in this same thread. `seconds` is how long the person has waited.
 */
const PARTIAL: Record<
  ReplyLanguage,
  {
    head: (name: string, seconds: number) => string;
    did: string;
    read: (n: number) => string;
    nothingYet: string;
  }
> = {
  en: {
    head: (name, seconds) =>
      `${name} has not finished this after ${seconds} seconds, so here is what it has so far — still working… the rest will be posted in this conversation.`,
    did: 'Done so far:',
    read: (n) => `Read so far (${n}):`,
    nothingYet: 'Nothing is finished yet; it is still reading the project.',
  },
  vi: {
    head: (name, seconds) =>
      `${name} chưa xong yêu cầu này sau ${seconds} giây nên gửi trước phần đã có — đang làm tiếp… phần còn lại sẽ được gửi ngay trong cuộc trò chuyện này.`, // i18n-allow: user-facing channel reply
    did: 'Đã làm:', // i18n-allow: user-facing channel reply
    read: (n) => `Đã đọc (${n}):`, // i18n-allow: user-facing channel reply
    nothingYet: 'Chưa có việc nào xong; đang đọc dữ liệu dự án.', // i18n-allow: user-facing channel reply
  },
};

export const partialReplyWords = (lang: ReplyLanguage) => PARTIAL[lang];

/** What the thread is told when the work that kept going after a partial reply did not finish. */
const CONTINUATION_ENDED: Record<TurnFailureCode, Line> = {
  ASSISTANT_TURN_TIMED_OUT: {
    en: (name) =>
      `${name} stopped before it finished the rest of this; what it did is listed above. Ask again for what is still missing, one thing at a time.`,
    vi: (name) =>
      `${name} đã dừng trước khi làm xong phần còn lại; những gì đã làm có ở tin nhắn trên. Bạn hỏi lại phần còn thiếu, từng việc một nhé.`, // i18n-allow: user-facing channel reply
  },
  ASSISTANT_TURN_FAILED: {
    en: (name) =>
      `${name} could not reach its model while finishing the rest of this; what it did is listed above. Please ask again in a few minutes.`,
    vi: (name) =>
      `${name} không gọi được mô hình khi làm nốt phần còn lại; những gì đã làm có ở tin nhắn trên. Bạn hỏi lại sau ít phút nhé.`, // i18n-allow: user-facing channel reply
  },
};

const NOTHING_MORE: Line = {
  en: (name) => `${name} finished; there is nothing to add to what is above.`,
  vi: (name) => `${name} đã làm xong; không có gì thêm ngoài phần ở trên.`, // i18n-allow: user-facing channel reply
};

export const continuationEndedReply = (
  name: string,
  lang: ReplyLanguage,
  failure: TurnFailureCode,
): string => CONTINUATION_ENDED[failure][lang](name);

export const nothingMoreReply = (name: string, lang: ReplyLanguage): string =>
  NOTHING_MORE[lang](name);

export const isTurnFailureCode = isAssistantTurnFailureCode;

/** The reason a window records for a failed turn: the sentence in English, the code beside it. */
export function turnFailureReason(code: TurnFailureCode, name: string): string {
  return FAILED[code].en(name);
}

export const errorFallbackReply = (name: string, lang: ReplyLanguage = 'en'): string =>
  ERROR[lang](name);

export const unverifiedFallbackReply = (name: string, lang: ReplyLanguage = 'en'): string =>
  UNVERIFIED[lang](name);

export const emptyFallbackReply = (name: string, lang: ReplyLanguage = 'en'): string =>
  EMPTY[lang](name);

/**
 * The two terminal statuses an explicit request is owed when the ordinary reply did not land. A
 * failed turn says what failed and names its code, so it is never read as a choice to say nothing.
 */
export const nothingPostedStatus = (
  name: string,
  lang: ReplyLanguage,
  failure: TurnFailureCode | null = null,
): string => (failure ? `${FAILED[failure][lang](name)} (${failure})` : NOTHING_POSTED[lang](name));

export const uncertainStatus = (name: string, lang: ReplyLanguage): string => UNCERTAIN[lang](name);

/** The head of the door's corrective retry, the retry turn's query: history reads a screen repair by it (ISS-1053). */
export const CORRECTIVE_PREFIX = '[SYSTEM CHECK — not from the user]';
