"use client";

import { useQuery } from "@tanstack/react-query";
import { LIVE_READ_POLL_MS } from "@/features/sessions/types";
import { pipelineApi } from "./api";
import { pollUnlessRefused } from "@/lib/api/read-failed";

export function useSessionsAndHolds(projectId: string | undefined) {
  return useQuery({
    queryKey: ["sessions-and-holds", projectId],
    queryFn: () => pipelineApi.sessionsAndHolds(projectId as string),
    enabled: !!projectId,
    // A standing refusal is not polled: asking again only repeats it (ISS-1228 r25).
    refetchInterval: (query) => pollUnlessRefused(query, LIVE_READ_POLL_MS),
  });
}
