"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LIVE_READ_POLL_MS } from "@/features/sessions/types";
import { useToast } from "@/providers/toast-provider";
import { runsApi } from "./api";
import type { AnalyticsOpts } from "./types";
import { failureToast } from "@/lib/api/failure-toast";
import { pollUnlessRefused } from "@/lib/api/read-failed";

/** Per-project run list. Keyed `['pipeline-runs','list',projectId]` — the
 *  router invalidates the `['pipeline-runs','list']` prefix. */
export function useProjectRuns(projectId: string | undefined) {
  return useQuery({
    queryKey: ["pipeline-runs", "list", projectId],
    queryFn: () => runsApi.runsForProject({ projectId: projectId as string }),
    enabled: !!projectId,
    // A box's ledger report moves a run's word without an event, so the list polls with the report.
    refetchInterval: (query) => pollUnlessRefused(query, LIVE_READ_POLL_MS),
  });
}

/** Single run rollup. Keyed `['pipeline-run', runId]` — WS-live. Only fetched
 *  when `enabled` (i.e. the SlideOver is open). */
export function useRun(runId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["pipeline-run", runId],
    queryFn: () => runsApi.run(runId as string),
    enabled: enabled && !!runId,
    refetchInterval: (query) => pollUnlessRefused(query, LIVE_READ_POLL_MS),
  });
}

/** Per-step durations + cost; cross-project when `opts` names no project. `enabled: false` sends nothing meanwhile. */
export function useStepDurations(opts: AnalyticsOpts = {}, enabled = true) {
  return useQuery({
    queryKey: ["pipeline", "step-durations", opts],
    queryFn: () => runsApi.stepDurations(opts),
    staleTime: 30_000,
    enabled,
  });
}

/** Daily throughput; cross-project when `opts` names no project. */
export function useThroughput(opts: AnalyticsOpts = {}, enabled = true) {
  return useQuery({
    queryKey: ["pipeline", "throughput", opts],
    queryFn: () => runsApi.throughput(opts),
    staleTime: 30_000,
    enabled,
  });
}

/** Shared run-control mutation factory: invalidate the run list + the run
 *  detail on success, toast on success/error. */
function useRunControl(
  fn: (id: string) => Promise<unknown>,
  successMessage: string,
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => fn(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["pipeline-runs"] });
      qc.invalidateQueries({ queryKey: ["pipeline-run", id] });
      qc.invalidateQueries({ queryKey: ["projects", "health"] });
      toast({ title: successMessage, tone: "success" });
    },
    onError: (err) => {
      toast(failureToast(err, "The run was not changed"));
    },
  });
}

export function usePauseRun() {
  return useRunControl((id) => runsApi.pause(id), "Run paused");
}
export function useResumeRun() {
  return useRunControl((id) => runsApi.resume(id), "Run resumed");
}
export function useCancelRun() {
  return useRunControl((id) => runsApi.cancel(id), "Run cancelled");
}
