// web-v2 feature module: skill updates — REST surface over
// packages/core/src/skills/reconcile-routes.ts.

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

  // cm:edge contract -> packages/core/src/skills/reconcile-routes.ts — the REST body key is `reason`; the forge_reconcile MCP tool calls the same field `rejectReason`, and sending that name here 400s
  /** Rejects the candidate; the running body is left untouched. Admin only. */
  reject: (projectId: string, runId: string, reason: string) =>
    apiClient<{ ok: true }>(`/projects/${projectId}/reconcile-runs/${runId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  /** Clears an escalated run's attention item without touching its status. Admin only. */
  acknowledge: (projectId: string, runId: string, reason?: string) =>
    apiClient<{ ok: true }>(`/projects/${projectId}/reconcile-runs/${runId}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
};
