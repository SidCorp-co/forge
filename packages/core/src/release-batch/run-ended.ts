/**
 * How a release run ended and what it carried, read from its own record (ISS-1079). The batch read
 * (`queries.ts:loadReleaseBatchContext`) named a run's issues from the claims it holds and its gate
 * from the project's live gate, so a completed run whose claims its finish released read
 * `issues: []` and `gateStatus: 'awaiting_release'` (sidcorp-mail 0.16.0, run 8250311b): nothing
 * said it shipped, or what.
 */

import { eq, inArray, or, type SQL } from 'drizzle-orm';
import { issues, type PipelineRunStatus } from '../db/schema.js';
import { readFinishRecord } from './finish-record.js';
import { issueIdsOf } from './versions.js';

/** Where a release run ended; absent while it runs. */
export interface ReleaseRunEnded {
  /** `shipped` where its ship is stamped; otherwise the status it ended at. */
  state: 'shipped' | 'completed' | 'failed' | 'cancelled';
  /** When it shipped, else when it ended; null where neither is recorded. */
  at: string | null;
  /** Its finish's last state, or null where it took no finish. */
  finish: string | null;
  /** The commit its finish records it shipped, or null where it names none. */
  commit: string | null;
}

const ENDED: ReadonlySet<PipelineRunStatus> = new Set(['completed', 'failed', 'cancelled']);

const iso = (at: Date | null) => (at ? at.toISOString() : null);

type RunRecord = {
  status: PipelineRunStatus;
  releasedAt: Date | null;
  finishedAt: Date | null;
  metadata: Record<string, unknown>;
};

/**
 * How the run ended, and which issues the batch read names: those it claims while it runs; once it
 * ended, those its record names, and any it still claims (`ended-claims.ts`).
 */
export function endedAccount(
  runId: string,
  run: RunRecord,
): { ended: ReleaseRunEnded | null; issuesWhere: SQL | undefined } {
  const ended = runEnded(run);
  const claimed = eq(issues.releaseBatchRunId, runId);
  const recorded = ended ? endedRunIssueIds(run.metadata, ended) : [];
  return {
    ended,
    issuesWhere: recorded.length > 0 ? or(claimed, inArray(issues.id, recorded)) : claimed,
  };
}

/** How the run ended, or null while it runs. */
export function runEnded(run: RunRecord): ReleaseRunEnded | null {
  const shipped = run.releasedAt !== null;
  if (!shipped && !ENDED.has(run.status)) return null;
  const finish = readFinishRecord(run.metadata);
  return {
    state: shipped ? 'shipped' : (run.status as ReleaseRunEnded['state']),
    at: iso(run.releasedAt ?? run.finishedAt),
    finish: finish?.state ?? null,
    commit: finish?.commit ?? null,
  };
}

/**
 * The issues an ended run's record names: what it carried where it shipped or completed
 * (`versions.ts:issueIdsOf`), else the roster it was cut over.
 */
export function endedRunIssueIds(meta: Record<string, unknown>, ended: ReleaseRunEnded): string[] {
  if (ended.state === 'shipped' || ended.state === 'completed') return issueIdsOf(meta);
  const roster = meta.issueIds;
  return Array.isArray(roster) ? roster.filter((x): x is string => typeof x === 'string') : [];
}
