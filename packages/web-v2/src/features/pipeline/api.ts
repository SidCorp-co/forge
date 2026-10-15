import { apiClient } from "@/lib/api/client";
import type { SessionsAndHolds } from "./types";

export const pipelineApi = {
  sessionsAndHolds: (projectId: string) =>
    apiClient<SessionsAndHolds>(`/projects/${projectId}/sessions-and-holds`),
};
