"use client";

import { useQuery } from "@tanstack/react-query";
import { LIVE_READ_POLL_MS } from "@/features/sessions/types";
import { pipelineApi } from "./api";
import { pollUnlessRefused } from "@/lib/api/read-failed";
import { noteAttemptStart, readGapOf } from "@/lib/ws/invalidation-coalescer";

const SESSIONS_AND_HOLDS = "sessions-and-holds";

export function useSessionsAndHolds(projectId: string | undefined) {
  return useQuery({
    queryKey: [SESSIONS_AND_HOLDS, projectId],
    queryFn: ({ queryKey }) => {
      noteAttemptStart(queryKey);
      return pipelineApi.sessionsAndHolds(projectId as string);
    },
    enabled: !!projectId,
    // A standing refusal is not polled: asking again only repeats it (ISS-1228 r25).
    refetchInterval: (query) => pollUnlessRefused(query, LIVE_READ_POLL_MS),
    // A retry spends the frame storm's budget too: one start per gap, failing or not (ISS-1228 r27).
    retryDelay: readGapOf([SESSIONS_AND_HOLDS]),
  });
}
