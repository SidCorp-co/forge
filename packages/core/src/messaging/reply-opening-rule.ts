/**
 * A reply opens with its answer, never with agreement to something the person did not say (REQ-41
 * BC-30). On dev (conversation a760cd5f, 2026-10-21/22) ten replies opened with the Vietnamese for
 * "correct" or "yes": "correct" to "can you check" (a question), "yes" to "help me with it" (a
 * request), "correct" to an instruction, then went on to say something else. Agreement answers a
 * statement; a question is answered and a request is done or refused. "Yes" answers a yes-or-no
 * question, so only a request makes it a false opening.
 *
 * Read from what the person typed: a question asks (a question mark, a closing particle, a question
 * word), a request tells (a leading verb or an asking word), and anything else states. Where the
 * screen has no question, nothing is judged.
 */

// every Vietnamese literal here is an `i18n-allow` pragma carrying the phrasing the detector must read; people chat in Vietnamese.

import type { MessageRule, RuleBreak } from './contract.js';

/** Agreement with what the person said: right only after a statement. */
const AGREES =
  /^\s*(?:\*\*)?(đúng(?:\s+vậy|\s+rồi)?|chính\s+xác|correct|exactly|that['’]?s\s+right|right|true|indeed)(?:\*\*)?(?=\s*(?:[.!,:;—–-]|$))/iu; // i18n-allow: the Vietnamese agreement openings being policed
/** A bare yes: answers a yes-or-no question, never a request. */
const YES = /^\s*(?:\*\*)?(có|vâng|yes)(?:\*\*)?(?=\s*(?:[.!,:;—–-]|$))/iu; // i18n-allow: the Vietnamese yes openings being policed

const NOT_LETTER = '(?<![\\p{L}\\p{N}])';
const END_PARTICLE = new RegExp(
  `${NOT_LETTER}(?:không|chưa|à|hả|nhỉ|sao|gì|nào|chứ)\\s*[.!?…]*\\s*$`, // i18n-allow: Vietnamese question particles
  'iu',
);
const QUESTION_WORDS = new RegExp(
  `${NOT_LETTER}(?:khi nào|bao giờ|bao nhiêu|tại sao|vì sao|thế nào|được không|phải không|đúng không)(?![\\p{L}])`, // i18n-allow: Vietnamese question words
  'iu',
);
const ENGLISH_QUESTION =
  /^\s*(?:what|when|where|why|how|which|who|is|are|was|were|can|could|do|does|did|will|would|should|has|have)\b/i;
const LEADING_VERB =
  /^\s*(?:check|kiểm tra|xem|mở|tóm tắt|báo cáo|liệt kê|ghi|tạo|làm|xử lý|đi|feedback|show|open|list|summari[sz]e|report|tell|give|make|record|run|drop|close)(?![\p{L}])/iu; // i18n-allow: Vietnamese leading verbs of a request
const ASKING = new RegExp(
  `${NOT_LETTER}(?:giúp|hãy|cho tôi|cho mình|giùm|please|can you|could you)(?![\\p{L}])|${NOT_LETTER}(?:đi|nhé|nha|hộ)\\s*[.!…]*\\s*$`, // i18n-allow: Vietnamese asking words
  'iu',
);

export type Said = 'question' | 'request' | 'statement';

/** What the person's message does: asks, tells, or states. */
export function saidKind(message: string): Said {
  const text = message.trim();
  if (
    text.includes('?') ||
    END_PARTICLE.test(text) ||
    QUESTION_WORDS.test(text) ||
    ENGLISH_QUESTION.test(text)
  ) {
    return 'question';
  }
  if (LEADING_VERB.test(text) || ASKING.test(text)) return 'request';
  return 'statement';
}

/** The opening word that agrees or says yes where the message gives nothing to agree or say yes to. */
export function falseOpening(reply: string, message: string | null): RuleBreak | null {
  if (!message?.trim()) return null;
  const said = saidKind(message);
  if (said === 'statement') return null;
  const agrees = AGREES.exec(reply);
  const yes = said === 'request' ? YES.exec(reply) : null;
  const hit = agrees ?? yes;
  if (!hit) return null;
  return {
    quote: hit[0].trim(),
    why: `the reply opens with "${hit[1]}", ${agrees ? 'agreeing' : 'saying yes'} to something the person did not say: their message ${said === 'question' ? 'asks a question' : 'asks for something to be done'}, so open with the answer itself, or with what was done or why it was not`,
  };
}

/** The opening of a reply is its answer, never agreement the person's message gives no ground for. */
export const OPENS_WITH_ITS_ANSWER: MessageRule = {
  id: 'opens-with-its-answer',
  shape:
    'open with the answer: agree ("Correct") only with a statement the person made, and say "Yes" only to a yes-or-no question',
  example: 'ISS-61 is awaiting release; nothing else waits on you.',
  needs: [],
  check: (text, f) => {
    const broken = falseOpening(text, f.question);
    return broken ? [broken] : [];
  },
};

/** The reply with a false opening word and the mark after it taken off, its next letter raised. */
export function withoutFalseOpening(reply: string, quote: string): string {
  const at = reply.indexOf(quote);
  if (at < 0) return reply;
  const rest = reply.slice(at + quote.length).replace(/^\s*(?:[.!,:;]|[—–-])?\s*/u, '');
  return reply.slice(0, at) + rest.charAt(0).toUpperCase() + rest.slice(1);
}
