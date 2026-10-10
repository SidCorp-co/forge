"use client";

// Parked decisions: the queries live in `queries.ts`, the answers and their toasts here.

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "@/lib/api/client";
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

export const useAnswerProjectQuestion = (projectId: string) => useAnswer([projectQuestionsKey(projectId)]);

/** Every OPEN decision on one project that names no issue, for the Agents screen. */
export function useProjectQuestions(projectId: string | undefined) {
  return useInfiniteQuery({
    ...questionQueries.project(projectId),
    // the pages read as one list: every question, and the newest page's total and whether more remain
    select: (data) => {
      const last = data.pages[data.pages.length - 1];
      return { questions: data.pages.flatMap((p) => p.questions), total: last?.total, hasMore: last?.hasMore };
    },
  });
}

function linkedVerdict(q: {
  isError: boolean;
  isSuccess: boolean;
  error?: unknown;
  data?: { status: string } | undefined;
}): { gone: boolean; unreachable: boolean } {
  const absent = q.isError && q.error instanceof ApiError && q.error.status === 404;
  return {
    /** Core answered about this row: it is not reachable, or it is reachable and not open. */
    gone: absent || (q.isSuccess && q.data?.status !== undefined && q.data.status !== "open"),
    /** The lookup itself failed, so nothing is known about the row. */
    unreachable: q.isError && !absent,
  };
}

/** The linked question's read and what it says about the row: `{ query, gone, unreachable }`. */
export function useLinkedQuestion(questionId: string | undefined, enabled: boolean) {
  const query = useQuery(questionQueries.one(questionId, enabled));
  return { query, ...linkedVerdict(query) };
}

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
