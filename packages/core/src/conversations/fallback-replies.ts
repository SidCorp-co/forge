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
