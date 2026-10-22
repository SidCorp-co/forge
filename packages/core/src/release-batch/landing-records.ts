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
import { LANDED_VERIFICATION, landedBuildHolds } from './landed-build.js';

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

/** Where an issue landed: the branch, the commit and when the landing was recorded. */
export interface IssueLanding {
  branch: string;
  commit: string;
  at: string;
}

/** The landing that closed each of `issueIds`, for those standing closed; absent where none did. */
export async function landedRecordsOf(
  issueIds: readonly string[],
): Promise<Map<string, IssueLanding>> {
  const out = new Map<string, IssueLanding>();
  if (issueIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (i.id) i.id::text AS issue_id, r.id::text AS id,
           r.metadata ->> 'branch' AS branch, r.metadata ->> 'commit' AS commit,
           r.started_at AS at, r.metadata -> 'issueIds' AS issue_ids
      FROM issues i
      JOIN pipeline_runs r ON r.project_id = i.project_id AND ${LANDINGS}
                          AND r.metadata -> 'issueIds' ? (i.id::text)
     WHERE i.id IN (${sql.join(
       issueIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND i.status = 'closed'
     ORDER BY i.id, r.started_at DESC
  `)) as unknown as Array<LandingRow & { issue_id: string }>;
  for (const row of rows) {
    const landing = landingOf(row, new Map());
    if (landing) {
      out.set(row.issue_id, { branch: landing.branch, commit: landing.commit, at: landing.at });
    }
  }
  return out;
}

/** The landing that closed this issue, while it stands closed; null where none did. */
export async function landedRecordOf(issueId: string): Promise<IssueLanding | null> {
  return (await landedRecordsOf([issueId])).get(issueId.toLowerCase()) ?? null;
}

/** What a requirement reads of its issues' landings (`requirements/dependents.ts`), handed in at boot. */
export const landingReads = { landedBuildHolds, landedRecordsOf };
