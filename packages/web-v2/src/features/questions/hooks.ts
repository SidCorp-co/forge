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

// cm:why 30s, matching the sweep a runner reads its own answers on: a follow-up round lands on a row that is already on screen and moves no issue status, so `issue.statusChanged` — the event that carries the FIRST question to an open screen — never fires for it.
const FOLLOW_UP_POLL_MS = 30_000;

// cm:guard the poll runs only while this issue ALREADY carries a question, and that bound is load rather than taste: `agent_questions` has no index on `issue_id` (`db/schema-questions.ts` indexes project+status and session), so an unconditional interval would put a sequential scan behind every open issue screen in the fleet. The empty case is covered by the `["questions", issueId]` invalidation in `lib/ws/event-router.ts` instead.
export function useIssueQuestions(issueId: string) {
  return useQuery({
    queryKey: issueQuestionsKey(issueId),
    queryFn: () => questionsApi.listForIssue(issueId),
    enabled: Boolean(issueId),
    refetchInterval: (query) =>
      (query.state.data?.questions.length ?? 0) > 0 ? FOLLOW_UP_POLL_MS : false,
  });
}

// cm:guard the refetch is on BOTH arms and the error arm is the load-bearing one: every refusal core raises here — stale round, already answered, expired, voided — means the screen is showing a decision the server has moved past, so answering again against what is on screen would repeat the refusal forever (ISS-980 criterion 19).
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
// cm:guard polled, and unconditionally unlike the issue-scoped hook above: `agent_questions` is indexed on `(project_id, status)` (`db/schema-questions.ts`), so this read is cheap where the issue-scoped one is a scan, and a queue that only refreshed when it already held a row could never show the first question to arrive. No websocket event carries a question to a browser — `wakeMastersForAnswer` publishes to DEVICE rooms — so nothing else will refresh it.
const PROJECT_QUEUE_POLL_MS = 30_000;

// cm:guard the route is PAGED since ISS-1022 and this hook drains it rather than showing page one: a project with more open decisions than the page size would otherwise present the first fifty as the whole queue, with no control reaching the rest and nothing on screen saying so. `total` is the uncapped count and is what the pane reports; `hasMore` is what ends the walk.
export function useProjectQuestions(projectId: string | undefined) {
  const query = useInfiniteQuery({
    queryKey: projectQuestionsKey(projectId ?? ""),
    queryFn: ({ pageParam }) =>
      questionsApi.listOpenForProject(projectId as string, pageParam ?? undefined),
    initialPageParam: null as string | null,
    // cm:guard the next page is the server's own `nextCursor` and never a count this client computes: the queue is being answered while it is read, so an offset starts past a row that shifted backward when an earlier one closed.
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

// cm:guard asked ONLY once the paged walk has run out, and it is what makes "no longer open" a fact rather than an inference: a question answered between two fetches leaves the set while the walk is still in it, so its absence from every page read is not evidence it closed. This lookup names the row by id, whatever page it would have been on (ISS-1022).
// cm:guard `gone` reads the STATUS of the refusal and never merely `isError`, because a 500, a timeout and a dropped connection all present as an error and none of them is evidence about the question: only a 404 is core saying the row is not reachable. Treat every other failure as unknown — telling a reader their decision closed because the API blinked sends them away from one that is open and still parked on them (ISS-1022).
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

// cm:guard the refetch is on BOTH arms for the same reason the issue-scoped mutation does it: every refusal core raises — stale round, already answered, expired, voided — means the queue on screen has moved, and answering again against it would repeat the refusal forever (ISS-980 criterion 19).
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
// cm:guard pending is tracked PER QUESTION here rather than read off the mutation, and both surfaces that render a LIST of decisions use this: react-query keeps one `variables` slot, so a second answer submitted before the first settles moves the flag off the first card and offers its irreversible button again while its answer is still travelling (ISS-998).
// cm:guard `onAnswered` fires only on success: a refusal leaves the card on screen, and a caller moving focus off a card that is still there sends its reader somewhere they did not ask to go.
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
