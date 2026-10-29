// The bounds on a reason, note or why a person or an agent writes, a leaf so every vocabulary can
// name one without importing another; `@forge/contracts/comments` re-exports them.

/** The one bound on a reason or decision text: a design's approve or return, a decision comment, a
 *  requirement's accept, defer, drop or repin (ISS-263). */
export const REASON_TEXT_MAX = 4_000;

/** A reason or note one paragraph long: one recorded beside a kernel move (a transition, a blocks
 *  edge, a merge mark, a relation, a release cut, a run's evidence) or a binding's notes, which the
 *  move's history row or the binding card shows whole, so it is half a decision's. */
export const REASON_PARAGRAPH_MAX = 2_000;

/** A note or reason a channel message, a contract version or an agent's channel call carries, read
 *  in the thread beside the message, so a few sentences. */
export const REASON_NOTE_MAX = 1_000;

/** A reason a run's evidence or an onboarding answer gives beside its verdict, read on the verdict's
 *  own line. */
export const REASON_SENTENCE_MAX = 600;

/** A one-line reason a refusal, a hold or an approval carries (a pool hold, a job act, a release
 *  approval note, a channel decision, a policy limit, a feedback reply's why), shown inline on a row. */
export const REASON_LINE_MAX = 500;

// A letter, digit, punctuation mark or symbol that draws ink: never a space, a control or format
// character, a default-ignorable one (a zero-width space or joiner, a Hangul filler), or the blank
// Braille pattern, each of which renders as nothing.
// biome-ignore lint/complexity/useRegexLiterals: a literal would have the formatter write the blank Braille pattern as itself, one more invisible character in the source; the escaped string keeps it legible.
const VISIBLE = new RegExp(
	"(?![\\p{Default_Ignorable_Code_Point}\\u2800])[\\p{L}\\p{N}\\p{P}\\p{S}]",
	"u",
);

/** Whether a reason says anything a reader can see: `trim()` keeps a zero-width space, this does not. */
export function hasVisibleText(text: string | null | undefined): boolean {
	return typeof text === "string" && VISIBLE.test(text);
}
