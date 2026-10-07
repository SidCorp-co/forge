import {
  MASTER_SESSION_KIND,
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
  RUN_SESSION_KIND,
} from '@forge/contracts/agent-sessions';
import { type Said, say, sayEn } from '@forge/contracts/said';
import type { pipelineRuns } from '../db/schema.js';

type RunRow = typeof pipelineRuns.$inferSelect;

/** ISS-1273 — which lane opened this run, so a null `issueRef` or `currentStep` is a declared
 *  absence. `run_session` is a box driving a GROUP, `issue_id` null by construction. `master` is
 *  a resident master's own run (ISS-1335): no issue, no job and no step, for as long as it lives. */
export type PipelineRunLane = 'job' | 'run_session' | 'master' | 'system';

/** ISS-1335 — the live master session on a master-lane run, as `residentMasterSql` shapes it. */
export interface ResidentMaster {
  sessionId: string;
  name: string | null;
  lastHeartbeatAt: string | null;
}

/** ISS-1273 — where a run's step came from, and where there is none, why. */
export type PipelineRunStep =
  | { source: 'run_column'; step: string; detail: null }
  | { source: 'phase_journal'; step: string; detail: null }
  | { source: 'none'; step: null; detail: string; says: { detail: Said } };

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

const NO_GROUP_DETAIL: Record<Exclude<PipelineRunLane, 'run_session'>, string> = {
  job: 'a job-lane run carries its one issue in its own column, not a group',
  master:
    'a resident master opens its run over no group of issues; each issue it dispatches is carried by a run of its own',
  system: 'this run was not opened over a group of issues',
};

/** `runGroup`, which nothing rewrites. A run older than that key falls back to
 *  `runIssueStatuses`, stamped at the same open — members, not order, a jsonb map having none.
 *  The shrunken `runIssues` is never read: on a finished run it is no group, not a smaller one. */
export function groupOf(row: Pick<RunRow, 'metadata'>, lane: PipelineRunLane): PipelineRunGroup {
  if (lane !== 'run_session') {
    return { source: 'none', issues: [], detail: NO_GROUP_DETAIL[lane] };
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

export function laneOf(row: Pick<RunRow, 'issueId' | 'metadata'>): PipelineRunLane {
  if (row.issueId !== null) return 'job';
  const type = metadataObject(row.metadata)?.type;
  if (type === RUN_SESSION_KIND) return 'run_session';
  return type === MASTER_SESSION_KIND ? 'master' : 'system';
}

/** ISS-1335 — never from the lane alone: `closeMasterSession` leaves the run `running`. */
function masterDetail(master: ResidentMaster | null | undefined): Said {
  if (!master) return say('runs.step.masterGone');
  return master.name
    ? say('runs.step.masterNamed', { name: master.name })
    : say('runs.step.masterSession', { id: master.sessionId });
}

/** ISS-1273 — what to say when no step is held. Each sentence is about THIS ROW: naming a group
 *  the row does not carry, or a lane that keeps no step, is prose the fields beside it falsify. */
function noStepDetail(
  lane: PipelineRunLane,
  group?: PipelineRunGroup,
  master?: ResidentMaster | null,
): Said {
  if (lane === 'master') return masterDetail(master);
  if (lane === 'run_session') {
    return group && group.issues.length > 0
      ? say('runs.step.boxOver', { keys: group.issues.join(', ') })
      : say('runs.step.boxOverUnnamed');
  }
  if (lane === 'job') return say('runs.step.jobNone');
  return say('runs.step.noLane');
}

const noStep = (detail: Said): PipelineRunStep => ({
  source: 'none',
  step: null,
  detail: sayEn(detail),
  says: { detail },
});

/** The column is refused on `run_session`: `runs.ts:setCurrentStep` never runs there, so a value
 *  in it would credit a writer that lane does not have. The journal is its only source. */
export function stepOf(
  lane: PipelineRunLane,
  currentStep: string | null,
  openPhase?: string,
  group?: PipelineRunGroup,
  master?: ResidentMaster | null,
): PipelineRunStep {
  if (lane === 'run_session') {
    return openPhase === undefined
      ? noStep(noStepDetail(lane, group))
      : { source: 'phase_journal', step: openPhase, detail: null };
  }
  if (currentStep !== null) return { source: 'run_column', step: currentStep, detail: null };
  return noStep(noStepDetail(lane, group, master));
}
