/**
 * The fallback vocabulary: what a venue is shown when the model's own reply cannot be sent as it
 * stands. A leaf on purpose — `screened-reply.ts` reaches the screen, the logger and through them
 * the database client, and the assistant benchmark's graders read these texts without any of that
 * (ISS-1051). Moved here from `screened-reply.ts`, which imports them back.
 */

// cm:guard fallbacks speak AS the handle by name — never as an anonymous "the system" or "the model" voice
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
