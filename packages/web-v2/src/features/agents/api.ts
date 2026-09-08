import { apiClient } from "@/lib/api/client";
import type { RunSessionsResponse } from "./types";

export const agentsApi = {
  /** `GET /api/projects/:id/run-sessions` — every run the fleet reports here. */
  runSessions: (projectId: string) =>
    apiClient<RunSessionsResponse>(`/api/projects/${projectId}/run-sessions`),
};
