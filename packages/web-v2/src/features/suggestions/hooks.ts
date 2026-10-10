"use client";

import { type QueryKey, useQuery } from "@tanstack/react-query";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { type SuggestionTargetFilter, suggestionsApi } from "./api";
import type { SuggestionDecision } from "./types";

/** The suggestions waiting on a requirement or feedback item for a person to accept or reject. */
export const useWaitingSuggestions = (projectId: string | undefined, target: SuggestionTargetFilter | undefined, enabled = true) =>
  useQuery({
    ...readOf(["suggestions", projectId, target ?? null], () => suggestionsApi.waiting(projectId as string, target), 10_000),
    enabled: Boolean(projectId && target) && enabled,
  });

/** Every suggestion waiting in the project, for the requirements list's assistant strip. */
export const useProjectWaitingSuggestions = (projectId: string | undefined) =>
  useQuery(readOf(["suggestions", projectId, "*"], () => suggestionsApi.waiting(projectId as string), 10_000));

/** Accept or reject one; `affected` names what its effect changes (a requirement's draft revision, a feedback item's route), re-read after it. */
export const useSuggestionDecision = (projectId: string, affected: readonly QueryKey[]) =>
  useWrite((d: SuggestionDecision) => suggestionsApi.decide(projectId, d), { touches: [["suggestions", projectId], ...affected] });

/** What an accepted requirement suggestion changes. */
export const requirementAffected = (projectId: string, requirement: string): QueryKey[] => [
  ["requirement", projectId, requirement],
  ["requirements", projectId],
];
