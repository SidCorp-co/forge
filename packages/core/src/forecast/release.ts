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
import { rowsOf, uuidArray } from '../db/raw-sql.js';
import { idOfParts, partsOf, rowsPerId } from '../db/read-memo.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { holds, namedHolders } from '../permissions/index.js';
import { shippedReleasesOf } from '../pipeline/index.js';
import { readReleaseMode } from '../project-config/index.js';
import { draftReleaseIssueIds, nextDraftVersion, readReleaseOwes } from '../release-batch/index.js';
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
  const [nextVersion, lags, holders, owes] = await Promise.all([
    mode === 'manual' || mode === 'approval' ? nextDraftVersion(projectId) : null,
    mode === 'automatic' ? readReleaseLags(projectId, now) : [],
    mode === 'automatic' ? [] : namedHolders(RELEASE_ACT_PERMISSION[mode], projectId),
    // who owes the release act is the one rule's, read with what the draft carries (ISS-1058)
    mode === 'automatic'
      ? undefined
      : draftReleaseIssueIds(projectId).then((ids) => readReleaseOwes(projectId, ids)),
  ]);
  return {
    mode,
    nextVersion,
    lags,
    holders,
    viewerOwes: viewerOwesRelease(mode, viewer),
    ...(owes ? { owes } : {}),
  };
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

/**
 * A uuid as Postgres prints one: a run's issue id named any other way names no issue, as comparing
 * it to `issues.id::text` read it. Joined by the key instead, each released run no longer scans the
 * project's merged issues (130 ms at forge's size, ISS-1070 r15).
 */
const CANONICAL_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * The minutes from merge to release of each issue the project released in the window ending at
 * `now`, every project a person's read asks read in one statement (`db/read-memo.ts:rowsPerId`),
 * each at its own clock: each project that deploys on land read its own, five a read on forge-dev
 * (ISS-1070 r15). In a fixed order, so a forecast's seeded draw from them is the same read alone or
 * beside other projects.
 */
async function readReleaseLags(projectId: string, now: Date): Promise<number[]> {
  const rows = await rowsPerId(
    'releaseLags',
    [idOfParts(projectId, now.toISOString())],
    async (keys) => {
      const pairs = keys.map(partsOf);
      const rows = rowsOf<{ project_id: string; at: string; minutes: number }>(
        await db.execute(sql`
          SELECT k.project_id::text AS project_id, k.at, EXTRACT(EPOCH FROM (r.release_released_at - i.merged_at)) / 60 AS minutes
            FROM unnest(${uuidArray(pairs.map(([project]) => project as string))},
                        ${sql.param(pairs.map(([, at]) => at as string))}::text[]) AS k(project_id, at)
            JOIN pipeline_runs r ON r.project_id = k.project_id
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(r.metadata -> 'issueIds') = 'array' THEN r.metadata -> 'issueIds' ELSE '[]'::jsonb END
            ) AS m(issue_id)
            JOIN issues i ON i.id = CASE WHEN m.issue_id ~ ${CANONICAL_UUID} THEN m.issue_id::uuid END
                         AND i.project_id = r.project_id
           WHERE r.release_released_at IS NOT NULL
             AND r.release_released_at >= k.at::timestamptz - (${FORECAST_WINDOW_DAYS}::int * interval '1 day')
             AND r.release_released_at <= k.at::timestamptz
             AND i.merged_at IS NOT NULL
             AND i.merged_at <= r.release_released_at
           ORDER BY k.project_id, k.at, r.release_released_at, r.id, m.issue_id`),
      );
      return rows.map((r) => ({ key: idOfParts(r.project_id, r.at), minutes: r.minutes }));
    },
    (r) => r.key,
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
