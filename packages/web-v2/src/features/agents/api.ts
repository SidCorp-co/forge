import { apiClient } from "@/lib/api/client";
import type { RunSessionsResponse } from "./types";

export const agentsApi = {
  /** `GET /api/projects/:id/run-sessions` — every run the fleet reports here. */
  // cm:guard the path carries NO `/api`: `apiClient` prepends it, and a second one produced `/api/api/...`, a 404 the pane rendered as its ordinary error state on forge-beta while every jsdom test stayed green because they mock the client (found by the deployed walk, 2026-09-09).
  runSessions: (projectId: string) =>
    apiClient<RunSessionsResponse>(`/projects/${projectId}/run-sessions`),
};
