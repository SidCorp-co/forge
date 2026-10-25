
// Parked decisions: the queries live in `queries.ts`, the answers and their toasts here.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { useToastWrite } from "@/providers/toast-write";
import { questionsApi } from "./api";
import { questionKeys, questionQueries } from "./queries";
import type { AnswerInput } from "./types";

/** Kept for the screens that invalidate a project's questions by key. */
export const projectQuestionsKey = questionKeys.project;
export const gateQuestionKey = questionKeys.gate;

export function useIssueQuestions(issueId: string, projectId?: string) {
  return useQuery(questionQueries.issue(issueId, projectId));
}

/** An answer: the reads in `touches` and the attention counts are read again, on a refusal too (the question may have moved). */
function useAnswer(touches: readonly (readonly unknown[])[]) {
  const t = useCopy();
  return useToastWrite(questionsApi.answer, {
    touches: [...touches, ["attention"]],
    said: t("agents.question.recorded"),
    failed: t("agents.question.notRecorded"),
    touchesOnRefusal: true,
  });
}

export const useAnswerQuestion = (issueId: string) => useAnswer([questionKeys.issue(issueId), ["issue", issueId]]);

/**
 * Which questions have an answer on the wire right now, and the way to send one.
 */
export function useAnsweringQuestions(send: (input: AnswerInput) => Promise<unknown>) {
  const [answering, setAnswering] = useState<ReadonlySet<string>>(() => new Set());
  const answer = (input: AnswerInput, onAnswered?: (input: AnswerInput) => void) => {
      setAnswering((prev) => new Set(prev).add(input.questionId));
      Promise.resolve(send(input))
        .then(
          () => onAnswered?.(input),
          () => undefined,
        )
        .finally(() =>
          setAnswering((prev) => {
            const next = new Set(prev);
            next.delete(input.questionId);
            return next;
          }),
        );
    };
  return { answering, answer };
}
