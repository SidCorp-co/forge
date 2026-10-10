"use client";

import { useQuery } from "@tanstack/react-query";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useToastWrite } from "@/providers/toast-write";
import { type ListSessionsOpts, sessionsApi } from "./api";
import { sessionsKeys, sessionsQueries } from "./queries";

/** Sessions list. Keyed `['agent-sessions','list',opts]` — WS-invalidated. */
export function useSessions(opts: ListSessionsOpts) {
  return useQuery(sessionsQueries.list(opts));
}

/** Per-project queue stats. Keyed `['agent-sessions','queue-stats',projectId]`. */
export function useQueueStats(projectId: string | undefined) {
  return useQuery(sessionsQueries.queueStats(projectId));
}

/** Per-session cost rollup. Keyed `['agent-sessions',id,'cost']` — WS-invalidated
 *  on session updates so cost refreshes as usage_records land (ISS-378). */
export function useSessionCost(sessionId: string | undefined) {
  return useQuery(sessionsQueries.cost(sessionId));
}

/** A sessions write: the list and every session detail are read again; the queue stats too where the write moves the queue. */
function useSessionMutation<TArgs, TData>(
  fn: (args: TArgs) => Promise<TData>,
  opts: { successMessage?: (data: TData, t: Copy) => string; alsoInvalidateQueueStats?: boolean } = {},
) {
  const t = useCopy();
  return useToastWrite(fn, {
    touches: [sessionsKeys.all, ["agent-session"], ...(opts.alsoInvalidateQueueStats ? [sessionsKeys.queueStatsAll()] : [])],
    said: opts.successMessage ? (data: TData) => opts.successMessage?.(data, t) : undefined,
    failed: t("sessions.toast.failed"),
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
