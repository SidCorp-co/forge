// The releases a workspace's lanes draw (ISS-979, the owner's mockup v3): each release run that shipped,
// started or ended over the lane, or still runs, as one marker per version. A version several runs wore
// is the run that wears it (`pipeline/release-runs.ts`'s rule: the one that shipped, else the newest),
// and what it carries is its roster as the release page reads it (`release-batch:issueIdsOf`). One
// statement for the runs and one for their issues, however many projects.

import {
  ORG_ACTIVITY_RELEASE_ISSUES,
  type OrgActivityLaneRelease,
  type OrgActivityReleaseState,
  type OrgActivityReleasing,
  type OrgActivityReleasingStage,
} from '@forge/contracts/org-activity';
import { withoutRecordKeys } from '@forge/contracts/record-keys';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { issueIdsOf } from '../release-batch/index.js';

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
const uuids = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

interface RunRow {
  project_id: string;
  version: string;
  status: string;
  metadata: Record<string, unknown> | null;
  started_at: string | Date;
  released_at: string | Date | null;
  ended_at: string | Date | null;
}

const iso = (v: string | Date) => new Date(v).toISOString();

/** A run's marker state: shipped (or landed) is released, an open run releasing, an aborted one stopped, else failed. */
export function releaseStateOf(
  r: Pick<RunRow, 'status' | 'released_at' | 'metadata'>,
): OrgActivityReleaseState {
  if (r.released_at) return 'released';
  if (r.status === 'running' || r.status === 'paused') return 'releasing';
  return r.metadata?.abort ? 'stopped' : 'failed';
}

/** Where a marker stands: at its ship, at its start while it runs, else at its end. */
function placedAt(r: RunRow, state: OrgActivityReleaseState): string {
  if (state === 'released' && r.released_at) return iso(r.released_at);
  if (state === 'releasing') return iso(r.started_at);
  return iso(r.ended_at ?? r.started_at);
}

/** Of two runs at one version, the one wearing it: the one that shipped, else the newest. */
const wears = (row: RunRow, held: RunRow) =>
  (row.released_at !== null) !== (held.released_at !== null)
    ? row.released_at !== null
    : Date.parse(String(row.started_at)) > Date.parse(String(held.started_at));

/** Each project's release markers over `from`..`to`, oldest first. */
export async function readLaneReleases(
  projectIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Map<string, OrgActivityLaneRelease[]>> {
  const out = new Map<string, OrgActivityLaneRelease[]>(projectIds.map((id) => [id, []]));
  if (projectIds.length === 0) return out;
  const since = sql`${from.toISOString()}::timestamptz`;
  const runs = rowsOf<RunRow>(
    await db.execute(sql`
      SELECT r.project_id, r.release_version AS version, r.status, r.metadata, r.started_at,
             r.release_released_at AS released_at, COALESCE(r.finished_at, r.updated_at) AS ended_at
        FROM pipeline_runs r
       WHERE r.project_id IN (${uuids(projectIds)})
         AND r.release_version IS NOT NULL
         AND r.metadata ->> 'source' IN ('release-batch', 'release-record')
         AND (r.release_released_at >= ${since} OR r.started_at >= ${since}
              OR r.finished_at >= ${since} OR r.status IN ('running', 'paused'))`),
  );
  const wearing = new Map<string, RunRow>();
  for (const r of runs) {
    const key = `${r.project_id}|${r.version}`;
    const held = wearing.get(key);
    if (!held || wears(r, held)) wearing.set(key, r);
  }
  const placed = [...wearing.values()].flatMap((r) => {
    const state = releaseStateOf(r);
    const at = placedAt(r, state);
    // a run still releasing that began before the lane stands at its edge
    const shown = state === 'releasing' && at < from.toISOString() ? from.toISOString() : at;
    if (shown < from.toISOString() || shown > to.toISOString()) return [];
    return [{ r, state, at: shown, ids: issueIdsOf(r.metadata ?? {}) }];
  });
  const named = placed.flatMap((p) => p.ids.slice(0, ORG_ACTIVITY_RELEASE_ISSUES));
  const issues = named.length
    ? rowsOf<{ id: string; iss_seq: number; title: string; issue_prefix: string | null }>(
        await db.execute(sql`
          SELECT i.id, i.iss_seq, i.title, p.issue_prefix
            FROM issues i JOIN projects p ON p.id = i.project_id
           WHERE i.id IN (${uuids(named)})`),
      )
    : [];
  const byId = new Map(issues.map((i) => [String(i.id), i]));
  for (const p of placed.sort((a, b) => a.at.localeCompare(b.at))) {
    out.get(String(p.r.project_id))?.push({
      at: p.at,
      version: p.r.version,
      state: p.state,
      total: p.ids.length,
      issues: p.ids.slice(0, ORG_ACTIVITY_RELEASE_ISSUES).flatMap((id) => {
        const i = byId.get(id);
        if (!i) return [];
        return [
          {
            key: formatIssueRef(i.issue_prefix, Number(i.iss_seq)),
            title: withoutRecordKeys(String(i.title), i.issue_prefix ? [i.issue_prefix] : []),
          },
        ];
      }),
    });
  }
  return out;
}

interface ReleasingRow {
  project_id: string;
  version: string;
  started_at: string | Date;
  released_at: string | Date | null;
  attempt: string | null;
}

/** How far a release run in flight got: shipped once it shipped, deploying once an attempt began, else cut. */
export function releasingStageOf(
  r: Pick<ReleasingRow, 'released_at' | 'attempt'>,
): OrgActivityReleasingStage {
  if (r.released_at) return 'shipped';
  return r.attempt ? 'deploying' : 'cut';
}

/**
 * Each project's release run that was cut and still runs (ISS-1051): the newest running or paused
 * release run, with how far it got by its own records, its ship and its deploy attempts. One
 * statement however many projects, read on the page's path, so a run deploying is never hidden
 * behind a held forecast that reads only the next release.
 */
export async function readReleasing(
  projectIds: readonly string[],
): Promise<Map<string, OrgActivityReleasing>> {
  const out = new Map<string, OrgActivityReleasing>();
  if (projectIds.length === 0) return out;
  const runs = rowsOf<ReleasingRow>(
    await db.execute(sql`
      SELECT DISTINCT ON (r.project_id)
             r.project_id, r.release_version AS version, r.started_at,
             r.release_released_at AS released_at,
             (SELECT a.stage FROM release_attempts a
               WHERE a.run_id = r.id ORDER BY a.started_at DESC LIMIT 1) AS attempt
        FROM pipeline_runs r
       WHERE r.project_id IN (${uuids(projectIds)})
         AND r.release_version IS NOT NULL
         AND r.metadata ->> 'source' IN ('release-batch', 'release-record')
         AND r.status IN ('running', 'paused')
       ORDER BY r.project_id, r.started_at DESC`),
  );
  for (const r of runs) {
    out.set(String(r.project_id), {
      version: r.version,
      stage: releasingStageOf(r),
      since: iso(r.started_at),
    });
  }
  return out;
}
