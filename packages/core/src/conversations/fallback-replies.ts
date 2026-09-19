export const errorFallbackReply = (name: string): string =>
  `Xin lỗi, ${name} đang quá tải hoặc gặp sự cố — bạn thử lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

export const unverifiedFallbackReply = (name: string): string =>
  `Xin lỗi, ${name} chưa đối chiếu được số liệu dự án nên không dám gửi câu trả lời chưa chắc chắn — không phải do câu hỏi của bạn, bạn hỏi lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

export const emptyFallbackReply = (name: string): string =>
  `Xin lỗi, ${name} chưa đưa ra được câu trả lời cho yêu cầu này — bạn diễn đạt lại giúp ${name} nhé.`; // i18n-allow: user-facing channel reply

/**
 * The two terminal statuses an explicit request is owed when the ordinary reply did not land.
 */
export const nothingPostedStatus = (name: string): string =>
  `${name} đã nhận yêu cầu của bạn nhưng chưa gửi được câu trả lời nào — bạn hỏi lại giúp ${name} sau ít phút nhé.`; // i18n-allow: user-facing channel reply

export const uncertainStatus = (name: string): string =>
  `${name} đã gửi câu trả lời nhưng chưa xác nhận được là nó đã đến — bạn kiểm tra lại phòng, nếu không thấy thì hỏi lại giúp ${name} nhé.`; // i18n-allow: user-facing channel reply

/** The head of the door's corrective retry, which is the retry row's `chat_logs.query`: history reads a screen repair by it (ISS-1053). */
export const CORRECTIVE_PREFIX = '[SYSTEM CHECK — not from the user]';
