"use client";

// web-v2 feature module: sessions — React Query hooks.
//
// Query-key contract (ISS-291): every key MUST start with `['agent-sessions']`,
// the exact prefix the WS event-router invalidates on
// `agent-session.created/updated/status/deleted` (+ `replayOnReconnect`). Pick
// any other prefix and live updates silently no-op. See
// `lib/ws/event-router.ts`.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { type ListSessionsOpts, sessionsApi } from "./api";

/** Sessions list. Keyed `['agent-sessions','list',opts]` — WS-invalidated. */
export function useSessions(opts: ListSessionsOpts) {
  return useQuery({
    queryKey: ["agent-sessions", "list", opts],
    queryFn: () => sessionsApi.list(opts),
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

/** Shared mutation factory: invalidate the list on success, toast on error. */
function useSessionMutation<TArgs, TData>(
  fn: (args: TArgs) => Promise<TData>,
  opts: { successMessage?: (data: TData) => string; alsoInvalidateQueueStats?: boolean } = {},
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["agent-sessions"] });
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

export function useCancelSession() {
  return useSessionMutation((id: string) => sessionsApi.cancel(id), {
    successMessage: () => "Session cancelled",
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
