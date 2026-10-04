// What another module records on a run it does not own: a metadata value and a release's version
// and ship stamps. The pipeline owns `pipeline_runs`, so these are its only writes on another
// module's behalf; a run's status moves only through the kernel transition.

import { and, eq, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';

export interface RunMetadataWrite {
  /** The new `metadata`, as an expression that may read the row's current `metadata`. */
  value: SQL;
  /** A further condition the row must meet; no row is written when it does not. */
  when?: SQL | undefined;
  /** Whether the write also moves `updated_at`. */
  touch: boolean;
}

/** Write a run's metadata; false when no row met the condition. */
export async function writeRunMetadata(
  runId: string,
  write: RunMetadataWrite,
  executor: Tx = db,
): Promise<boolean> {
  const rows = await executor
    .update(pipelineRuns)
    .set(write.touch ? { metadata: write.value, updatedAt: sql`now()` } : { metadata: write.value })
    .where(and(eq(pipelineRuns.id, runId), write.when))
    .returning({ id: pipelineRuns.id });
  return rows.length > 0;
}

/** Merge `patch` over a run's metadata, key by key at the top level. */
export function mergedMetadata(patch: Record<string, unknown>): SQL {
  return sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
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

/** Stamp the moment a versioned release shipped, once: a retry never moves it. */
export async function stampReleaseShipped(runId: string, executor: Tx = db): Promise<void> {
  await executor
    .update(pipelineRuns)
    .set({ releaseReleasedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(pipelineRuns.id, runId),
        isNotNull(pipelineRuns.releaseVersion),
        isNull(pipelineRuns.releaseReleasedAt),
      ),
    );
}
