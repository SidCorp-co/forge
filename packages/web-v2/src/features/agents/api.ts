import { RUN_STANDING_LIST_MAX } from "@forge/contracts/run-standing";
import { apiClient } from "@/lib/api/client";
import type { MasterCharter, MasterPassList, MasterStanding, RunStandingDetail, RunStandingList, RunStandingScope } from "./types";

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export const runsApi = {
  /** `GET /api/projects/:id/runs/standing?scope=` — every run core derives, its counts and the master beside them. */
  standing: (projectId: string, scope: RunStandingScope) =>
    apiClient<RunStandingList>(`${projectPath(projectId)}/runs/standing?scope=${scope}&limit=${RUN_STANDING_LIST_MAX}`),

  /** `GET /api/projects/:id/runs/standing/:runId` — one run, its attempts and its kernel transitions. */
  run: (projectId: string, runId: string) =>
    apiClient<RunStandingDetail>(`${projectPath(projectId)}/runs/standing/${encodeURIComponent(runId)}`),

  /** `GET /api/projects/:id/masters/standing`. */
  master: (projectId: string) => apiClient<MasterStanding>(`${projectPath(projectId)}/masters/standing`),

  /** `GET /api/projects/:id/masters/passes` — newest first. */
  passes: (projectId: string, limit = 50) => apiClient<MasterPassList>(`${projectPath(projectId)}/masters/passes?limit=${limit}`),

  charter: (projectId: string) => apiClient<MasterCharter>(`${projectPath(projectId)}/master-charter`),
};
