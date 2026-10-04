import type { RunStandingList } from "@forge/contracts/run-standing";
import { apiClient } from "@/lib/api/client";
import type { RunSessionsResponse } from "./types";

export const agentsApi = {
  runSessions: (projectId: string) =>
    apiClient<RunSessionsResponse>(`/projects/${projectId}/run-sessions`),
  runStanding: (projectId: string) =>
    apiClient<RunStandingList>(`/projects/${projectId}/runs/standing?scope=live&limit=200`),
};
