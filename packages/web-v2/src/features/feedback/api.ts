// web-v2 feature module: feedback — REST surface.
// Routes verified against `packages/core/src/feedback/routes.ts`.
import { apiClient } from "@/lib/api/client";
import type { FeedbackFilters, FeedbackReport } from "./types";

function buildQuery(projectId: string, filters?: FeedbackFilters, limit?: number): string {
  const params = new URLSearchParams({ projectId });
  if (filters?.kind) params.set("kind", filters.kind);
  if (filters?.severity) params.set("severity", filters.severity);
  if (filters?.target) params.set("target", filters.target);
  if (limit) params.set("limit", String(limit));
  return params.toString();
}

export const feedbackApi = {
  /** `GET /api/feedback-reports?projectId=&kind=&severity=&target=&limit=` */
  list: (projectId: string, filters?: FeedbackFilters, limit?: number) =>
    apiClient<FeedbackReport[]>(`/feedback-reports?${buildQuery(projectId, filters, limit)}`),

  /** `POST /api/feedback-reports/:id/reviewed` — toggle reviewed state. */
  markReviewed: (id: string, reviewed: boolean) =>
    apiClient<{ id: string; reviewedAt: string | null }>(`/feedback-reports/${id}/reviewed`, {
      method: "POST",
      body: JSON.stringify({ reviewed }),
    }),
};
