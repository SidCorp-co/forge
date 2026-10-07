// One declaration of the codes a question write is refused with; core throws them and both doors
// answer them in the refusal envelope.
import type { RefusalStatuses } from "./refusal.js";

export const QUESTION_REFUSAL_CODES = [
	"QUESTION_REFUSED",
	"QUESTION_NOT_OPEN",
	"QUESTION_EXPIRED",
	"QUESTION_ROUND_STALE",
	"QUESTION_OPTION_UNKNOWN",
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
	"QUESTION_DESIGN_UNKNOWN",
	"QUESTION_DESIGN_NOT_AWAITING",
	"QUESTION_DESIGN_AMBIGUOUS",
	"QUESTION_MERGE_UNKNOWN",
	"QUESTION_MERGE_ALREADY_MARKED",
	"QUESTION_HOLD_NO_ISSUE",
	"QUESTION_HOLD_REASON_REQUIRED",
	"QUESTION_HOLD_BLOCKER_UNKNOWN",
] as const;
export type QuestionRefusalCode = (typeof QUESTION_REFUSAL_CODES)[number];
export const QUESTION_REFUSAL_STATUSES = {
	QUESTION_ROUND_STALE: 409,
} as const satisfies RefusalStatuses<QuestionRefusalCode>;

/**
 * What an answer says the issue still waits on, stored on the round it answers (ISS-257). It keeps
 * the answer from returning the issue to the status its park left; `blockedBy` is the issue whose
 * `blocks` edge the answer wrote onto it.
 */
export interface AnswerHold {
	reason: string;
	blockedBy?: { id: string; key: string };
}

/**
 * What an answer did to the issue it stopped (ISS-258): returned it to the status its park left,
 * handed it to the run that asked, left it for a box to read back, found another question open,
 * kept it parked as the answer said, found no status to return to, a staged project where a person
 * moves it, or a resume the issue machine refused.
 */
export type AnswerOutcome =
	| { kind: "resumed"; to: string }
	| { kind: "sent_to_run"; sessionId: string }
	| { kind: "box_reads" }
	| { kind: "other_question"; questionIds: string[] }
	| { kind: "held" }
	| { kind: "no_left_status" }
	| { kind: "staged" }
	| { kind: "refused"; code: string; detail: string };

/** An outcome as the answer resume records it on the answered round, with when. */
export type AnswerResume = AnswerOutcome & { at: string };
