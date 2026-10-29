// REQ-63: the close of a release that went out through change requests. Once its last request merged
// and every issue it carries holds its merge stamp, the roster closes, the ship is stamped and the run
// completes — on the merge route's own call, or on the approval wake. A host's report of a merge
// settles nothing (ISS-774, owner 2026-10-29: Forge tells the agent what is owed and writes nothing
// from a webhook). The first settle that finds every request merged owes the release's tag on its
// last merge (REQ-63 BC-13); a promotion merged on the host is recorded through the merge route,
// which the master is owed (`merges-owed.ts`).

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import type { TransitionActor } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { closeRunIfOneShot, stampReleaseShipped, writeRunMetadata } from '../pipeline/index.js';
import { mergeStepsOf } from './change-request-roster.js';
import { closeRoster } from './finish.js';
import { oweReleaseTag } from './release-tag.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';

/**
 * Why a settle closed nothing yet: a request still open, a stamp not written, another settling, or
 * a promotion merged whose deploy the operator has still to record (REQ-63 BC-12).
 */
type SettlePending = 'merges' | 'stamps' | 'settling' | 'record';

/** How long one settle holds its release before another may take it over. */
const SETTLE_LEASE = sql`interval '5 minutes'`;

/** The settle's hold on its release, taken where none is held or the last one lapsed. */
function takeSettleLease(runId: string): Promise<boolean> {
  const settling = sql`${pipelineRuns.metadata}->>'settling'`;
  return writeRunMetadata(runId, {
    value: sql`jsonb_set(coalesce(${pipelineRuns.metadata}, '{}'::jsonb), '{settling}', to_jsonb(now()::text))`,
    when: and(
      eq(pipelineRuns.status, 'running'),
      sql`(${settling} IS NULL OR (${settling})::timestamptz < now() - ${SETTLE_LEASE})`,
    ),
    touch: false,
  });
}

/**
 * The release closed once its last change request merged and every issue it carries holds its merge:
 * the roster closes, the ship is stamped, and the run completes. A release with no request to merge,
 * every issue already on the target branch (`create.ts`), settles on its approval. A call before
 * then changes nothing and says what it waits on; one settle runs at a time, under a lease on the run.
 */
export async function settleChangeRequestRelease(
  runId: string,
  actor: TransitionActor,
): Promise<{ settled: boolean; pending: SettlePending | null }> {
  const [run] = await db
    .select({ status: pipelineRuns.status, metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  const steps = run ? mergeStepsOf(run.metadata) : null;
  if (run?.status !== 'running' || !steps) return { settled: false, pending: null };
  const states =
    steps.length === 0
      ? []
      : await db
          .select({
            id: repoPullRequests.id,
            state: repoPullRequests.state,
            mergeCommitSha: repoPullRequests.mergeCommitSha,
          })
          .from(repoPullRequests)
          .where(
            inArray(
              repoPullRequests.id,
              steps.map((s) => s.pullRequestId),
            ),
          );
  if (states.length < steps.length || states.some((s) => s.state !== 'merged')) {
    return { settled: false, pending: 'merges' };
  }
  // the commit the release's version names is its last merge, known now and before any deploy:
  // its tag is owed there, once (REQ-63 BC-13); a roster that merged nothing names none
  const lastMerge =
    states.find((s) => s.id === steps.at(-1)?.pullRequestId)?.mergeCommitSha ?? null;
  const promotion = (run.metadata as { promotion?: unknown } | null)?.promotion;
  // a promotion whose merge commit the host has not reported yet owes it on a later settle
  if (!promotion || lastMerge) {
    await oweReleaseTag(runId, lastMerge, promotion ? 'promotion' : 'merge');
  }
  // a promotion release is closed by the record of its deploy, never by its merge
  if (promotion) return { settled: false, pending: 'record' };
  const claimed = await db
    .select({
      id: issues.id,
      status: issues.status,
      reopenCount: issues.reopenCount,
      projectId: issues.projectId,
      mergedAt: issues.mergedAt,
    })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, runId));
  // a roster issue with no mark is not landed yet: its agent owes the mark first
  if (claimed.some((c) => c.mergedAt === null)) return { settled: false, pending: 'stamps' };
  if (!(await takeSettleLease(runId))) return { settled: false, pending: 'settling' };
  const { failed } = await closeRoster(claimed, runId, actor, undefined);
  await stampReleaseShipped(runId);
  await recoverStrandedReleasing(runId, {
    reason: 'the release merged its change requests but this issue could not be closed',
    actorUserId: actor.type === 'user' ? actor.id : undefined,
    comment: true,
  });
  await closeRunIfOneShot(runId, 'completed');
  if (failed.length > 0) logger.warn({ runId, failed }, 'change-request release: issues left open');
  return { settled: true, pending: null };
}
