// The assistant's suggested answer to a person question that came with none (REQ-41 BC-2). Core
// drafts it off the read path (`core/src/questions/suggest-answer.ts`), keeps one record per round on
// the question, and the needs-me read, the decision card and chat show it as "Suggested by the
// assistant". The asker's own recommendation always wins, and a suggestion answers nothing by
// itself: only a person's click posts the answer.

/** Why no suggestion was drafted, recorded on the question by name. */
export const QUESTION_SUGGESTION_CODES = [
	"QUESTION_SUGGESTION_NO_RECORD",
	"QUESTION_SUGGESTION_SENSITIVE",
	"QUESTION_SUGGESTION_MODEL_UNCONFIGURED",
	"QUESTION_SUGGESTION_WITHHELD",
	"QUESTION_SUGGESTION_MODEL_FAILED",
	"QUESTION_SUGGESTION_DECLINED",
	"QUESTION_SUGGESTION_SHAPE",
] as const;
export type QuestionSuggestionCode = (typeof QUESTION_SUGGESTION_CODES)[number];

/** A miss that is tried again later, up to `QUESTION_SUGGESTION_ATTEMPTS`; every other code is final for its round. */
export const QUESTION_SUGGESTION_RETRYABLE: readonly QuestionSuggestionCode[] =
	[
		"QUESTION_SUGGESTION_MODEL_FAILED",
		"QUESTION_SUGGESTION_MODEL_UNCONFIGURED",
	];
export const QUESTION_SUGGESTION_ATTEMPTS = 3;
/** A failed draft waits this long before the sweep tries it again. */
export const QUESTION_SUGGESTION_RETRY_MS = 30 * 60_000;

export const QUESTION_SUGGESTION_TEXT_MAX = 1500;
export const QUESTION_SUGGESTION_WHY_MAX = 300;

/** What the one record on a question holds for one round. */
export type QuestionSuggestion = {
	/** The round it was drafted for; a record of another round is no suggestion for this one. */
	round: number;
	by: "assistant";
	at: string;
	/** The records it read, by key, so a reader can see what the suggestion stands on. */
	from: string[];
	model: string | null;
	attempts: number;
} & (
	| {
			outcome: "suggested";
			text: string;
			why: string;
			/** On a choice round, the offered option the suggestion picks; its label is `text`. */
			optionId?: string;
	  }
	| { outcome: "failed"; code: QuestionSuggestionCode; detail: string }
);

/** The suggestion that stands for this round, or null where there is none or it is another round's. */
export function suggestionFor(
	suggestion: QuestionSuggestion | null | undefined,
	round: number,
): Extract<QuestionSuggestion, { outcome: "suggested" }> | null {
	return suggestion?.round === round && suggestion.outcome === "suggested"
		? suggestion
		: null;
}
