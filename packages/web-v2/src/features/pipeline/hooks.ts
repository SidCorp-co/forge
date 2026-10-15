"use client";

import { useQuery } from "@tanstack/react-query";
import { pipelineApi } from "./api";

/** A heartbeat moves no WS event, so check-in ages are re-read on this period. */
export const SESSIONS_AND_HOLDS_POLL_MS = 20_000;

export function useSessionsAndHolds(projectId: string | undefined) {
  return useQuery({
    queryKey: ["sessions-and-holds", projectId],
    queryFn: () => pipelineApi.sessionsAndHolds(projectId as string),
    enabled: !!projectId,
    refetchInterval: SESSIONS_AND_HOLDS_POLL_MS,
  });
}
