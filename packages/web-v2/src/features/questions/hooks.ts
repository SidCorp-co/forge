"use client";

// web-v2 feature module: parked decisions — react-query surface.
//
// There is no websocket event for a question in either direction: core's
// `wakeMastersForAnswer` publishes to DEVICE rooms, which no browser subscribes
// to. So this module refetches its own key and nothing else will do it for it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
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

export function useProjectQuestions(projectId: string | undefined) {
  return useQuery({
    queryKey: projectQuestionsKey(projectId ?? ""),
    queryFn: () => questionsApi.listOpenForProject(projectId as string),
    enabled: Boolean(projectId),
    refetchInterval: PROJECT_QUEUE_POLL_MS,
  });
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
