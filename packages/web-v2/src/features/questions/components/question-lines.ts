// What a question card says in words: the suggested answer, whether it can be answered, how it ended,
// and what the answer did to the issue it stopped. Pure; the card draws them.
import { suggestionFor } from "@forge/contracts/question-suggestion";
import type { AnswerHold, AnswerResume } from "@forge/contracts/questions";
import { statusReading } from "@/design";
import { type Copy, productCopy } from "@/lib/i18n/product-copy";
import { type AgentQuestion, currentRoundOf, isChoiceStep, type QuestionStep } from "../types";

export type SuggestedAnswer = { text: string; why: string; optionId: string | undefined };

/** The assistant's suggestion for the round on screen, with the records it read; null for another round's or a miss. */
export function suggestedAnswerOf(question: AgentQuestion, current: QuestionStep | undefined): SuggestedAnswer | null {
  const s = current ? suggestionFor(question.suggestion, current.round) : null;
  if (!s) return null;
  const read = s.from.length ? ` (read ${s.from.join(", ")})` : "";
  return { text: s.text, why: `${s.why}${read}`, optionId: s.optionId };
}

export function isAnswerable(question: AgentQuestion): boolean {
  return question.status === "open" && question.blockerKind === "human";
}

export function answeredWith(last: QuestionStep | undefined, t: Copy): string {
  if (!last) return t("agents.question.noRound");
  if (!isChoiceStep(last)) return last.answerText ?? t("agents.question.inWords");
  return (
    last.options.find((o) => o.id === last.chosenOptionId)?.label ??
    last.chosenOptionId ??
    t("agents.question.optionGone")
  );
}

export function outcomeOf(question: AgentQuestion, language = "en"): string | null {
  const t = productCopy(language);
  const last = currentRoundOf(question);
  if (question.status === "answered") {
    return t("agents.question.outcome.answered", { what: answeredWith(last, t) });
  }
  if (question.status === "void") {
    return t("agents.question.outcome.void", { why: question.voidReason ?? t("agents.question.noReason") });
  }
  if (question.status === "expired") {
    return t("agents.question.outcome.expired", { why: question.endedReason ?? t("agents.question.deadlinePassed") });
  }
  if (question.status === "needs_info") {
    return t("agents.question.outcome.needsInfo");
  }
  return null;
}

/** What the answer said the issue still waits on, as the answered card shows it. */
export function holdLine(hold: AnswerHold | undefined, t: Copy): string | null {
  if (!hold) return null;
  return hold.blockedBy
    ? t("agents.question.stillWaitsOn", { key: hold.blockedBy.key, reason: hold.reason })
    : t("agents.question.stillWaits", { reason: hold.reason });
}

/** What the answer did to the issue it stopped, in a reader's words; null until core recorded it. */
export function resumeLine(resume: AnswerResume | undefined, t: Copy, language: string): string | null {
  switch (resume?.kind) {
    case undefined:
      return null;
    case "resumed":
      return t("agents.question.resume.resumed", { to: statusReading("issue", resume.to, language).label });
    case "sent_to_run":
      return t("agents.question.resume.sent_to_run");
    case "box_reads":
      return t("agents.question.resume.box_reads");
    case "other_question":
      return t("agents.question.resume.other_question");
    case "held":
      return t("agents.question.resume.held");
    case "no_left_status":
      return t("agents.question.resume.no_left_status");
    case "staged":
      return t("agents.question.resume.staged");
    case "refused":
      return t("agents.question.resume.refused", { code: resume.code, detail: resume.detail });
  }
}
