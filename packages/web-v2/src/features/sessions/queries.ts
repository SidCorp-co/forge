// The sessions feature's reads: one key factory and its queryOptions. The key shapes are the ones the
// WebSocket router invalidates by prefix (`lib/ws/event-router.ts`), so they stay as they are.
import { queryOptions } from "@tanstack/react-query";
import { type ListSessionsOpts, sessionsApi } from "./api";

export const sessionsKeys = {
  all: ["agent-sessions"] as const,
  list: (opts: ListSessionsOpts) => [...sessionsKeys.all, "list", opts] as const,
  queueStatsAll: () => [...sessionsKeys.all, "queue-stats"] as const,
  queueStats: (projectId: string | undefined) => [...sessionsKeys.queueStatsAll(), projectId] as const,
  cost: (sessionId: string | undefined) => [...sessionsKeys.all, sessionId, "cost"] as const,
};

export const sessionsQueries = {
  list: (opts: ListSessionsOpts) => queryOptions({ queryKey: sessionsKeys.list(opts), queryFn: () => sessionsApi.list(opts) }),
  queueStats: (projectId: string | undefined) =>
    queryOptions({
      queryKey: sessionsKeys.queueStats(projectId),
      queryFn: () => sessionsApi.queueStats(projectId as string),
      enabled: !!projectId,
    }),
  cost: (sessionId: string | undefined) =>
    queryOptions({
      queryKey: sessionsKeys.cost(sessionId),
      queryFn: () => sessionsApi.cost(sessionId as string),
      enabled: !!sessionId,
    }),
};
