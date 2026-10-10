"use client";

// Parked decisions: the queries live in `queries.ts`, the answers and their toasts here.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useToast } from "@/providers/toast-provider";
import { questionsApi } from "./api";
import { questionKeys, questionQueries } from "./queries";
import type { AnswerInput } from "./types";

/** Kept for the screens that invalidate a project's questions by key. */
export const projectQuestionsKey = questionKeys.project;
export const gateQuestionKey = questionKeys.gate;

export function useIssueQuestions(issueId: string, projectId?: string) {
  return useQuery(questionQueries.issue(issueId, projectId));
}

export function useAnswerQuestion(issueId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: questionsApi.answer,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: questionKeys.issue(issueId) });
      void qc.invalidateQueries({ queryKey: ["issue", issueId] });
      void qc.invalidateQueries({ queryKey: ["attention"] });
      toast({
        title: t("agents.question.recorded"),
        tone: "success",
      });
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: questionKeys.issue(issueId) });
      toast({ title: t("agents.question.notRecorded"), description: formatApiError(err), tone: "error" });
    },
  });
}


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

export function useAnswerProjectQuestion(projectId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: questionsApi.answer,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: projectQuestionsKey(projectId) });
      void qc.invalidateQueries({ queryKey: ["attention"] });
      toast({
        title: t("agents.question.recorded"),
        tone: "success",
      });
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: projectQuestionsKey(projectId) });
      toast({ title: t("agents.question.notRecorded"), description: formatApiError(err), tone: "error" });
    },
  });
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
