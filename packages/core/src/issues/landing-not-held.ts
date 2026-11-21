/**
 * ISS-1340 (FB-750) — the issues whose only landing is a commit their repository answered it does
 * not hold, which no release of the project can ship.
 *
 * The mark stays the marker's word (owner, 2026-11-05, ISS-1017), so this is read, never refused:
 * the release sweep leaves such an issue out and holds it naming the route
 * (`release-batch/landing-not-held-hold.ts`), instead of drafting a release that can never ship it
 * (forge 0.4.0-dev.742, ISS-1339 marked at forge-plugin's c49b46a).
 *
 * What the repository answered is the current mark's own reading, recorded by the mark
 * (`commit-landing.ts:commitReadingOf`, on the trail record `mark-trail.ts:recordMarkTrail` writes).
 * Only `not_found` counts: the source host answering that the commit resolves to no object there.
 * `unread` (no source host, a read that failed, no base branch) says nothing about the commit, and
 * such an issue is weighed as before. No source host is asked here: the sweep reads the record.
 */

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { uuidArray } from '../db/raw-sql.js';
import { MARK_RECORD, UNMARK_RECORD } from './mark-trail.js';

/** A landing no release of the project can ship: the commit claimed, and what the repository said. */
export interface LandingNotHeld {
  commit: string;
  /** The repository's own words for the read, as the mark recorded them. */
  detail: string;
}

/**
 * Of `issueIds`, those whose only landing is a commit the repository answered it does not hold: no
 * observed commit, no landing named, and the current mark (the newest stamped mark, where no unmark
 * came after it) claims a commit whose reading is `not_found`.
 */
export async function landingsNotHeldOf(
  issueIds: readonly string[],
  executor: Pick<Tx, 'execute'> = db,
): Promise<Map<string, LandingNotHeld>> {
  const out = new Map<string, LandingNotHeld>();
  if (issueIds.length === 0) return out;
  const found = (await executor.execute(sql`
    SELECT cur.issue_id, cur.payload ->> 'commit' AS commit,
           cur.payload -> 'commitReading' ->> 'detail' AS detail
      FROM (
        SELECT DISTINCT ON (a.issue_id) a.issue_id, a.action, a.payload
          FROM activity_log a
         WHERE a.issue_id = ANY(${uuidArray(issueIds)})
           AND ((a.action = ${MARK_RECORD} AND (a.payload ->> 'stamped')::boolean)
                OR a.action = ${UNMARK_RECORD})
         ORDER BY a.issue_id, a.created_at DESC, (a.action = ${MARK_RECORD}) ASC
      ) cur
      JOIN issues i ON i.id = cur.issue_id
     WHERE cur.action = ${MARK_RECORD}
       AND i.merged_at IS NOT NULL
       AND coalesce(trim(i.merged_commit_sha), '') = ''
       AND i.merged_landing IS NULL
       AND cur.payload -> 'commitReading' ->> 'outcome' = 'not_found'
       AND lower(cur.payload ->> 'commit') = lower(cur.payload -> 'commitReading' ->> 'commit')
  `)) as unknown as Array<{ issue_id: string; commit: string; detail: string | null }>;
  for (const r of found) out.set(r.issue_id, { commit: r.commit, detail: r.detail ?? '' });
  return out;
}
