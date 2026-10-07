"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { feedbackForecastKey } from "@/features/forecast/hooks";
import { feedbackApi } from "./api";
import type { CreateFeedbackRequest, FeedbackAction, FeedbackMessageAudience, FeedbackResponse, PromoteAgentReportRequest } from "./types";

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

/** The routes and tools the project serves, read only while a picker is on "API route or tool". */
export function useFeedbackEndpoints(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["feedback-endpoints", projectId],
    queryFn: () => feedbackApi.endpoints(projectId),
    enabled: Boolean(projectId) && enabled,
    staleTime: 60_000,
  });
}

export function useFeedbackChoices(projectId: string, type: "requirement" | "workflow" | "release" | null) {
  return useQuery({
    queryKey: ["feedback-choices", projectId, type],
    queryFn: () => feedbackApi.choices(projectId, type as "requirement" | "workflow" | "release"),
    enabled: Boolean(projectId) && type !== null,
    staleTime: 15_000,
  });
}

function useInvalidate(projectId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["feedback", projectId] });
    qc.invalidateQueries({ queryKey: ["feedback-item", projectId] });
    qc.invalidateQueries({ queryKey: ["suggestions", projectId] });
    qc.invalidateQueries({ queryKey: feedbackForecastKey(projectId) });
  };
}

export function useCreateFeedback(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: (body: CreateFeedbackRequest) => feedbackApi.create(projectId, body),
    onSettled: invalidate,
  });
}

/** Attach files to an item: to the one a page shows, or to the key a filing was just answered with. */
export function useAttachFeedback(projectId: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: ({ key, files }: { key: string; files: readonly File[] }) => feedbackApi.attach(projectId, key, files),
    onSuccess: (r, { key }) => {
      if (r) qc.setQueryData(["feedback-item", projectId, key], r);
    },
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

/** What a message to reporters would say and to whom, read before it is sent. */
export function usePreviewMessage(projectId: string, key: string) {
  return useMutation({
    mutationFn: (body: { audience: Exclude<FeedbackMessageAudience, "internal">; text: string }) => feedbackApi.previewMessage(projectId, key, body),
  });
}

/** A message to reporters, or an internal note; the answer is the item with its thread. */
export function useSendMessage(projectId: string, key: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: (body: { audience: FeedbackMessageAudience; text: string; relayed?: boolean }) => feedbackApi.sendMessage(projectId, key, body),
    onSuccess: (r: FeedbackResponse) => qc.setQueryData(["feedback-item", projectId, key], r),
    onSettled: invalidate,
  });
}

/** Tells a shipped item's reporters now that it shipped; the answer is the item reading them told. */
export function useTellShipped(projectId: string, key: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: () => feedbackApi.tellShipped(projectId, key),
    onSuccess: (r: FeedbackResponse) => qc.setQueryData(["feedback-item", projectId, key], r),
    onSettled: invalidate,
  });
}
