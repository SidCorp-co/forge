"use client";

import { useQuery } from "@tanstack/react-query";
import { checklistsApi } from "./api";

// Each read is keyed under its item's own key, so every act and live change that reads the item
// again reads its checklists again.

export function useRequirementChecklists(projectId: string, req: string) {
  return useQuery({
    queryKey: ["requirement", projectId, req, "checklists"],
    queryFn: () => checklistsApi.requirement(projectId, req),
    staleTime: 15_000,
  });
}

export function useFeedbackChecklists(projectId: string, fb: string) {
  return useQuery({
    queryKey: ["feedback-item", projectId, fb, "checklists"],
    queryFn: () => checklistsApi.feedback(projectId, fb),
    staleTime: 15_000,
  });
}
