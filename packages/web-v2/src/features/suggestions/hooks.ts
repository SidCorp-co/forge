"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { suggestionsApi } from "./api";
import type { SuggestionDecision } from "./types";

/** The suggestions waiting on a requirement for a person to accept or reject. */
export function useWaitingSuggestions(projectId: string | undefined, requirement: string | undefined) {
  return useQuery({
    queryKey: ["suggestions", projectId ?? "", requirement ?? ""],
    queryFn: () => suggestionsApi.waitingOn(projectId as string, requirement as string),
    enabled: Boolean(projectId && requirement),
    staleTime: 10_000,
  });
}

/** Every suggestion waiting in the project, for the requirements list's assistant strip. */
export function useProjectWaitingSuggestions(projectId: string | undefined) {
  return useQuery({
    queryKey: ["suggestions", projectId ?? "", "*"],
    queryFn: () => suggestionsApi.waitingInProject(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

/** Accept or reject one; an accepted revision suggestion adds a draft revision, so the requirement is re-read too. */
export function useSuggestionDecision(projectId: string, requirement: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: SuggestionDecision) => suggestionsApi.decide(projectId, d),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["suggestions", projectId] });
      qc.invalidateQueries({ queryKey: ["requirement", projectId, requirement] });
      qc.invalidateQueries({ queryKey: ["requirements", projectId] });
    },
  });
}
