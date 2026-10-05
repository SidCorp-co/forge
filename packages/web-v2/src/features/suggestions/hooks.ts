"use client";

import { type QueryKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type SuggestionTargetFilter, suggestionsApi } from "./api";
import type { SuggestionDecision } from "./types";

/** The suggestions waiting on a requirement or feedback item for a person to accept or reject. */
export function useWaitingSuggestions(projectId: string | undefined, target: SuggestionTargetFilter | undefined, enabled = true) {
  return useQuery({
    queryKey: ["suggestions", projectId ?? "", target ?? null],
    queryFn: () => suggestionsApi.waiting(projectId as string, target),
    enabled: Boolean(projectId && target) && enabled,
    staleTime: 10_000,
  });
}

/** Every suggestion waiting in the project, for the requirements list's assistant strip. */
export function useProjectWaitingSuggestions(projectId: string | undefined) {
  return useQuery({
    queryKey: ["suggestions", projectId ?? "", "*"],
    queryFn: () => suggestionsApi.waiting(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

/** Accept or reject one; `affected` names what its effect changes (a requirement's draft revision, a feedback item's route), re-read after it. */
export function useSuggestionDecision(projectId: string, affected: readonly QueryKey[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: SuggestionDecision) => suggestionsApi.decide(projectId, d),
    onSettled: () => {
      for (const queryKey of [["suggestions", projectId], ...affected]) qc.invalidateQueries({ queryKey });
    },
  });
}

/** What an accepted requirement suggestion changes. */
export const requirementAffected = (projectId: string, requirement: string): QueryKey[] => [
  ["requirement", projectId, requirement],
  ["requirements", projectId],
];
