// What a project's master owes its running releases, read on every sweep (`masters/owed.ts`): the
// merges of an accepted change-request release, which runs no job and holds no session, so nothing
// but the master makes them (REQ-71 BC-4); and the approval request a release the project requires
// approval for has not asked yet, whose route the master is told by name (ISS-591).

import { desc, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { releaseApprovals } from '../db/schema-release-ledger.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import { issueDisplayIds } from '../issues/index.js';
import { approvalRequired } from '../project-config/index.js';
import { label, mergeStepsOf } from './change-request-roster.js';

/** The next merge an accepted change-request release waits on. */
export interface ReleaseMergeOwed {
  runId: string;
  version: string | null;
  /** The first request in the declared order the host has not merged, and an issue it delivers. */
  next: { label: string; number: number; issueId: string; issueKey: string };
  merged: number;
  total: number;
}

/** A running release whose project requires approval, with no request asked. */
export interface ReleaseApprovalOwed {
  runId: string;
  version: string | null;
}

interface RunRow {
  id: string;
  metadata: unknown;
  release_version: string | null;
}

async function runningReleases(projectId: string): Promise<RunRow[]> {
  return [
    ...(await db.execute<RunRow & Record<string, unknown>>(sql`
      SELECT r.id, r.metadata, r.release_version
        FROM pipeline_runs r
       WHERE r.project_id = ${projectId}
         AND r.kind = 'system'
         AND r.status = 'running'
         AND (r.metadata->>'source') = 'release-batch'
       ORDER BY r.started_at`)),
  ];
}

/** Each run's latest approval decision: `approved`, `returned`, `pending`, or absent where none was asked. */
async function latestDecisions(runIds: readonly string[]) {
  const out = new Map<string, 'approved' | 'returned' | 'pending'>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select({ runId: releaseApprovals.runId, decision: releaseApprovals.decision })
    .from(releaseApprovals)
    .where(inArray(releaseApprovals.runId, [...runIds]))
    .orderBy(desc(releaseApprovals.requestedAt), desc(releaseApprovals.id));
  for (const r of rows) if (!out.has(r.runId)) out.set(r.runId, r.decision ?? 'pending');
  return out;
}

/**
 * The accepted change-request releases of a project with a merge still to make, each naming the next
 * request in its declared order. A release is accepted when its latest approval is approved, or where
 * the project requires none and none was asked: the same rule the merge door admits by
 * (`approvals.ts:assertApprovalAllowsAttempt`). One whose every request merged is its settle's, not
 * the master's, and is not owed.
 */
export async function releaseMergesOwed(projectId: string): Promise<ReleaseMergeOwed[]> {
  const runs = (await runningReleases(projectId)).filter((r) => mergeStepsOf(r.metadata));
  if (runs.length === 0) return [];
  const [decisions, required] = await Promise.all([
    latestDecisions(runs.map((r) => r.id)),
    approvalRequired(projectId),
  ]);
  const accepted = runs.filter((r) => {
    const d = decisions.get(r.id);
    return d === 'approved' || (d === undefined && !required);
  });
  const steps = accepted.flatMap((r) => mergeStepsOf(r.metadata) ?? []);
  if (steps.length === 0) return [];
  const [states, keys] = await Promise.all([
    db
      .select({ id: repoPullRequests.id, state: repoPullRequests.state })
      .from(repoPullRequests)
      .where(
        inArray(
          repoPullRequests.id,
          steps.map((s) => s.pullRequestId),
        ),
      ),
    issueDisplayIds(steps.flatMap((s) => s.issueIds.slice(0, 1))),
  ]);
  const stateOf = new Map(states.map((s) => [s.id, s.state]));
  return accepted.flatMap((r) => {
    const order = mergeStepsOf(r.metadata) ?? [];
    const next = order.find((s) => stateOf.get(s.pullRequestId) !== 'merged');
    const issueId = next?.issueIds[0];
    if (!next || !issueId) return [];
    return [
      {
        runId: r.id,
        version: r.release_version,
        next: {
          label: label(next),
          number: next.number,
          issueId,
          issueKey: keys.get(issueId) ?? issueId,
        },
        merged: order.filter((s) => stateOf.get(s.pullRequestId) === 'merged').length,
        total: order.length,
      },
    ];
  });
}

/** The running releases of a project that requires approval and has none asked (ISS-591). */
export async function releaseApprovalsOwed(projectId: string): Promise<ReleaseApprovalOwed[]> {
  const runs = await runningReleases(projectId);
  if (runs.length === 0 || !(await approvalRequired(projectId))) return [];
  const decisions = await latestDecisions(runs.map((r) => r.id));
  return runs
    .filter((r) => !decisions.has(r.id))
    .map((r) => ({ runId: r.id, version: r.release_version }));
}
