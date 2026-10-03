"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { requirementsApi } from "./api";
import type { CreateRequirementBody, RequirementAction, RequirementDetail, SuggestionDecision } from "./types";

export function useRequirements(projectId: string | undefined) {
  return useQuery({
    queryKey: ["requirements", projectId ?? ""],
    queryFn: () => requirementsApi.list(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useRequirement(projectId: string | undefined, req: string | undefined) {
  return useQuery({
    queryKey: ["requirement", projectId ?? "", req ?? ""],
    queryFn: () => requirementsApi.get(projectId as string, req as string),
    enabled: Boolean(projectId && req),
    staleTime: 15_000,
  });
}

export function useCreateRequirement(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRequirementBody) => requirementsApi.create(projectId, body),
    onSettled: () => qc.invalidateQueries({ queryKey: ["requirements", projectId] }),
  });
}

/** Propose, accept, return or agree. The detail it answers with is the one the screen shows next. */
export function useRequirementAction(projectId: string, req: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: RequirementAction) => requirementsApi.act(projectId, req, action),
    onSuccess: (detail: RequirementDetail) => qc.setQueryData(["requirement", projectId, req], detail),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["requirements", projectId] });
      qc.invalidateQueries({ queryKey: ["requirement", projectId, req] });
    },
  });
}

/** The suggestions waiting on a requirement for a person to accept or reject (ISS-58). */
export function useRequirementSuggestions(projectId: string | undefined, req: string | undefined) {
  return useQuery({
    queryKey: ["requirement-suggestions", projectId ?? "", req ?? ""],
    queryFn: () => requirementsApi.suggestions(projectId as string, req as string),
    enabled: Boolean(projectId && req),
    staleTime: 10_000,
  });
}

/** The project's open suggestions, for the list's BA assistant strip. */
export function useProjectSuggestions(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project-suggestions", projectId ?? ""],
    queryFn: () => requirementsApi.projectSuggestions(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

/** Accept or reject one; an accepted revision suggestion adds a draft revision, so the detail is re-read too. */
export function useSuggestionDecision(projectId: string, req: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: SuggestionDecision) => requirementsApi.decide(projectId, d),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["requirement-suggestions", projectId, req] });
      qc.invalidateQueries({ queryKey: ["project-suggestions", projectId] });
      qc.invalidateQueries({ queryKey: ["requirement", projectId, req] });
      qc.invalidateQueries({ queryKey: ["requirements", projectId] });
    },
  });
}
