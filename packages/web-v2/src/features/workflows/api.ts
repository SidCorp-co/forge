import type { WorkflowHealth } from "@forge/contracts/workflow-health";
import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { apiClient } from "@/lib/api/client";
import type { DesignDecisionBody, DesignDocument, WorkflowBody, RepinActBody, RepinActResult, RepinPlan, SystemGraph, SystemGraphRef, WorkflowDesign, WorkflowList, WorkflowRecord, WorkflowTemplateList } from "./types";

export const workflowsApi = {
  list: (projectId: string) => apiClient<WorkflowList>(`/projects/${projectId}/workflows`),
  templates: (projectId: string) =>
    apiClient<WorkflowTemplateList>(`/projects/${projectId}/workflow-templates`),
  /** One template with the built-in example drawn in it, null for a template that has none. */
  template: (projectId: string, id: string, version: number) =>
    apiClient<{ template: WorkflowTemplate; example: WorkflowBody | null }>(`/projects/${projectId}/workflow-templates/${encodeURIComponent(id)}/${version}`),
  design: (projectId: string, workflowId: string) =>
    apiClient<WorkflowDesign>(`/projects/${projectId}/workflows/${workflowId}/design`),
  health: (projectId: string, workflowId: string) =>
    apiClient<{ health: WorkflowHealth }>(`/projects/${projectId}/workflows/${workflowId}/health`),
  systemGraph: ({ projectId, workflowId, revision, against }: SystemGraphRef) =>
    apiClient<SystemGraph>(
      `/projects/${projectId}/workflows/${workflowId}/system-graph?revision=${revision}${against ? `&against=${against}` : ""}`,
    ),
  /** FB-86: a requirement drafted from this design, titled after it and linked to it at birth. */
  draftRequirement: (projectId: string, body: { title: string; designs: string[] }) =>
    apiClient<{ key: string }>(`/projects/${projectId}/requirements`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Links an existing requirement to this design: the requirement's own link route. */
  linkRequirement: (projectId: string, req: string, workflowId: string) =>
    apiClient<unknown>(`/projects/${projectId}/requirements/${encodeURIComponent(req)}/workflows`, {
      method: "POST",
      body: JSON.stringify({ workflowId }),
    }),
  repins: (projectId: string, workflowId: string) => apiClient<RepinPlan>(`/projects/${projectId}/workflows/${workflowId}/design/repins`),
  repin: (projectId: string, workflowId: string, body: RepinActBody) =>
    apiClient<RepinActResult>(`/projects/${projectId}/workflows/${workflowId}/design/repins`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** A new design, written as a draft (`baseRevision: null`); core answers with the workflow as stored. */
  create: (projectId: string, document: DesignDocument) =>
    apiClient<WorkflowRecord>(`/projects/${projectId}/workflows`, { method: "POST", body: JSON.stringify({ baseRevision: null, document }) }),
  /** The whole document written over the revision it was read at; a design past draft is proposed by it, drawn under `issue` when named. */
  write: (projectId: string, workflowId: string, baseRevision: number, document: DesignDocument, issue?: string) =>
    apiClient<WorkflowRecord>(`/projects/${projectId}/workflows/${workflowId}`, { method: "PUT", body: JSON.stringify({ baseRevision, document, ...(issue ? { issue } : {}) }) }),
  /** A draft put in front of its approver at the revision read; `issue` names the issue it is drawn under. */
  propose: (projectId: string, workflowId: string, revision: number, issue?: string) =>
    apiClient<WorkflowDesign>(`/projects/${projectId}/workflows/${workflowId}/design/propose`, {
      method: "POST",
      body: JSON.stringify({ revision, ...(issue ? { issue } : {}) }),
    }),
  /** A design no revision of which was approved, taken back: it leaves the list and Needs you, and the act is logged. */
  withdraw: (projectId: string, workflowId: string, reason: string | null) =>
    apiClient<WorkflowDesign>(`/projects/${projectId}/workflows/${workflowId}/design/withdraw`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  decide: (projectId: string, workflowId: string, body: DesignDecisionBody) =>
    apiClient<WorkflowDesign>(`/projects/${projectId}/workflows/${workflowId}/design/decision`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
