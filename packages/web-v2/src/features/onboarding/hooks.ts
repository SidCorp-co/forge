"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { onboardingApi } from "./api";
import type { QuestionnaireAnswer } from "./types";

export const onboardingKey = (projectId: string) => ["onboarding", projectId] as const;

/** The project's onboarding and the dashboard's one line; non-blocking, so a failed read hides the line. */
export function useOnboardingState(projectId: string | undefined) {
  return useQuery({
    queryKey: onboardingKey(projectId ?? ""),
    queryFn: () => onboardingApi.state(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useStartOnboarding(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (request?: string) => onboardingApi.start(projectId, request),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: onboardingKey(projectId) });
      qc.invalidateQueries({ queryKey: ["conversations", "list"] });
    },
  });
}

export function useJoinOnboarding(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => onboardingApi.join(projectId),
    onSettled: () => qc.invalidateQueries({ queryKey: ["conversations", "list"] }),
  });
}

export function useReanalyze(projectId: string, conversationId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) => onboardingApi.reanalyze(projectId, reason),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: onboardingKey(projectId) });
      if (conversationId) qc.invalidateQueries({ queryKey: ["conversations", conversationId] });
    },
  });
}

export function useSubmitAnswers(projectId: string, conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { batchId: string; answers: QuestionnaireAnswer[]; skip?: boolean }) =>
      onboardingApi.submit(projectId, v.batchId, { answers: v.answers, ...(v.skip ? { skip: true } : {}) }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["conversations", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations", "list"] });
      qc.invalidateQueries({ queryKey: onboardingKey(projectId) });
    },
  });
}
