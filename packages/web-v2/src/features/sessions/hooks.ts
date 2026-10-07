"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
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
  opts: { successMessage?: (data: TData, t: Copy) => string; alsoInvalidateQueueStats?: boolean } = {},
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["agent-sessions"] });
      qc.invalidateQueries({ queryKey: ["agent-session"] });
      if (opts.alsoInvalidateQueueStats) {
        qc.invalidateQueries({ queryKey: ["agent-sessions", "queue-stats"] });
      }
      if (opts.successMessage) {
        toast({ title: opts.successMessage(data, t), tone: "success" });
      }
    },
    onError: (err) => {
      toast({ title: t("sessions.toast.failed"), description: formatApiError(err), tone: "error" });
    },
  });
}

export function useCancelSession() {
  return useSessionMutation((id: string) => sessionsApi.cancel(id), {
    successMessage: (_d, t) => t("sessions.toast.cancelled"),
  });
}

export function useRetrySession() {
  return useSessionMutation((id: string) => sessionsApi.retry(id), {
    successMessage: (_d, t) => t("sessions.toast.retryQueued"),
  });
}

export function useRerunSession() {
  return useSessionMutation((id: string) => sessionsApi.rerun(id), {
    successMessage: (_d, t) => t("sessions.toast.rerunStarted"),
  });
}

export function useAbortSession() {
  return useSessionMutation((sessionId: string) => sessionsApi.abort(sessionId), {
    successMessage: (_d, t) => t("sessions.toast.aborted"),
  });
}

export function useSweepZombies() {
  return useSessionMutation((projectId: string) => sessionsApi.sweepZombies(projectId), {
    alsoInvalidateQueueStats: true,
    successMessage: (d, t) => {
      const n = d.queueTimedOut + d.heartbeatTimedOut;
      return t(n === 1 ? "sessions.toast.sweptOne" : "sessions.toast.sweptMany", { n });
    },
  });
}
