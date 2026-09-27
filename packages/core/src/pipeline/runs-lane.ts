/** ISS-1273 — which lane opened a pipeline run, and what its step can mean there. Its literals
 *  come from `run-session-keys.js`: `run-session.js` drags the database in behind them. */

import type { pipelineRuns } from '../db/schema.js';
import { RUN_ISSUES_METADATA_KEY, RUN_SESSION_METADATA_TYPE } from '../devices/run-session-keys.js';

type RunRow = typeof pipelineRuns.$inferSelect;

/**
 * ISS-1273 — which lane opened this run, so a null `issueRef` or `currentStep` is a declared
 * structural absence. `run_session` is a box driving a GROUP (`devices/run-session.ts`), where
 * `issue_id` is null by construction and the group is `runIssues`; `system` is neither.
 */
export type PipelineRunLane = 'job' | 'run_session' | 'system';

/** ISS-1273 — where a run's step came from, and where there is none, why. */
export type PipelineRunStep =
  | { source: 'run_column'; step: string; detail: null }
  | { source: 'phase_journal'; step: string; detail: null }
  | { source: 'none'; step: null; detail: string };

export function runIssuesOf(metadata: unknown): string[] {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>)[RUN_ISSUES_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

export function laneOf(row: RunRow): PipelineRunLane {
  if (row.issueId !== null) return 'job';
  const metadata = row.metadata;
  const type =
    typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).type
      : undefined;
  return type === RUN_SESSION_METADATA_TYPE ? 'run_session' : 'system';
}

export function noStepDetail(lane: PipelineRunLane): string {
  if (lane === 'run_session') {
    return 'a box drives this run over a group of issues and its driver has no phase open, so core holds no step for it';
  }
  if (lane === 'job') {
    return 'no pipeline step has been stamped on this run yet';
  }
  return 'this run belongs to neither the job nor the run-session lane, and no step is kept for it';
}

export function stepOf(
  lane: PipelineRunLane,
  currentStep: string | null,
  openPhase?: string,
): PipelineRunStep {
  if (currentStep !== null) return { source: 'run_column', step: currentStep, detail: null };
  if (openPhase !== undefined) return { source: 'phase_journal', step: openPhase, detail: null };
  return { source: 'none', step: null, detail: noStepDetail(lane) };
}
