// web-v2 feature module: pm — REST surface. All calls go through the shared
// `apiClient` / `apiClientList` (no raw fetch). Routes verified against core
// (ISS-296): pm/routes.ts, dependency-routes.ts, extras-routes.ts, routes.ts.
import { apiClient, apiClientList } from "@/lib/api/client";
import type {
  DependenciesResponse,
  IssueLite,
  PipelineStage,
  PmConfig,
  PmConfigPatch,
  PmDecision,
  PmPolicy,
  PmPolicyCreate,
  PmPolicyPatch,
  RunPipelineStepResult,
} from "../types";

export const pmApi = {
  // ── PM config ──────────────────────────────────────────────────────────
  getConfig: (projectId: string) => apiClient<PmConfig>(`/projects/${projectId}/pm/config`),
  updateConfig: (projectId: string, patch: PmConfigPatch) =>
    apiClient<PmConfig>(`/projects/${projectId}/pm/config`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  // ── PM policies ────────────────────────────────────────────────────────
  listPolicies: (projectId: string) => apiClient<PmPolicy[]>(`/projects/${projectId}/pm/policies`),
  createPolicy: (projectId: string, body: PmPolicyCreate) =>
    apiClient<PmPolicy>(`/projects/${projectId}/pm/policies`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updatePolicy: (projectId: string, id: string, patch: PmPolicyPatch) =>
    apiClient<PmPolicy>(`/projects/${projectId}/pm/policies/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deletePolicy: (projectId: string, id: string) =>
    apiClient<void>(`/projects/${projectId}/pm/policies/${id}`, { method: "DELETE" }),

  // ── PM decisions ───────────────────────────────────────────────────────
  listDecisions: (projectId: string, page = 1, pageSize = 25, cause?: string) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (cause) params.set("cause", cause);
    return apiClientList<PmDecision>(`/projects/${projectId}/pm/decisions?${params}`);
  },

  /** Operator force-run of the PM agent. */
  run: (projectId: string) =>
    apiClient<{ ok: boolean; jobId: string }>(`/projects/${projectId}/pm/run`, { method: "POST" }),

  // ── Dependency editing (derived graph source) ────────────────────────────
  getDependencies: (issueId: string) =>
    apiClient<DependenciesResponse>(`/issues/${issueId}/dependencies`),
  addDependency: (issueId: string, dependsOnId: string, kind = "blocks", reason?: string) =>
    apiClient<{ id: string; created: boolean }>(`/issues/${issueId}/dependencies`, {
      method: "POST",
      body: JSON.stringify({ dependsOnId, kind, ...(reason ? { reason } : {}) }),
    }),
  removeDependency: (issueId: string, edgeId: string) =>
    apiClient<void>(`/issues/${issueId}/dependencies/${edgeId}`, { method: "DELETE" }),

  // ── Dispatch a pipeline stage ────────────────────────────────────────────
  runPipelineStep: (issueId: string, stage?: PipelineStage) =>
    apiClient<RunPipelineStepResult>(`/issues/${issueId}/run-pipeline-step`, {
      method: "POST",
      body: JSON.stringify(stage ? { stage } : {}),
    }),

  // ── Project issues (dependency picker) ────────────────────────────────────
  listIssues: (projectId: string, limit = 100) =>
    apiClientList<IssueLite>(`/projects/${projectId}/issues?limit=${limit}&sort=createdAt:desc`),
};
