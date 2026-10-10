
import { useQuery } from "@tanstack/react-query";
import { readOf } from "@/lib/api/query-kit";
import { checklistsApi } from "./api";

// Each read is keyed under its item's own key, so every act and live change that reads the item
// again reads its checklists again.

export const useRequirementChecklists = (projectId: string, req: string) =>
  useQuery(readOf(["requirement", projectId, req, "checklists"], () => checklistsApi.requirement(projectId, req)));

export const useFeedbackChecklists = (projectId: string, fb: string) =>
  useQuery(readOf(["feedback-item", projectId, fb, "checklists"], () => checklistsApi.feedback(projectId, fb)));
