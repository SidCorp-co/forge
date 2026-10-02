import { apiClient } from "@/lib/api/client";
import type { DesignDecisionBody, WorkflowDesign, WorkflowList } from "./types";

export const workflowsApi = {
  list: (projectId: string) => apiClient<WorkflowList>(`/projects/${projectId}/workflows`),
  design: (projectId: string, workflowId: string) =>
    apiClient<WorkflowDesign>(`/projects/${projectId}/workflows/${workflowId}/design`),
  decide: (projectId: string, workflowId: string, body: DesignDecisionBody) =>
    apiClient<WorkflowDesign>(`/projects/${projectId}/workflows/${workflowId}/design/decision`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
