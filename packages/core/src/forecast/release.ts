/**
 * What a forecast reads about the release that follows a landing: how the project releases
 * (`project-config/release-path.ts:releaseModeOf`), the number the next cut takes, the landed→released
 * durations of the issues its release runs shipped (`pipeline_runs.metadata.issueIds` and the ship
 * stamp `release_released_at`), and which version shipped each closed issue.
 */

import { FORECAST_WINDOW_DAYS } from '@forge/contracts/forecast';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { readReleaseMode } from '../project-config/index.js';
import { nextDraftVersion } from '../release-batch/index.js';
import type { ReleaseFacts, Shipped } from './delivery.js';

export async function readReleaseFacts(projectId: string, now: Date): Promise<ReleaseFacts> {
  const mode = await readReleaseMode(projectId);
  const [nextVersion, lags] = await Promise.all([
    mode === 'manual' || mode === 'approval' ? nextDraftVersion(projectId) : null,
    mode === 'automatic' ? readReleaseLags(projectId, now) : [],
  ]);
  return { mode, nextVersion, lags };
}

async function readReleaseLags(projectId: string, now: Date): Promise<number[]> {
  const rows = rowsOf<{ minutes: number }>(
    await db.execute(sql`
      SELECT EXTRACT(EPOCH FROM (r.release_released_at - i.merged_at)) / 60 AS minutes
        FROM pipeline_runs r
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(r.metadata -> 'issueIds') = 'array' THEN r.metadata -> 'issueIds' ELSE '[]'::jsonb END
        ) AS m(issue_id)
        JOIN issues i ON i.id::text = m.issue_id AND i.project_id = r.project_id
       WHERE r.project_id = ${projectId}
         AND r.release_released_at IS NOT NULL
         AND r.release_released_at >= ${now.toISOString()}::timestamptz - (${FORECAST_WINDOW_DAYS}::int * interval '1 day')
         AND r.release_released_at <= ${now.toISOString()}::timestamptz
         AND i.merged_at IS NOT NULL
         AND i.merged_at <= r.release_released_at`),
  );
  return rows.map((r) => Number(r.minutes));
}

/** The version that shipped each of `issueIds` and when, the latest ship where several carried it. */
export async function readShipped(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, Shipped>> {
  if (issueIds.length === 0) return new Map();
  const rows = rowsOf<{ issue_id: string; version: string; at: string }>(
    await db.execute(sql`
      SELECT DISTINCT ON (m.issue_id) m.issue_id, r.release_version AS version, r.release_released_at AS at
        FROM pipeline_runs r
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(r.metadata -> 'issueIds') = 'array' THEN r.metadata -> 'issueIds' ELSE '[]'::jsonb END
        ) AS m(issue_id)
       WHERE r.project_id = ${projectId}
         AND r.release_released_at IS NOT NULL
         AND m.issue_id IN (${idList(issueIds)})
       ORDER BY m.issue_id, r.release_released_at DESC`),
  );
  return new Map(
    rows.map((r) => [r.issue_id, { version: r.version, at: new Date(r.at).toISOString() }]),
  );
}
