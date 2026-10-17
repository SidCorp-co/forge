"use client";

import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { type ListSessionsOpts, sessionsApi } from "./api";
import { isInteractiveSession, LIVE_READ_POLL_MS } from "./types";

/** Sessions list. Keyed `['agent-sessions','list',opts]` — WS-invalidated, and re-read on the live
 *  period while it shows a running session, whose check-ins move no event. */
export function useSessions(opts: ListSessionsOpts) {
  return useQuery({
    queryKey: ["agent-sessions", "list", opts],
    queryFn: () => sessionsApi.list(opts),
    refetchInterval: (query) =>
      query.state.data?.items.some((row) => row.status === "running" && !isInteractiveSession(row))
        ? LIVE_READ_POLL_MS
        : false,
  });
}

/** Per-project queue stats. Keyed `['agent-sessions','queue-stats',projectId]`. */
export function useQueueStats(projectId: string | undefined) {
  return useQuery({
    queryKey: ["agent-sessions", "queue-stats", projectId],
    queryFn: () => sessionsApi.queueStats(projectId as string),
    enabled: !!projectId,
  });
}

/** Per-session cost rollup. Keyed `['agent-sessions',id,'cost']` — WS-invalidated
 *  on session updates so cost refreshes as usage_records land (ISS-378). */
export function useSessionCost(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["agent-sessions", sessionId, "cost"],
    queryFn: () => sessionsApi.cost(sessionId as string),
    enabled: !!sessionId,
  });
}

/** Shared mutation factory: invalidate the list on success, toast on error. */
function useSessionMutation<TArgs, TData>(
  fn: (args: TArgs) => Promise<TData>,
  opts: {
    successMessage?: (data: TData) => string;
    alsoInvalidateQueueStats?: boolean;
    /** What else the act changed, re-read at once. */
    refresh?: (qc: QueryClient) => void;
  } = {},
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["agent-sessions"] });
      opts.refresh?.(qc);
      if (opts.alsoInvalidateQueueStats) {
        qc.invalidateQueries({ queryKey: ["agent-sessions", "queue-stats"] });
      }
      if (opts.successMessage) {
        toast({ title: opts.successMessage(data), tone: "success" });
      }
    },
    onError: (err) => {
      toast({ title: "Action failed", description: formatApiError(err), tone: "error" });
    },
  });
}

/** Every read a stop changes, re-read at once rather than on its next poll: the session itself, the
 *  lists naming it, the holds it kept, the runs it ran and the issue pages showing them, whose run
 *  core closed with it (ISS-1228). */
export function refreshAfterStop(qc: QueryClient): void {
  for (const queryKey of [["agent-sessions"], ["agent-session"], ["sessions-and-holds"], ["run-sessions"], ["issue"]]) {
    void qc.invalidateQueries({ queryKey });
  }
}

export function useCancelSession() {
  return useSessionMutation((id: string) => sessionsApi.cancel(id), {
    successMessage: () => "Session stopped",
    refresh: refreshAfterStop,
  });
}

export function useRetrySession() {
  return useSessionMutation((id: string) => sessionsApi.retry(id), {
    successMessage: () => "Retry queued",
  });
}

export function useRerunSession() {
  return useSessionMutation((id: string) => sessionsApi.rerun(id), {
    successMessage: () => "Rerun started",
  });
}

export function useAbortSession() {
  return useSessionMutation((sessionId: string) => sessionsApi.abort(sessionId), {
    successMessage: () => "Session aborted",
  });
}

export function useSweepZombies() {
  return useSessionMutation((projectId: string) => sessionsApi.sweepZombies(projectId), {
    alsoInvalidateQueueStats: true,
    successMessage: (d) =>
      `Swept ${d.queueTimedOut + d.heartbeatTimedOut} zombie${
        d.queueTimedOut + d.heartbeatTimedOut === 1 ? "" : "s"
      }`,
  });
}
