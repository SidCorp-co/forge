import { apiClient } from "@/lib/api/client";
import type { WorkflowList } from "./types";

export const workflowsApi = {
  list: (projectId: string) => apiClient<WorkflowList>(`/projects/${projectId}/workflows`),
};
