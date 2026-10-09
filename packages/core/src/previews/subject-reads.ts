// What a preview of something other than an issue's run reads from the records it is about (REQ-41):
// the requirement or feedback item an idea or a reproduce names, the build a reproduce serves, and
// the feedback items an issue's fix answers. Reads only; each module's own rows are written by it.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface Item {
  id: string;
  key: string;
  kind: 'requirement' | 'feedback';
  title: string;
}

const KEY = /^(REQ|FB)-(\d{1,9})$/;

/** The requirement or feedback item `key` names in the project, or null where it names none. */
export async function itemOf(projectId: string, key: string): Promise<Item | null> {
  const m = KEY.exec(key);
  if (!m) return null;
  const seq = Number(m[2]);
  const rows = (m[1] === 'REQ'
    ? await db.execute(
        sql`SELECT id, title FROM requirements WHERE project_id = ${projectId}::uuid AND req_seq = ${seq}`,
      )
    : await db.execute(
        sql`SELECT id, title FROM feedback WHERE project_id = ${projectId}::uuid AND fb_seq = ${seq}`,
      )) as unknown as { id: string; title: string | null }[];
  const row = rows[0];
  return row
    ? {
        id: row.id,
        key,
        kind: m[1] === 'REQ' ? 'requirement' : 'feedback',
        title: row.title ?? key,
      }
    : null;
}

/** A feedback item as a reproduce reads it: when it was filed and the release it names, if any. */
export async function feedbackForBuild(
  projectId: string,
  key: string,
): Promise<{ id: string; createdAt: Date; releaseRunId: string | null } | null> {
  const m = /^FB-(\d{1,9})$/.exec(key);
  if (!m) return null;
  const rows = (await db.execute(sql`
    SELECT id, created_at, release_run_id FROM feedback
     WHERE project_id = ${projectId}::uuid AND fb_seq = ${Number(m[1])}
  `)) as unknown as { id: string; created_at: Date | string; release_run_id: string | null }[];
  const row = rows[0];
  return row
    ? { id: row.id, createdAt: new Date(row.created_at), releaseRunId: row.release_run_id }
    : null;
}

export interface ShippedBuild {
  sha: string;
  release: string;
}

const SHIPPED = sql`metadata ->> 'source' = 'release-batch'
       AND metadata -> 'finish' ->> 'state' = 'finished'
       AND release_version IS NOT NULL
       AND release_released_at IS NOT NULL
       AND (metadata -> 'finish' ->> 'commit') ~* '^[0-9a-f]{40}$'`;

const asBuild = (rows: unknown): ShippedBuild | null => {
  const row = (rows as { version: string; commit: string }[])[0];
  return row ? { sha: row.commit.toLowerCase(), release: row.version } : null;
};

/** The shipped release a version names in the project (`release-batch` runs), with its commit. */
export async function releaseNamed(projectId: string, version: string) {
  return asBuild(
    await db.execute(sql`
      SELECT release_version AS version, metadata -> 'finish' ->> 'commit' AS commit
        FROM pipeline_runs
       WHERE project_id = ${projectId}::uuid AND release_version = ${version} AND ${SHIPPED}
       LIMIT 1
    `),
  );
}

/** The shipped release a release run is, with its commit. */
export async function releaseOfRun(projectId: string, runId: string) {
  return asBuild(
    await db.execute(sql`
      SELECT release_version AS version, metadata -> 'finish' ->> 'commit' AS commit
        FROM pipeline_runs
       WHERE project_id = ${projectId}::uuid AND id = ${runId}::uuid AND ${SHIPPED}
       LIMIT 1
    `),
  );
}

/**
 * The release live when `at` passed: the last one shipped at or before it. Forge keeps release
 * history for what a release run shipped, and every release run ships to production.
 */
export async function releaseLiveAt(projectId: string, at: Date) {
  return asBuild(
    await db.execute(sql`
      SELECT release_version AS version, metadata -> 'finish' ->> 'commit' AS commit
        FROM pipeline_runs
       WHERE project_id = ${projectId}::uuid AND release_released_at <= ${at.toISOString()}::timestamptz
         AND ${SHIPPED}
       ORDER BY release_released_at DESC, id DESC
       LIMIT 1
    `),
  );
}

/** The release whose commit `sha` is, where it is one. */
export async function releaseOfSha(projectId: string, sha: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT release_version AS version FROM pipeline_runs
     WHERE project_id = ${projectId}::uuid AND lower(metadata -> 'finish' ->> 'commit') = ${sha.toLowerCase()}
       AND ${SHIPPED}
     ORDER BY release_released_at DESC
     LIMIT 1
  `)) as unknown as { version: string }[];
  return rows[0]?.version ?? null;
}

/** The feedback items whose triage routes them to `issueId`: the ones its fix answers. */
export async function feedbackRoutedTo(issueId: string): Promise<{ id: string; key: string }[]> {
  const rows = (await db.execute(sql`
    SELECT f.id, f.fb_seq FROM feedback_route_issues r
      JOIN feedback f ON f.id = r.feedback_id
     WHERE r.issue_id = ${issueId}::uuid AND f.route = 'issue'
     ORDER BY f.fb_seq
  `)) as unknown as { id: string; fb_seq: number }[];
  return rows.map((r) => ({ id: r.id, key: `FB-${r.fb_seq}` }));
}
