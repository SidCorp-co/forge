import type { PipelineRunListItem } from "@/features/runs/types";

const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["running", "paused"]);

export const RUN_START_GRACE_MS = 3 * 60_000;

/** Core ends a silent session itself, so a session it holds open is an agent behind the run. */
export function sessionIsBeating(run: Pick<PipelineRunListItem, "lastSessionBeatAt">): boolean {
  return run.lastSessionBeatAt != null && !Number.isNaN(Date.parse(run.lastSessionBeatAt));
}

/** Whether a run that has never been heard from is still inside its start-up grace. */
function runIsStartingUp(
  run: Pick<PipelineRunListItem, "lastSessionBeatAt" | "startedAt">,
  nowMs: number,
): boolean {
  if (run.lastSessionBeatAt) return false;
  const started = Date.parse(run.startedAt);
  if (Number.isNaN(started)) return false;
  return nowMs - started <= RUN_START_GRACE_MS;
}

/** The project's runs that are still open, worked or not. */
export function openRuns(runs: readonly PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return (runs ?? []).filter((r) => LIVE_RUN_STATUSES.has(r.status));
}

/** Open runs with a live job or a heartbeating session behind them. */
export function workedRuns(runs: readonly PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return (runs ?? []).filter(
    (r) => LIVE_RUN_STATUSES.has(r.status) && ((r.liveJobs ?? 0) > 0 || sessionIsBeating(r)),
  );
}

/**
 * Live runs with neither a live job nor a heartbeating session.
 */
export function stalledRuns(
  runs: readonly PipelineRunListItem[] | undefined,
  nowMs: number,
): PipelineRunListItem[] {
  return (runs ?? []).filter(
    (r) =>
      LIVE_RUN_STATUSES.has(r.status) &&
      (r.liveJobs ?? 0) === 0 &&
      !sessionIsBeating(r) &&
      !runIsStartingUp(r, nowMs),
  );
}
