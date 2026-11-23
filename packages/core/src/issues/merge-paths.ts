import type { ReadPaths } from '@forge/contracts/landing-artifacts';
import type { OutboxActor } from '@forge/contracts/outbox-events';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { emitEvent } from '../outbox/index.js';
import type { MergeRecordExecutor } from './merge-record.js';

// What a mark writes onto a stamped row besides the stamp itself: the paths a box read and the
// branch the work landed on. Neither is one of the columns `merge-record.ts` alone writes
// (scripts/check-merged-at-writers.mjs), so they live here and keep that file under its line cap.

/**
 * The paths a box read for the landing commit from its own checkout, written onto a stamped row that
 * holds none: the first reading stands, as the first stamp does. Called in the mark's transaction
 * after the stamp, so a mark refused later drops it too: docs/modules/issues/merge-mark.md.
 */
export async function recordReadPaths(
  executor: Tx,
  args: { issueId: string; paths: ReadPaths; actor: OutboxActor },
): Promise<{ wrote: boolean; held: ReadPaths | null }> {
  const [wrote] = await executor
    .update(issues)
    .set({ mergedPaths: args.paths, updatedAt: sql`now()` })
    .where(and(eq(issues.id, args.issueId), isNotNull(issues.mergedAt), isNull(issues.mergedPaths)))
    .returning({ projectId: issues.projectId });
  if (wrote) {
    await emitEvent(executor, 'issue.updated', {
      issueId: args.issueId,
      projectId: wrote.projectId,
      actor: args.actor,
      fields: ['mergedPaths'],
      via: 'mark',
      before: { mergedPaths: null },
      after: { mergedPaths: args.paths },
    });
    return { wrote: true, held: args.paths };
  }
  const [row] = await executor
    .select({ mergedPaths: issues.mergedPaths })
    .from(issues)
    .where(eq(issues.id, args.issueId))
    .limit(1);
  return { wrote: false, held: row?.mergedPaths ?? null };
}

// the first target named on a standing mark that Forge did not observe is the branch the work
// landed on; a later mark with another target does not move it, as a later stamp does not move
// merged_at. A row holding an observed commit holds the target that observation read
// (`recordIssueMerge`), and a mark's word never stands in for it (catalog-fe ISS-11..19, 2026-10-26:
// `release/stg` written by a mark beside merges GitLab made into `dev`).
export async function recordMergeTarget(
  executor: MergeRecordExecutor,
  issueId: string,
  target: string,
): Promise<void> {
  await executor
    .update(issues)
    .set({ mergedTarget: target })
    .where(
      and(
        eq(issues.id, issueId),
        isNotNull(issues.mergedAt),
        isNull(issues.mergedTarget),
        sql`coalesce(trim(${issues.mergedCommitSha}), '') = ''`,
      ),
    );
}
