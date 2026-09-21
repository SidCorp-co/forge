import { apiClient } from "@/lib/api/client";
import type { RunSessionsResponse } from "./types";

export const agentsApi = {
  runSessions: (projectId: string) =>
    apiClient<RunSessionsResponse>(`/projects/${projectId}/run-sessions`),
};
