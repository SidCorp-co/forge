// Which run wears a release version. Since a number an ended batch never spent is worn again by the
// next batch (`release-batch/version-store.ts:highestSpentVersion`), several runs can carry one
// `release_version`; every reader resolves it here, so a version names one run everywhere.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';

export interface ReleaseRunRow {
  id: string;
  status: string;
  version: string;
  metadata: Record<string, unknown>;
  startedAt: Date;
  releasedAt: Date | null;
}

/** Which of two runs at one version wears it: the one that shipped, else the newest. */
function wearsOver(row: ReleaseRunRow, held: ReleaseRunRow): boolean {
  if ((row.releasedAt !== null) !== (held.releasedAt !== null)) return row.releasedAt !== null;
  return row.startedAt > held.startedAt;
}

/** One release-batch run per version, the one wearing it; every version, or just `version`. */
export async function releaseRunsByVersion(
  projectId: string,
  version?: string,
): Promise<ReleaseRunRow[]> {
  const rows = await db
    .select({
      id: pipelineRuns.id,
      status: pipelineRuns.status,
      version: pipelineRuns.releaseVersion,
      metadata: pipelineRuns.metadata,
      startedAt: pipelineRuns.startedAt,
      releasedAt: pipelineRuns.releaseReleasedAt,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        sql`${pipelineRuns.releaseVersion} IS NOT NULL`,
        sql`${pipelineRuns.metadata}->>'source' = 'release-batch'`,
        ...(version ? [eq(pipelineRuns.releaseVersion, version)] : []),
      ),
    );
  const byVersion = new Map<string, ReleaseRunRow>();
  for (const r of rows) {
    const row = {
      ...r,
      version: r.version as string,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    };
    const held = byVersion.get(row.version);
    if (!held || wearsOver(row, held)) byVersion.set(row.version, row);
  }
  return [...byVersion.values()];
}

/** The run that wears `version` in this project, or `null` when none does. */
export async function runWearingVersion(
  projectId: string,
  version: string,
): Promise<ReleaseRunRow | null> {
  return (await releaseRunsByVersion(projectId, version))[0] ?? null;
}
