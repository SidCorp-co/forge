import type { FeedbackChecklistsRead, RequirementChecklistsRead } from "@forge/contracts/checklist-read";
import { apiClient } from "@/lib/api/client";

const at = (projectId: string, kind: "requirements" | "feedback", key: string) =>
  `/projects/${projectId}/${kind}/${encodeURIComponent(key)}/checklist`;

/** Each item kind's checklist read, as core serves it: the questions are never restated here. */
export const checklistsApi = {
  requirement: (projectId: string, req: string) => apiClient<RequirementChecklistsRead>(at(projectId, "requirements", req)),
  feedback: (projectId: string, fb: string) => apiClient<FeedbackChecklistsRead>(at(projectId, "feedback", fb)),
};
