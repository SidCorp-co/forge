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
import { issueDisplayIds, type TransitionActor } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { closeRunIfOneShot, stampReleaseShipped, writeRunMetadata } from '../pipeline/index.js';
import { label, mergeStepsOf, type ReleaseMergeStep } from './change-request-roster.js';
import { closeRoster } from './close-roster.js';
import { oweReleaseTag } from './release-tag.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';

/**
 * Why a settle closed nothing yet: a request still open, a stamp not written, another settling, or
 * a promotion merged whose deploy the operator has still to record (REQ-63 BC-12).
 */
type SettlePending = 'merges' | 'stamps' | 'settling' | 'record';

/** What a settle that closed nothing says: what it waits on, and `waits`, that wait by name. */
type SettleOutcome =
  | { settled: true; pending: null; waits: null }
  | { settled: false; pending: SettlePending | null; waits: string | null };

const waiting = (pending: SettlePending, waits: string): SettleOutcome => ({
  settled: false,
  pending,
  waits,
});

/** The steps not merged yet, each by its label and place, and the door that merges the first. */
function mergesSentence(steps: readonly ReleaseMergeStep[], open: ReleaseMergeStep[]): string {
  const next = open[0] as ReleaseMergeStep;
  const named = open.map((s) => `${label(s)} (step ${steps.indexOf(s) + 1} of ${steps.length})`);
  return `${named.join(', ')} ${open.length === 1 ? 'is' : 'are'} not merged yet, as Forge's record of each request reads it: merge ${label(next)} with \`POST /api/issues/${next.issueIds[0] ?? '<issueId>'}/merge-pull-request\` \`{"pullRequest":${next.number}}\`, which reads the host and records a merge already made there.`;
}

/** The promotion merged: the record of its production deploy closes the release, at that door. */
function recordSentence(projectId: string, step: ReleaseMergeStep | undefined, at: string | null) {
  const merged = step ? `${label(step)} merged${at ? ` at ${at}` : ''}` : 'Its promotion merged';
  return `${merged}, and a promotion release closes on the record of its production deploy, never on its merge: once production serves it, record it with \`POST /api/projects/${projectId}/release-records\` \`{"issueIds":[…],"version":"<version>","account":"<how it was deployed>"}\`.`;
}

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
): Promise<SettleOutcome> {
  const [run] = await db
    .select({
      status: pipelineRuns.status,
      metadata: pipelineRuns.metadata,
      projectId: pipelineRuns.projectId,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  const steps = run ? mergeStepsOf(run.metadata) : null;
  if (run?.status !== 'running' || !steps) return { settled: false, pending: null, waits: null };
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
  const merged = new Set(states.filter((s) => s.state === 'merged').map((s) => s.id));
  const open = steps.filter((s) => !merged.has(s.pullRequestId));
  if (open.length > 0) return waiting('merges', mergesSentence(steps, open));
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
  if (promotion) return waiting('record', recordSentence(run.projectId, steps.at(-1), lastMerge));
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
  const unmarked = claimed.filter((c) => c.mergedAt === null).map((c) => c.id);
  if (unmarked.length > 0) return waiting('stamps', await stampsSentence(unmarked));
  if (!(await takeSettleLease(runId))) {
    return waiting(
      'settling',
      'Every request merged and every issue holds its mark; another settle is closing this release now, and its lease lapses in five minutes if it stops.',
    );
  }
  const { failed } = await closeRoster(claimed, runId, actor, undefined);
  await stampReleaseShipped(runId);
  await recoverStrandedReleasing(runId, {
    reason: 'the release merged its change requests but this issue could not be closed',
    actorUserId: actor.type === 'user' ? actor.id : undefined,
    comment: true,
  });
  await closeRunIfOneShot(runId, 'completed');
  if (failed.length > 0) logger.warn({ runId, failed }, 'change-request release: issues left open');
  return { settled: true, pending: null, waits: null };
}

/** The roster issues holding no merge mark, by key, and the mark each owes. */
async function stampsSentence(unmarked: string[]): Promise<string> {
  const keys = await issueDisplayIds(unmarked);
  const named = unmarked.map((id) => `${keys.get(id) ?? id} (${id})`);
  return `Every request merged, and ${named.join(', ')} ${unmarked.length === 1 ? 'holds' : 'hold'} no merge mark: a merge marks only an issue its commit answers for, and the answer's \`linkedIssues\` and \`refusedStamps\` say why each was not. Mark each with \`POST /api/issues/<id>/merge\` naming the commit that landed it; the last mark closes the release.`;
}
