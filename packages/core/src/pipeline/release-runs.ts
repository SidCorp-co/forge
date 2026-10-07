// Which run wears a release version. Since a number an ended batch never spent is worn again by the
// next batch (`release-batch/version-store.ts:highestSpentVersion`), several runs can carry one
// `release_version`; every reader resolves it here, so a version names one run everywhere.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
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

/** The release that shipped an issue, by the version it wears and when it shipped. */
export interface ShippedRelease {
  version: string;
  at: string;
}

/**
 * The release that shipped each of `issueIds`: a shipped release-batch run whose roster names it,
 * or that closed it afterwards (`metadata.rosterClosed`, `release-batch/versions.ts:issueIdsOf`) —
 * the latest ship where several carried it. An issue no shipped release carries is absent.
 */
export async function shippedReleasesOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, ShippedRelease>> {
  if (issueIds.length === 0) return new Map();
  const listed = (key: 'issueIds' | 'rosterClosed') =>
    sql.raw(
      `jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.metadata -> '${key}') = 'array' THEN r.metadata -> '${key}' ELSE '[]'::jsonb END)`,
    );
  const rows = rowsOf<{ issue_id: string; version: string; at: string | Date }>(
    await db.execute(sql`
      SELECT DISTINCT ON (m.issue_id) m.issue_id, r.release_version AS version, r.release_released_at AS at
        FROM pipeline_runs r
        CROSS JOIN LATERAL (SELECT ${listed('issueIds')} UNION SELECT ${listed('rosterClosed')}) AS m(issue_id)
       WHERE r.project_id = ${projectId}
         AND r.release_version IS NOT NULL
         AND r.release_released_at IS NOT NULL
         AND m.issue_id IN (${idList(issueIds)})
       ORDER BY m.issue_id, r.release_released_at DESC`),
  );
  return new Map(
    rows.map((r) => [r.issue_id, { version: r.version, at: new Date(r.at).toISOString() }]),
  );
}
