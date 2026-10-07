// What another module records on a run it does not own: a metadata value and a release's version
// and ship stamps. The pipeline owns `pipeline_runs`, so these are its only writes on another
// module's behalf; a run's status moves only through the kernel transition.

import { and, eq, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { emitEvent } from '../outbox/index.js';

type RunMetadataWrite = (
  | {
      /** The new `metadata`, as an expression that may read the row's current `metadata`. */
      value: SQL;
    }
  | {
      /** Keys merged over the current `metadata` at the top level. */
      merge: Record<string, unknown>;
    }
) & {
  /** A further condition the row must meet; no row is written when it does not. */
  when?: SQL | undefined;
  /** Whether the write also moves `updated_at`. */
  touch: boolean;
};

/** Write a run's metadata; false when no row met the condition. */
export async function writeRunMetadata(
  runId: string,
  write: RunMetadataWrite,
  executor: Tx = db,
): Promise<boolean> {
  const metadata =
    'value' in write
      ? write.value
      : sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb) || ${JSON.stringify(write.merge)}::jsonb`;
  const rows = await executor
    .update(pipelineRuns)
    .set(write.touch ? { metadata, updatedAt: sql`now()` } : { metadata })
    .where(and(eq(pipelineRuns.id, runId), write.when))
    .returning({ id: pipelineRuns.id });
  return rows.length > 0;
}

/** Give a release run its version, once; false when the run already carries one. */
export async function stampReleaseVersion(
  runId: string,
  version: string,
  executor: Tx = db,
): Promise<boolean> {
  const rows = await executor
    .update(pipelineRuns)
    .set({ releaseVersion: version, updatedAt: sql`now()` })
    .where(and(eq(pipelineRuns.id, runId), isNull(pipelineRuns.releaseVersion)))
    .returning({ id: pipelineRuns.id });
  return rows.length === 1;
}

/**
 * Stamp the moment a versioned release shipped, once: a retry never moves it. The stamp that took
 * tells the outbox (`release.shipped`) in the same unit, so the people whose feedback the release
 * closed hear of it exactly when it is on record and a retry never tells them twice.
 */
export async function stampReleaseShipped(runId: string, executor: Tx = db): Promise<void> {
  const rows = await executor
    .update(pipelineRuns)
    .set({ releaseReleasedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(pipelineRuns.id, runId),
        isNotNull(pipelineRuns.releaseVersion),
        isNull(pipelineRuns.releaseReleasedAt),
      ),
    )
    .returning({
      projectId: pipelineRuns.projectId,
      version: pipelineRuns.releaseVersion,
      metadata: pipelineRuns.metadata,
    });
  const shipped = rows[0];
  if (!shipped?.version) return;
  const ids = (shipped.metadata as { issueIds?: unknown } | null)?.issueIds;
  await emitEvent(executor, 'release.shipped', {
    projectId: shipped.projectId,
    runId,
    version: shipped.version,
    issueIds: Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : [],
  });
}
