"use client";

import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "./api";

const RUN_SESSIONS_POLL_MS = 20_000;

export function useRunStanding(projectId: string | undefined) {
  return useQuery({
    queryKey: ["runs-standing", projectId, "live"],
    queryFn: () => agentsApi.runStanding(projectId as string),
    enabled: !!projectId,
    refetchInterval: RUN_SESSIONS_POLL_MS,
  });
}

/** The fleet's runs for one project. Keyed `['run-sessions',projectId]`. */
export function useRunSessions(projectId: string | undefined) {
  return useQuery({
    queryKey: ["run-sessions", projectId],
    queryFn: () => agentsApi.runSessions(projectId as string),
    enabled: !!projectId,
    refetchInterval: RUN_SESSIONS_POLL_MS,
  });
}
