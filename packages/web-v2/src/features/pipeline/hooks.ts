"use client";

import { useQuery } from "@tanstack/react-query";
import { LIVE_READ_POLL_MS } from "@/features/sessions/types";
import { pipelineApi } from "./api";

export function useSessionsAndHolds(projectId: string | undefined) {
  return useQuery({
    queryKey: ["sessions-and-holds", projectId],
    queryFn: () => pipelineApi.sessionsAndHolds(projectId as string),
    enabled: !!projectId,
    refetchInterval: LIVE_READ_POLL_MS,
  });
}
