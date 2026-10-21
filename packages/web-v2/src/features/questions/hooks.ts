"use client";

// web-v2 feature module: parked decisions — react-query surface.
//
// A question asked reaches no browser by event, so this module polls its own key while a question
// stands. An answer does: core publishes `question.answered` to the project room, and the event
// router re-reads every page of that issue (ISS-1228 round 22).

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { useToast } from "@/providers/toast-provider";
import { runJournalKey } from "@/features/issues/detail-hooks";
import { questionsApi } from "./api";
import type { AnswerInput } from "./types";
import { failureToast } from "@/lib/api/failure-toast";
import { pollUnlessRefused } from "@/lib/api/read-failed";

export const issueQuestionsKey = (issueId: string) => ["questions", issueId];
export const projectQuestionsKey = (projectId: string) => ["questions", "project", projectId];

const FOLLOW_UP_POLL_MS = 30_000;

export function useIssueQuestions(issueId: string) {
  return useQuery({
    queryKey: issueQuestionsKey(issueId),
    queryFn: () => questionsApi.listForIssue(issueId),
    enabled: Boolean(issueId),
    refetchInterval: (query) =>
      pollUnlessRefused(query, (query.state.data?.questions.length ?? 0) > 0 ? FOLLOW_UP_POLL_MS : false),
  });
}

export function useAnswerQuestion(issueId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (input: AnswerInput) => questionsApi.answer(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: issueQuestionsKey(issueId) });
      qc.invalidateQueries({ queryKey: ["issue", issueId] });
      qc.invalidateQueries({ queryKey: ["attention"] });
      // An open question is a close refusal the release banner reads off the roster (ISS-1381).
      qc.invalidateQueries({ queryKey: ["release-roster"] });
      // The park the waiting banner and the status menu read is keyed under the comments (r4).
      qc.invalidateQueries({ queryKey: ["comments", issueId] });
      // The run reads by its question: "Needs an answer" and the Answer action give way now (ISS-1228).
      qc.invalidateQueries({ queryKey: runJournalKey(issueId) });
      qc.invalidateQueries({ queryKey: ["pipeline-run"] });
      qc.invalidateQueries({ queryKey: ["pipeline-runs", "list"] });
      toast({
        title: "Decision recorded",
        description: "Your answer is on the question. Whoever asked reads it there.",
        tone: "success",
      });
    },
    onError: (err) => {
      qc.invalidateQueries({ queryKey: issueQuestionsKey(issueId) });
      toast(failureToast(err, "The answer was not recorded"));
    },
  });
}


/** Every OPEN decision on one project that names no issue, for the Agents screen. */
const PROJECT_QUEUE_POLL_MS = 30_000;

export function useProjectQuestions(projectId: string | undefined) {
  const query = useInfiniteQuery({
    queryKey: projectQuestionsKey(projectId ?? ""),
    queryFn: ({ pageParam }) =>
      questionsApi.listOpenWithoutIssue(projectId as string, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    enabled: Boolean(projectId),
    refetchInterval: (query) => pollUnlessRefused(query, PROJECT_QUEUE_POLL_MS),
  });
  const pages = query.data?.pages ?? [];
  return {
    ...query,
    data: pages.length
      ? {
          questions: pages.flatMap((p) => p.questions),
          total: pages[pages.length - 1]?.total,
          hasMore: pages[pages.length - 1]?.hasMore,
        }
      : undefined,
  };
}

export function linkedVerdict(q: {
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

export function useLinkedQuestion(questionId: string | undefined, enabled: boolean) {
  const query = useQuery({
    queryKey: ["questions", "one", questionId ?? ""],
    queryFn: () => questionsApi.get(questionId as string),
    enabled: Boolean(questionId) && enabled,
    retry: false,
  });
  return { ...query, ...linkedVerdict(query) };
}

export function useAnswerProjectQuestion(projectId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (input: AnswerInput) => questionsApi.answer(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectQuestionsKey(projectId) });
      qc.invalidateQueries({ queryKey: ["attention"] });
      toast({
        title: "Decision recorded",
        description: "Your answer is on the question. Whoever asked reads it there.",
        tone: "success",
      });
    },
    onError: (err) => {
      qc.invalidateQueries({ queryKey: projectQuestionsKey(projectId) });
      toast(failureToast(err, "The answer was not recorded"));
    },
  });
}

/**
 * Which questions have an answer on the wire right now, and the way to send one.
 */
export function useAnsweringQuestions(send: (input: AnswerInput) => Promise<unknown>) {
  const [answering, setAnswering] = useState<ReadonlySet<string>>(() => new Set());
  const answer = useCallback(
    (input: AnswerInput, onAnswered?: (input: AnswerInput) => void) => {
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
    },
    [send],
  );
  return { answering, answer };
}
