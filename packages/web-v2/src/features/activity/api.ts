// web-v2 feature module: activity — REST surface. All calls go through the
// shared `apiClient` (no raw fetch). Verified against
// `packages/core/src/issues/activity-routes.ts` for ISS-296.
import { apiClient } from "@/lib/api/client";
import type { ActivityFeedPage } from "./types";

export interface ProjectActivityOpts {
  limit?: number;
  /** ISO cursor — returns items created strictly before this time. */
  before?: string;
  /** Server-side category filter (`{type}.%`). */
  type?: "issue" | "comment" | "member";
}

export const activityApi = {
  /** `GET /api/projects/:id/activity?limit&before&type` → `{ items, nextBefore }`. */
  projectActivity: (projectId: string, { limit = 40, before, type }: ProjectActivityOpts = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", before);
    if (type) params.set("type", type);
    return apiClient<ActivityFeedPage>(
      `/projects/${encodeURIComponent(projectId)}/activity?${params}`,
    );
  },
};
