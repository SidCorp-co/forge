"use client";

// web-v2 feature module: parked decisions — react-query surface.
//
// There is no websocket event for a question in either direction: core's
// `wakeMastersForAnswer` publishes to DEVICE rooms, which no browser subscribes
// to. So this module refetches its own key and nothing else will do it for it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { questionsApi } from "./api";
import type { AnswerInput } from "./types";

export const issueQuestionsKey = (issueId: string) => ["questions", issueId];

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
