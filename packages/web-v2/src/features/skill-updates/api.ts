// web-v2 feature module: skill updates — REST surface. Endpoints already exist
// (packages/core/src/skills/reconcile-routes.ts); nothing was added core-side.
import { apiClient } from "@/lib/api/client";
import type { ReconcileRunDetail, ReconcileRunSummary } from "./types";

export const skillUpdatesApi = {
  /** `GET /api/projects/:projectId/reconcile-runs` — recent runs, newest first. */
  list: (projectId: string) =>
    apiClient<{ runs: ReconcileRunSummary[] }>(`/projects/${projectId}/reconcile-runs`),

  /** `GET /api/projects/:projectId/reconcile-runs/:runId` — bodies, rationale, votes. */
  get: (projectId: string, runId: string) =>
    apiClient<{ run: ReconcileRunDetail }>(`/projects/${projectId}/reconcile-runs/${runId}`),

  /** Publishes the candidate body to every runner on the project. Admin only. */
  apply: (projectId: string, runId: string) =>
    apiClient<{ ok: true }>(`/projects/${projectId}/reconcile-runs/${runId}/apply`, {
      method: "POST",
    }),

  /** Rejects the candidate; the running body is left untouched. Admin only. */
  reject: (projectId: string, runId: string, rejectReason: string) =>
    apiClient<{ ok: true }>(`/projects/${projectId}/reconcile-runs/${runId}/reject`, {
      method: "POST",
      body: JSON.stringify({ rejectReason }),
    }),
};
