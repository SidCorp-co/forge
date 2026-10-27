/**
 * The landings recorded as releases on a project with no production environment
 * (`recorded-landing.ts`), read back for the surfaces that name what a landing did: the Releases
 * list and an issue's release line. A landing takes a version in the transaction that records it, so
 * it is a release on that list; the list's `landings` are only the rows recorded before that, which
 * claimed no number then and are given none now (ADR 0011, "History is not rewritten").
 */

import type { ReleaseLanding } from '@forge/contracts/releases';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueDisplayIds } from '../issues/index.js';
import { RELEASE_RECORD_SOURCE } from './claim-conflicts.js';
import { LANDED_VERIFICATION } from './landed-build.js';
import { landedBuildHolds } from './landed-build-holds.js';

interface LandingRow {
  id: string;
  branch: string | null;
  commit: string | null;
  at: Date | string | null;
  issue_ids: unknown;
}

/** The fields every landing carries; `recorded-landing.ts` refuses a record without them. */
interface Landing {
  runId: string;
  branch: string;
  commit: string;
  at: string;
  issueIds: string[];
}

const LANDINGS = sql`r.metadata ->> 'source' = ${RELEASE_RECORD_SOURCE}
  AND r.metadata ->> 'verification' = ${LANDED_VERIFICATION}`;

/** A landing row as recorded; one missing what every record carries is refused by name, never skipped. */
function landingOf(row: LandingRow): Landing {
  if (!row.branch || !row.commit || !row.at) {
    throw new Error(
      `landing record ${row.id} names no ${!row.branch ? 'branch' : !row.commit ? 'commit' : 'start time'}: ` +
        'every landing is recorded on its branch at a whole commit (recorded-landing.ts:recordLanding)',
    );
  }
  const ids = Array.isArray(row.issue_ids) ? (row.issue_ids as unknown[]) : [];
  return {
    runId: row.id,
    branch: row.branch,
    commit: row.commit,
    at: new Date(row.at).toISOString(),
    issueIds: ids.filter((id): id is string => typeof id === 'string'),
  };
}

/**
 * The project's landings recorded before a recorded landing took a version (2026-10-26), newest
 * first, on any project: one whose document later declared production recorded them all the same.
 * Every one is read; the set is closed, since no door records an unversioned landing any more.
 */
export async function landingRecordsOf(projectId: string): Promise<ReleaseLanding[]> {
  const rows = (await db.execute(sql`
    SELECT r.id::text AS id, r.metadata ->> 'branch' AS branch, r.metadata ->> 'commit' AS commit,
           r.started_at AS at, r.metadata -> 'issueIds' AS issue_ids, r.status
      FROM pipeline_runs r
     WHERE r.project_id = ${projectId}::uuid AND ${LANDINGS} AND r.release_version IS NULL
     ORDER BY r.started_at DESC, r.id DESC
  `)) as unknown as Array<LandingRow & { status: string }>;
  const landings = rows.map((r) => ({ landing: landingOf(r), status: r.status }));
  const ids = landings.flatMap((l) => l.landing.issueIds);
  const shown = ids.length > 0 ? await issueDisplayIds(ids) : new Map<string, string>();
  return landings.map(({ landing: { issueIds, ...l }, status }) => ({
    ...l,
    issues: issueIds.map((id) => shown.get(id) ?? id),
    // `recordLanding` ends its run `failed` where some issue it named would not close
    closedAll: status === 'completed',
  }));
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
    const landing = landingOf(row);
    out.set(row.issue_id, { branch: landing.branch, commit: landing.commit, at: landing.at });
  }
  return out;
}

/** The landing that closed this issue, while it stands closed; null where none did. */
export async function landedRecordOf(issueId: string): Promise<IssueLanding | null> {
  return (await landedRecordsOf([issueId])).get(issueId.toLowerCase()) ?? null;
}

/** What a requirement reads of its issues' landings (`requirements/dependents.ts`), handed in at boot. */
export const landingReads = { landedBuildHolds, landedRecordsOf };
