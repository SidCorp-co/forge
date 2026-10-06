"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { feedbackApi } from "./api";
import type { CreateFeedbackRequest, FeedbackAction, FeedbackResponse, PromoteAgentReportRequest } from "./types";

export function useFeedbackList(projectId: string | undefined) {
  return useQuery({
    queryKey: ["feedback", projectId ?? ""],
    queryFn: () => feedbackApi.list(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useFeedbackItem(projectId: string | undefined, key: string | undefined) {
  return useQuery({
    queryKey: ["feedback-item", projectId ?? "", key ?? ""],
    queryFn: () => feedbackApi.get(projectId as string, key as string),
    enabled: Boolean(projectId && key),
    staleTime: 15_000,
  });
}

function useInvalidate(projectId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["feedback", projectId] });
    qc.invalidateQueries({ queryKey: ["feedback-item", projectId] });
    qc.invalidateQueries({ queryKey: ["suggestions", projectId] });
  };
}

export function useCreateFeedback(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: (body: CreateFeedbackRequest) => feedbackApi.create(projectId, body),
    onSettled: invalidate,
  });
}

export function usePromoteFeedback(projectId: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: (body: PromoteAgentReportRequest) => feedbackApi.promote(projectId, body),
    onSettled: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["agent-reports", projectId] });
    },
  });
}

/** Triage, retarget, decline, verify, reopen or delete reporter data; the answer is the item as it reads next. */
export function useFeedbackAction(projectId: string, key: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: (a: FeedbackAction) => feedbackApi.act(projectId, key, a),
    onSuccess: (r: FeedbackResponse) => qc.setQueryData(["feedback-item", projectId, key], r),
    onSettled: invalidate,
  });
}
