"use client";

// web-v2 feature module: parked decisions — react-query surface.
//
// There is no websocket event for a question in either direction: core's
// `wakeMastersForAnswer` publishes to DEVICE rooms, which no browser subscribes
// to. So this module refetches its own key and nothing else will do it for it.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { questionsApi } from "./api";
import type { AnswerInput } from "./types";

export const issueQuestionsKey = (issueId: string) => ["questions", issueId];
export const projectQuestionsKey = (projectId: string) => ["questions", "project", projectId];

const FOLLOW_UP_POLL_MS = 30_000;

export function useIssueQuestions(issueId: string) {
  return useQuery({
    queryKey: issueQuestionsKey(issueId),
    queryFn: () => questionsApi.listForIssue(issueId),
    enabled: Boolean(issueId),
    refetchInterval: (query) =>
      (query.state.data?.questions.length ?? 0) > 0 ? FOLLOW_UP_POLL_MS : false,
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
      toast({
        title: "Decision recorded",
        description: "The run has been told.",
        tone: "success",
      });
    },
    onError: (err) => {
      qc.invalidateQueries({ queryKey: issueQuestionsKey(issueId) });
      toast({ title: "Not recorded", description: formatApiError(err), tone: "error" });
    },
  });
}


/** Every OPEN decision on one project, for the queue on the Agents screen. */
const PROJECT_QUEUE_POLL_MS = 30_000;

export function useProjectQuestions(projectId: string | undefined) {
  const query = useInfiniteQuery({
    queryKey: projectQuestionsKey(projectId ?? ""),
    queryFn: ({ pageParam }) =>
      questionsApi.listOpenForProject(projectId as string, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    enabled: Boolean(projectId),
    refetchInterval: PROJECT_QUEUE_POLL_MS,
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
        description: "The run has been told.",
        tone: "success",
      });
    },
    onError: (err) => {
      qc.invalidateQueries({ queryKey: projectQuestionsKey(projectId) });
      toast({ title: "Not recorded", description: formatApiError(err), tone: "error" });
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
