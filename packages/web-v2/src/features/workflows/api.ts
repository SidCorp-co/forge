import { apiClient } from "@/lib/api/client";
import type { DesignDecisionBody, WorkflowDesign, WorkflowList, WorkflowTemplateList } from "./types";

export const workflowsApi = {
  list: (projectId: string) => apiClient<WorkflowList>(`/projects/${projectId}/workflows`),
  templates: (projectId: string) =>
    apiClient<WorkflowTemplateList>(`/projects/${projectId}/workflow-templates`),
  design: (projectId: string, workflowId: string) =>
    apiClient<WorkflowDesign>(`/projects/${projectId}/workflows/${workflowId}/design`),
  decide: (projectId: string, workflowId: string, body: DesignDecisionBody) =>
    apiClient<WorkflowDesign>(`/projects/${projectId}/workflows/${workflowId}/design/decision`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
