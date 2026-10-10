// The sessions feature's reads: one key factory and its queryOptions. The key shapes are the ones the
// WebSocket router invalidates by prefix (`lib/ws/event-router.ts`), so they stay as they are.
import { readOf } from "@/lib/api/query-kit";
import { type ListSessionsOpts, sessionsApi } from "./api";

export const sessionsKeys = {
  all: ["agent-sessions"] as const,
  list: (opts: ListSessionsOpts) => [...sessionsKeys.all, "list", opts] as const,
  queueStatsAll: () => [...sessionsKeys.all, "queue-stats"] as const,
  queueStats: (projectId: string | undefined) => [...sessionsKeys.queueStatsAll(), projectId] as const,
  cost: (sessionId: string | undefined) => [...sessionsKeys.all, sessionId, "cost"] as const,
};

export const sessionsQueries = {
  list: (opts: ListSessionsOpts) => readOf(sessionsKeys.list(opts), () => sessionsApi.list(opts), 0),
  queueStats: (projectId: string | undefined) => readOf(sessionsKeys.queueStats(projectId), () => sessionsApi.queueStats(projectId as string), 0),
  cost: (sessionId: string | undefined) => readOf(sessionsKeys.cost(sessionId), () => sessionsApi.cost(sessionId as string), 0),
};
