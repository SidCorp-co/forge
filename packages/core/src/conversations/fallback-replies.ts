/**
 * The fallback vocabulary: what a venue is shown when the model's own reply cannot be sent as it
 * stands. A leaf on purpose — `screened-reply.ts` reaches the screen, the logger and through them
 * the database client, and the assistant benchmark's graders read these texts without any of that
 * (ISS-1051). Moved here from `screened-reply.ts`, which imports them back.
 */

// cm:guard fallbacks speak AS the handle by name — never as an anonymous "the system" or "the model" voice
// cm:guard the three apologies below are posted in a DIRECT venue only: a group venue runs its turns with `fallbacks: 'silence'`, ends a failed turn as a named silence, and posts ONE of the two statuses further down into the asker's thread instead — an apology in a room's main stream is a notification to everybody about an answer nobody got (ISS-1088 criteria 19, 9, 11).
export const errorFallbackReply = (name: string): string =>
  // cm:ignore CM001 — the i18n pragma `check-source-language` reads to allow this user-facing Vietnamese reply; deleting it to satisfy codemap reds the language gate instead
  `Xin lỗi, ${name} đang quá tải hoặc gặp sự cố — bạn thử lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

// cm:guard ISS-818 — name the REASON: a bare "couldn't verify" reads to a stakeholder as "didn't understand you" so they rephrase, which cannot help because the question WAS understood and the answer failed the check
export const unverifiedFallbackReply = (name: string): string =>
  // cm:ignore CM001 — the i18n pragma `check-source-language` reads to allow this user-facing Vietnamese reply; deleting it to satisfy codemap reds the language gate instead
  `Xin lỗi, ${name} chưa đối chiếu được số liệu dự án nên không dám gửi câu trả lời chưa chắc chắn — không phải do câu hỏi của bạn, bạn hỏi lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

export const emptyFallbackReply = (name: string): string =>
  // cm:ignore CM001 — the i18n pragma `check-source-language` reads to allow this user-facing Vietnamese reply; deleting it to satisfy codemap reds the language gate instead
  `Xin lỗi, ${name} chưa đưa ra được câu trả lời cho yêu cầu này — bạn diễn đạt lại giúp ${name} nhé.`; // i18n-allow: user-facing channel reply

/**
 * The two terminal statuses an explicit request is owed when the ordinary reply did not land.
 */
// cm:guard TWO texts and never one, because they make different claims: `nothingPostedStatus` says the room holds no answer, which is known — the turn failed, the screen refused, nothing was sent; `uncertainStatus` says an answer was handed to the server and its fate is unknown, so the asker is told to LOOK before asking again, and nothing retries the answer for them (ISS-1088 criteria 9, 11, 12, 18).
export const nothingPostedStatus = (name: string): string =>
  // cm:ignore CM001 — the i18n pragma `check-source-language` reads to allow this user-facing Vietnamese reply; deleting it to satisfy codemap reds the language gate instead
  `${name} đã nhận yêu cầu của bạn nhưng chưa gửi được câu trả lời nào — bạn hỏi lại giúp ${name} sau ít phút nhé.`; // i18n-allow: user-facing channel reply

export const uncertainStatus = (name: string): string =>
  // cm:ignore CM001 — the i18n pragma `check-source-language` reads to allow this user-facing Vietnamese reply; deleting it to satisfy codemap reds the language gate instead
  `${name} đã gửi câu trả lời nhưng chưa xác nhận được là nó đã đến — bạn kiểm tra lại phòng, nếu không thấy thì hỏi lại giúp ${name} nhé.`; // i18n-allow: user-facing channel reply

/** The head of the door's corrective retry, which is the retry row's `chat_logs.query`: history reads a screen repair by it (ISS-1053). */
export const CORRECTIVE_PREFIX = '[SYSTEM CHECK — not from the user]';
