import type { pipelineRuns } from '../db/schema.js';
import {
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
  RUN_SESSION_METADATA_TYPE,
} from '../devices/run-session-keys.js';

type RunRow = typeof pipelineRuns.$inferSelect;

/** ISS-1273 — which lane opened this run, so a null `issueRef` or `currentStep` is a declared
 *  absence. `run_session` is a box driving a GROUP, `issue_id` null by construction. */
export type PipelineRunLane = 'job' | 'run_session' | 'system';

/** ISS-1273 — where a run's step came from, and where there is none, why. */
export type PipelineRunStep =
  | { source: 'run_column'; step: string; detail: null }
  | { source: 'phase_journal'; step: string; detail: null }
  | { source: 'none'; step: null; detail: string };

/** ISS-1273 — the issues a run was opened over, and where that answer came from: `[]` with no
 *  source cannot tell a run with no group from a group the response lost. */
export type PipelineRunGroup =
  | { source: 'run_group'; issues: string[]; detail: null }
  | { source: 'statuses_at_open'; issues: string[]; detail: null }
  | { source: 'none'; issues: []; detail: string };

function metadataObject(metadata: unknown): Record<string, unknown> | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  return metadata as Record<string, unknown>;
}

function stringsAt(metadata: Record<string, unknown> | null, key: string): string[] | null {
  const raw = metadata?.[key];
  if (!Array.isArray(raw)) return null;
  const keys = raw.filter((v): v is string => typeof v === 'string');
  return keys.length === 0 ? null : keys;
}

/** `runGroup`, which nothing rewrites. A run older than that key falls back to
 *  `runIssueStatuses`, stamped at the same open — members, not order, a jsonb map having none.
 *  The shrunken `runIssues` is never read: on a finished run it is no group, not a smaller one. */
export function groupOf(row: RunRow, lane: PipelineRunLane): PipelineRunGroup {
  if (lane !== 'run_session') {
    return {
      source: 'none',
      issues: [],
      detail:
        lane === 'job'
          ? 'a job-lane run carries its one issue in its own column, not a group'
          : 'this run was not opened over a group of issues',
    };
  }
  const metadata = metadataObject(row.metadata);
  const stamped = stringsAt(metadata, RUN_GROUP_METADATA_KEY);
  if (stamped) return { source: 'run_group', issues: stamped, detail: null };

  const statuses = metadataObject(metadata?.[RUN_ISSUE_STATUSES_METADATA_KEY]);
  const keys = statuses === null ? [] : Object.keys(statuses);
  if (keys.length > 0) return { source: 'statuses_at_open', issues: keys, detail: null };

  return {
    source: 'none',
    issues: [],
    detail:
      'this run was opened on the run-session lane before core recorded the group separately from what the run still holds, and every issue it held has since been given back, so the group it was opened over is not recoverable from this row',
  };
}

export function laneOf(row: RunRow): PipelineRunLane {
  if (row.issueId !== null) return 'job';
  const type = metadataObject(row.metadata)?.type;
  return type === RUN_SESSION_METADATA_TYPE ? 'run_session' : 'system';
}

/** ISS-1273 — what to say when no step is held. Each sentence is about THIS ROW: naming a group
 *  the row does not carry, or a lane that keeps no step, is prose the fields beside it falsify. */
export function noStepDetail(lane: PipelineRunLane, group?: PipelineRunGroup): string {
  if (lane === 'run_session') {
    const named =
      group && group.issues.length > 0
        ? `over ${group.issues.join(', ')}`
        : 'over a group this row no longer names';
    return `a box drives this run ${named} and its driver has no phase open, so core holds no step for it`;
  }
  if (lane === 'job') {
    return 'no pipeline step has been stamped on this run yet';
  }
  return 'nothing has stamped a step on this run, and it is on neither the job nor the run-session lane, so neither of their step writers ever runs for it';
}

/** The column is refused on `run_session`: `runs.ts:setCurrentStep` never runs there, so a value
 *  in it would credit a writer that lane does not have. The journal is its only source. */
export function stepOf(
  lane: PipelineRunLane,
  currentStep: string | null,
  openPhase?: string,
  group?: PipelineRunGroup,
): PipelineRunStep {
  if (lane === 'run_session') {
    return openPhase === undefined
      ? { source: 'none', step: null, detail: noStepDetail(lane, group) }
      : { source: 'phase_journal', step: openPhase, detail: null };
  }
  if (currentStep !== null) return { source: 'run_column', step: currentStep, detail: null };
  return { source: 'none', step: null, detail: noStepDetail(lane, group) };
}
