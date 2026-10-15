"use client";

import { useQuery } from "@tanstack/react-query";
import { LIVE_READ_POLL_MS } from "@/features/sessions/types";
import { agentsApi } from "./api";

/** The fleet's runs for one project. Keyed `['run-sessions',projectId]`. */
export function useRunSessions(projectId: string | undefined) {
  return useQuery({
    queryKey: ["run-sessions", projectId],
    queryFn: () => agentsApi.runSessions(projectId as string),
    enabled: !!projectId,
    refetchInterval: LIVE_READ_POLL_MS,
  });
}
