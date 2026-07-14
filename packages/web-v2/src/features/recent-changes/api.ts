// web-v2 feature module: recent-changes — REST surface. Backs the workspace
// dashboard's "what just changed" panel (ISS-665) via the EXISTING core
// endpoint `GET /api/me/recent-changes`.
import { apiClient } from "@/lib/api/client";
import type { RecentChangesResponse } from "./types";

export const RECENT_CHANGES_LIMIT = 12;

export const recentChangesApi = {
  /** `GET /api/me/recent-changes` — most-recently-updated issues across
   *  every project the caller can see, newest first. */
  list: (limit: number = RECENT_CHANGES_LIMIT) =>
    apiClient<RecentChangesResponse>(`/me/recent-changes?limit=${limit}`),
};
