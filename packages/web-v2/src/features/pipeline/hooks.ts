"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { pipelineApi } from "./api";
import type { AnalyticsOpts } from "./types";

/** Per-project run list. Keyed `['pipeline-runs','list',projectId]` — the
 *  router invalidates the `['pipeline-runs','list']` prefix. */
export function useProjectRuns(projectId: string | undefined) {
  return useQuery({
    queryKey: ["pipeline-runs", "list", projectId],
    queryFn: () => pipelineApi.runsForProject({ projectId: projectId as string }),
    enabled: !!projectId,
  });
}

export function useProjectIssues(projectId: string | undefined) {
  return useQuery({
    queryKey: ["issues", "search", projectId, "pipeline"],
    queryFn: () => pipelineApi.issuesForProject(projectId as string),
    enabled: !!projectId,
  });
}

/** Single run rollup. Keyed `['pipeline-run', runId]` — WS-live. Only fetched
 *  when `enabled` (i.e. the SlideOver is open). */
export function useRun(runId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["pipeline-run", runId],
    queryFn: () => pipelineApi.run(runId as string),
    enabled: enabled && !!runId,
  });
}

/** Issue subtasks for the RunDetail Tasks tab. Keyed `['issue',id,'tasks']`.
 *  Only fetched when the SlideOver is open. */
export function useIssueTasks(issueId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["issue", issueId, "tasks"],
    queryFn: () => pipelineApi.tasksForIssue(issueId as string),
    enabled: enabled && !!issueId,
    staleTime: 30_000,
  });
}

/** Cross-project per-step durations + cost. Keyed `['pipeline','step-durations',opts]`. */
export function useStepDurations(opts: AnalyticsOpts = {}) {
  return useQuery({
    queryKey: ["pipeline", "step-durations", opts],
    queryFn: () => pipelineApi.stepDurations(opts),
    staleTime: 30_000,
  });
}

/** Cross-project daily throughput. Keyed `['pipeline','throughput',opts]`. */
export function useThroughput(opts: AnalyticsOpts = {}) {
  return useQuery({
    queryKey: ["pipeline", "throughput", opts],
    queryFn: () => pipelineApi.throughput(opts),
    staleTime: 30_000,
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
      toast({ title: "Run control failed", description: formatApiError(err), tone: "error" });
    },
  });
}

export function usePauseRun() {
  return useRunControl((id) => pipelineApi.pause(id), "Run paused");
}
export function useResumeRun() {
  return useRunControl((id) => pipelineApi.resume(id), "Run resumed");
}
export function useCancelRun() {
  return useRunControl((id) => pipelineApi.cancel(id), "Run cancelled");
}
