// One declaration of the codes a question write is refused with; core throws them and both doors
// answer them in the refusal envelope.
import { z } from "zod";
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
	"QUESTION_ABOUT_UNKNOWN",
	"QUESTION_ABOUT_NO_REQUIREMENT",
	"QUESTION_ABOUT_ON_MERGE_WAIT",
	"QUESTION_ABOUT_SHAPE",
	"QUESTION_RECOMMENDATION_REQUIRED",
] as const;
export type QuestionRefusalCode = (typeof QUESTION_REFUSAL_CODES)[number];
export const QUESTION_REFUSAL_STATUSES = {
	QUESTION_ROUND_STALE: 409,
	QUESTION_ABOUT_SHAPE: 400,
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

/**
 * What a question is about, as its asker named it, stored beside the question (`agent_questions.about`).
 * It is not `requirementId`: that column is the BA clarification link and moves the question to the
 * requirement's operational surface, while `about` keeps the question where it was asked (its issue,
 * or no issue at all) and only lists it on the requirement it names, whose page records its answer
 * as a decision. A contract is `<project>/<contract>`.
 */
export type QuestionAbout =
	| { kind: "requirement"; requirementId: string }
	| { kind: "contract"; contract: string };

/**
 * `about` on an ask body. `{ requirement }` names a requirement by key (REQ-n) or uuid; on a question
 * asked on an issue it may be left out (`{ requirement: null }`), which names the requirement the
 * issue delivers. `{ contract }` names `<project>/<contract>`, a contract this project publishes or
 * consumes. Core never reads it from the prompt's prose.
 */
export const questionAboutRequestSchema = z.union([
	z.strictObject({ requirement: z.string().trim().min(1).max(200).nullable() }),
	z.strictObject({
		contract: z
			.string()
			.trim()
			.regex(
				/^[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/,
				"a contract reads <project>/<contract>",
			),
	}),
]);
export type QuestionAboutRequest = z.infer<typeof questionAboutRequestSchema>;

/**
 * The one shape `about` takes, in the words both ask doors refuse any other with
 * (`QUESTION_ABOUT_SHAPE`): a bare `"REQ-n"` names nothing until it sits under `requirement`.
 */
export const QUESTION_ABOUT_SHAPE_SENTENCE =
	'`about` is an object naming one thing: {"requirement":"REQ-n"} (a requirement key or uuid), {"requirement":null} (the requirement the asking issue delivers), or {"contract":"<project>/<contract>"}; never a bare string';
