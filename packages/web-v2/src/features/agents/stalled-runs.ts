import { runIsStalled, sessionIsBeating } from "@/features/runs/derive";
import type { PipelineRunListItem } from "@/features/runs/types";

const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["running", "paused"]);

/** The project's runs that are still open, worked or not, or wait on the answer to their job's question. */
export function openRuns(runs: readonly PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return (runs ?? []).filter((r) => LIVE_RUN_STATUSES.has(r.status) || r.reading === "asking");
}

/** Open runs with a live job or a heartbeating session behind them. */
export function workedRuns(runs: readonly PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return (runs ?? []).filter(
    (r) => LIVE_RUN_STATUSES.has(r.status) && ((r.liveJobs ?? 0) > 0 || sessionIsBeating(r)),
  );
}

export function stalledRuns(
  runs: readonly PipelineRunListItem[] | undefined,
  nowMs: number,
): PipelineRunListItem[] {
  return (runs ?? []).filter((r) => runIsStalled(r, nowMs));
}
