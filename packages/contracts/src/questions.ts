// One declaration of the codes a question write is refused with; core throws them and both doors
// answer them in the refusal envelope.
import type { RefusalStatuses } from "./refusal.js";

export const QUESTION_REFUSAL_CODES = [
	"QUESTION_REFUSED",
	"QUESTION_NOT_OPEN",
	"QUESTION_EXPIRED",
	"QUESTION_ROUND_STALE",
	"QUESTION_OPTION_UNKNOWN",
	"QUESTION_REASON_REQUIRED",
	"QUESTION_ISSUE_ELSEWHERE",
	"QUESTION_ISSUE_TERMINAL",
	"QUESTION_OPTIONS_REQUIRED",
	"QUESTION_RECOMMENDED_UNKNOWN",
	"QUESTION_OPTION_IDS_DUPLICATE",
	"QUESTION_SHAPE_INVALID",
	"QUESTION_ANSWER_WRONG_SHAPE",
	"QUESTION_MESSAGE_REFUSED",
	"QUESTION_CURSOR_INVALID",
	"QUESTION_NOTE_NOT_TAKEN",
	"QUESTION_IN_QUESTIONNAIRE",
] as const;
export type QuestionRefusalCode = (typeof QUESTION_REFUSAL_CODES)[number];
export const QUESTION_REFUSAL_STATUSES = {
	QUESTION_ROUND_STALE: 409,
} as const satisfies RefusalStatuses<QuestionRefusalCode>;

export const PARK_PROTECTIONS = [
	"park-exempt-residency",
	"park-exempt-oneshot",
	"answer-resume-park",
] as const;

export type ParkProtection = (typeof PARK_PROTECTIONS)[number];
