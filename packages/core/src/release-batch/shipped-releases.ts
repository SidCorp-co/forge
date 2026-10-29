// The releases a project shipped, as Forge recorded them: a release-batch run whose finish reads
// `finished`, whose ship stamp is set, and whose `finish.commit` is the commit the probes verified
// live. Read from Forge's own rows only; no source host is asked.

import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { issueIdsOf } from './versions.js';

/** A release Forge verified shipping: the version it cut and the commit production served. */
export interface ShippedRelease {
  runId: string;
  version: string;
  commit: string;
}

/** A shipped release with the issues it carries (`versions.ts:issueIdsOf`) and when it was cut. */
export interface ShippedReleaseRun extends ShippedRelease {
  issueIds: string[];
  cutAt: Date;
}

/** Releases that shipped, oldest first, each with the issues it carries. */
export async function shippedReleaseRuns(projectId: string): Promise<ShippedReleaseRun[]> {
  const rows = await db
    .select({
      runId: pipelineRuns.id,
      version: pipelineRuns.releaseVersion,
      commit: sql<string | null>`${pipelineRuns.metadata} -> 'finish' ->> 'commit'`,
      metadata: pipelineRuns.metadata,
      cutAt: pipelineRuns.createdAt,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        sql`${pipelineRuns.metadata} ->> 'source' = 'release-batch'`,
        sql`${pipelineRuns.metadata} -> 'finish' ->> 'state' = 'finished'`,
        isNotNull(pipelineRuns.releaseVersion),
        isNotNull(pipelineRuns.releaseReleasedAt),
      ),
    )
    .orderBy(asc(pipelineRuns.releaseReleasedAt), asc(pipelineRuns.id));
  return rows.flatMap((r) =>
    r.version && r.commit && /^[0-9a-f]{40}$/i.test(r.commit)
      ? [
          {
            runId: r.runId,
            version: r.version,
            commit: r.commit.toLowerCase(),
            issueIds: issueIdsOf((r.metadata ?? {}) as Record<string, unknown>),
            cutAt: r.cutAt,
          },
        ]
      : [],
  );
}
