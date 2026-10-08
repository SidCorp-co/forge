/**
 * What a forecast reads about the release that follows a landing: how the project releases
 * (`project-config/release-path.ts:releaseModeOf`), the number the next cut takes, the landed→released
 * durations of the issues its release runs shipped (`pipeline_runs.metadata.issueIds` and the ship
 * stamp `release_released_at`), and which version shipped each closed issue.
 */

import {
  FORECAST_WINDOW_DAYS,
  RELEASE_ACT_PERMISSION,
  type ReleaseLeg,
  type ReleaseMode,
} from '@forge/contracts/forecast';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { holds, namedHolders } from '../permissions/index.js';
import { shippedReleasesOf } from '../pipeline/index.js';
import { readReleaseMode } from '../project-config/index.js';
import { nextDraftVersion } from '../release-batch/index.js';
import { type ReleaseFacts, releaseLegOf, type Shipped } from './delivery.js';

/** Who reads a forecast, with the grants that decide whether a person's act it names is theirs. */
export interface ForecastViewer {
  userId: string;
  isAdmin: boolean;
  mayApprove: boolean;
  canWrite: boolean;
}

/** Whether the act a release mode leaves to a person is the viewer's: approve, cut, or release by hand. */
function viewerOwesRelease(mode: ReleaseMode, viewer: ForecastViewer | null): boolean {
  if (!viewer) return false;
  if (mode === 'approval') return viewer.mayApprove;
  if (mode === 'manual') return viewer.isAdmin;
  return mode === 'none' && viewer.canWrite;
}

export async function readReleaseFacts(
  projectId: string,
  now: Date,
  viewer: ForecastViewer | null,
): Promise<ReleaseFacts> {
  const mode = await readReleaseMode(projectId);
  const [nextVersion, lags, holders] = await Promise.all([
    mode === 'manual' || mode === 'approval' ? nextDraftVersion(projectId) : null,
    mode === 'automatic' ? readReleaseLags(projectId, now) : [],
    mode === 'automatic' ? [] : namedHolders(RELEASE_ACT_PERMISSION[mode], projectId),
  ]);
  return { mode, nextVersion, lags, holders, viewerOwes: viewerOwesRelease(mode, viewer) };
}

/**
 * What follows a landing on this project, as `userId` reads it: the release on its own, or the act a
 * person owes (theirs where they hold its grant, else its holders by name), for a read model outside
 * the forecast that names who a landed change waits on. A reader with no grant on the project owes nothing.
 */
export async function releaseLegFor(
  projectId: string,
  userId: string | null,
  now: Date = new Date(),
): Promise<ReleaseLeg> {
  const access = userId ? await effectiveProjectRole(userId, projectId) : null;
  const viewer =
    userId && access
      ? {
          userId,
          isAdmin: holds(access, 'project.admin'),
          mayApprove: holds(access, 'releases.approve'),
          canWrite: holds(access, 'project.write'),
        }
      : null;
  return releaseLegOf(await readReleaseFacts(projectId, now, viewer));
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

/** The version that shipped each of `issueIds` and when: `pipeline/release-runs.ts:shippedReleasesOf`. */
export async function readShipped(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, Shipped>> {
  return shippedReleasesOf(projectId, issueIds);
}
