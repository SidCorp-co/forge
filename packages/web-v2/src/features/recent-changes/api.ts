import { apiClient } from "@/lib/api/client";
import type { RecentChangesResponse } from "./types";

export const RECENT_CHANGES_LIMIT = 12;

export const recentChangesApi = {
  list: (limit: number = RECENT_CHANGES_LIMIT) =>
    apiClient<RecentChangesResponse>(`/me/recent-changes?limit=${limit}`),
};
