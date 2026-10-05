import type { WorkflowHealth } from "@forge/contracts/workflow-health";
import { apiClient } from "@/lib/api/client";
import type { DesignDecisionBody, SystemGraph, SystemGraphRef, WorkflowDesign, WorkflowList, WorkflowTemplateList } from "./types";

export const workflowsApi = {
  list: (projectId: string) => apiClient<WorkflowList>(`/projects/${projectId}/workflows`),
  templates: (projectId: string) =>
    apiClient<WorkflowTemplateList>(`/projects/${projectId}/workflow-templates`),
  design: (projectId: string, workflowId: string) =>
    apiClient<WorkflowDesign>(`/projects/${projectId}/workflows/${workflowId}/design`),
  health: (projectId: string, workflowId: string) =>
    apiClient<{ health: WorkflowHealth }>(`/projects/${projectId}/workflows/${workflowId}/health`),
  systemGraph: ({ projectId, workflowId, revision, against }: SystemGraphRef) =>
    apiClient<SystemGraph>(
      `/projects/${projectId}/workflows/${workflowId}/system-graph?revision=${revision}${against ? `&against=${against}` : ""}`,
    ),
  decide: (projectId: string, workflowId: string, body: DesignDecisionBody) =>
    apiClient<WorkflowDesign>(`/projects/${projectId}/workflows/${workflowId}/design/decision`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
