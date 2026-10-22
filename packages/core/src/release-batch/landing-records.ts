/**
 * The landings recorded as releases on a project with no production environment
 * (`recorded-landing.ts`), read back for the surfaces that name what a release did: the Releases list
 * and an issue's release line. A landing has no version and deployed nothing, so it is named by its
 * branch and commit and never as a release that went out.
 */

import type { ReleaseLanding } from '@forge/contracts/releases';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueDisplayIds } from '../issues/index.js';
import { RELEASE_RECORD_SOURCE } from './claim-conflicts.js';
import { LANDED_VERIFICATION } from './landed-build.js';

interface LandingRow {
  id: string;
  branch: string | null;
  commit: string | null;
  at: Date | string | null;
  issue_ids: unknown;
}

const LANDINGS = sql`r.metadata ->> 'source' = ${RELEASE_RECORD_SOURCE}
  AND r.metadata ->> 'verification' = ${LANDED_VERIFICATION}`;

function landingOf(row: LandingRow, shown: ReadonlyMap<string, string>): ReleaseLanding | null {
  if (!row.branch || !row.commit || !row.at) return null;
  const ids = Array.isArray(row.issue_ids) ? (row.issue_ids as unknown[]) : [];
  return {
    runId: row.id,
    branch: row.branch,
    commit: row.commit,
    at: new Date(row.at).toISOString(),
    issues: ids.flatMap((id) => (typeof id === 'string' ? [shown.get(id) ?? id] : [])),
  };
}

/** The project's recorded landings, newest first. */
export async function landingRecordsOf(projectId: string, limit = 50): Promise<ReleaseLanding[]> {
  const rows = (await db.execute(sql`
    SELECT r.id::text AS id, r.metadata ->> 'branch' AS branch, r.metadata ->> 'commit' AS commit,
           r.started_at AS at, r.metadata -> 'issueIds' AS issue_ids
      FROM pipeline_runs r
     WHERE r.project_id = ${projectId}::uuid AND ${LANDINGS}
     ORDER BY r.started_at DESC
     LIMIT ${limit}
  `)) as unknown as LandingRow[];
  const ids = rows.flatMap((r) => (Array.isArray(r.issue_ids) ? (r.issue_ids as string[]) : []));
  const shown = ids.length > 0 ? await issueDisplayIds(ids) : new Map<string, string>();
  return rows.flatMap((r) => landingOf(r, shown) ?? []);
}

/** The landing that closed this issue, while it stands closed; null where none did. */
export async function landedRecordOf(
  issueId: string,
): Promise<{ branch: string; commit: string; at: string } | null> {
  const [row] = (await db.execute(sql`
    SELECT r.id::text AS id, r.metadata ->> 'branch' AS branch, r.metadata ->> 'commit' AS commit,
           r.started_at AS at, r.metadata -> 'issueIds' AS issue_ids
      FROM pipeline_runs r
      JOIN issues i ON i.project_id = r.project_id AND i.id = ${issueId}::uuid AND i.status = 'closed'
     WHERE ${LANDINGS} AND r.metadata -> 'issueIds' ? (i.id::text)
     ORDER BY r.started_at DESC
     LIMIT 1
  `)) as unknown as LandingRow[];
  const landing = row ? landingOf(row, new Map()) : null;
  return landing ? { branch: landing.branch, commit: landing.commit, at: landing.at } : null;
}
