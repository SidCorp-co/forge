// web-v2 feature module: automation → PM — REST surface. All calls go through
// the shared `apiClient`. Routes verified against
// `packages/core/src/pm/routes.ts` (mounted at `/api/projects`).
import { apiClient, apiClientList } from "@/lib/api/client";
import type { PmConfig, PmConfigPatch, PmDecision } from "./types";

export const pmApi = {
  /** `GET /api/projects/:projectId/pm/config` — lazy-creates row if absent. */
  getConfig: (projectId: string) =>
    apiClient<PmConfig>(`/projects/${encodeURIComponent(projectId)}/pm/config`),

  /** `PUT /api/projects/:projectId/pm/config` — owner/admin only. */
  updateConfig: (projectId: string, patch: PmConfigPatch) =>
    apiClient<PmConfig>(`/projects/${encodeURIComponent(projectId)}/pm/config`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  /** `GET /api/projects/:projectId/pm/decisions` — paginated, `X-Total-Count`. */
  listDecisions: (projectId: string, params: { page?: number; pageSize?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.page !== undefined) qs.set("page", String(params.page));
    if (params.pageSize !== undefined) qs.set("pageSize", String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return apiClientList<PmDecision>(
      `/projects/${encodeURIComponent(projectId)}/pm/decisions${suffix}`,
    );
  },
};
