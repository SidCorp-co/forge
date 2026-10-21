"use client";

import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { moveSessionInLiveReads } from "@/features/pipeline/live-read";
import { type ListSessionsOpts, sessionsApi } from "./api";
import { endedSilentText } from "./status-sentences";
import { isInteractiveSession, LIVE_READ_POLL_MS } from "./types";
import { failureToast } from "@/lib/api/failure-toast";

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
    refresh?: (qc: QueryClient, data: TData) => void;
  } = {},
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["agent-sessions"] });
      opts.refresh?.(qc, data);
      if (opts.alsoInvalidateQueueStats) {
        qc.invalidateQueries({ queryKey: ["agent-sessions", "queue-stats"] });
      }
      if (opts.successMessage) {
        toast({ title: opts.successMessage(data), tone: "success" });
      }
    },
    onError: (err) => {
      toast(failureToast(err, "The session was not changed"));
    },
  });
}

/** Every read a stop changes, re-read at once rather than on its next poll: the session itself, the
 *  lists naming it, the holds it kept, the runs it ran and the issue pages showing them, whose run
 *  core closed with it (ISS-1228). */
export function refreshAfterStop(qc: QueryClient, stopped?: { id: string; status: string }): void {
  // A box's count of live sessions drops at once, before the re-read lands.
  if (stopped) moveSessionInLiveReads(qc, stopped.id, stopped.status);
  for (const queryKey of [
    ["agent-sessions"],
    ["agent-session"],
    ["sessions-and-holds"],
    ["run-sessions"],
    ["issue"],
    ["run-journal"],
  ]) {
    void qc.invalidateQueries({ queryKey });
  }
}

/** What every surface that stops a session says once it has (ISS-1228). */
export const SESSION_STOPPED = "Session stopped";

/** What ending only the current turn says: the session itself stays open (ISS-1228). */
export const TURN_ENDED = "Turn ended. The session stays open.";

export function useCancelSession() {
  return useSessionMutation((id: string) => sessionsApi.cancel(id), {
    successMessage: () => SESSION_STOPPED,
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
    successMessage: () => TURN_ENDED,
  });
}

export function useSweepZombies() {
  return useSessionMutation((projectId: string) => sessionsApi.sweepZombies(projectId), {
    alsoInvalidateQueueStats: true,
    successMessage: endedSilentText,
  });
}
