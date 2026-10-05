// The issues kernel's writer for the idle-issues finding (`session_context.strand`) and the lapsed
// lease the sweep releases with it. The sweep decides; these two functions are the only writes.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * Write `record` under `session_context.strand`, and when `release` is given stamp the lease
 * stopped and append `release.entry` to its history. Guarded on the lease value read (`leaseRead`),
 * under the row lock, so a claim landing between read and write wins: returns false and writes
 * nothing. The finding goes through `jsonb_set` on its own key, so a concurrent write to another
 * key survives; the release goes to the lease's home, `issue_work_state` (ISS-54). `updated_at` on
 * the issue is left alone: it has no trigger, and a swept row must not read as freshly worked.
 */
export async function writeIssueStrand(args: {
  issueId: string;
  leaseRead: unknown;
  record: unknown;
  release: { at: string; entry: unknown } | null;
}): Promise<boolean> {
  const { issueId, leaseRead, record, release } = args;
  const read = leaseRead === null || leaseRead === undefined ? null : JSON.stringify(leaseRead);
  return db.transaction(async (tx) => {
    const held = (await tx.execute(sql`
      SELECT 1 FROM issues i
       WHERE i.id = ${issueId}
         AND coalesce((SELECT w.lease FROM issue_work_state w WHERE w.issue_id = i.id), 'null'::jsonb)
             IS NOT DISTINCT FROM coalesce(${read}::jsonb, 'null'::jsonb)
       FOR UPDATE OF i
    `)) as unknown as Array<unknown>;
    if (held.length === 0) return false;
    await tx.execute(sql`
      UPDATE issues i
         SET session_context = jsonb_set(coalesce(i.session_context, '{}'::jsonb), '{strand}', ${JSON.stringify(record)}::jsonb, true)
       WHERE i.id = ${issueId}
    `);
    if (release) {
      await tx.execute(sql`
        UPDATE issue_work_state w
           SET lease = jsonb_set(
                 jsonb_set(w.lease, '{stopped}', to_jsonb(${release.at}::text), true),
                 '{history}',
                 (CASE WHEN jsonb_typeof(w.lease -> 'history') = 'array'
                       THEN w.lease -> 'history' ELSE '[]'::jsonb END) || ${JSON.stringify(release.entry)}::jsonb,
                 true),
               updated_at = now()
         WHERE w.issue_id = ${issueId} AND jsonb_typeof(w.lease) = 'object'
      `);
    }
    return true;
  });
}

/**
 * Drop `session_context.strand`, guarded on the finding still being the one read (`held`), so a
 * finding rewritten since is kept. Returns whether a row was cleared.
 */
export async function clearIssueStrand(issueId: string, held: unknown): Promise<boolean> {
  const read = held === null || held === undefined ? null : JSON.stringify(held);
  const done = (await db.execute(sql`
    UPDATE issues i
       SET session_context = i.session_context - 'strand'
     WHERE i.id = ${issueId}
       AND coalesce(i.session_context -> 'strand', 'null'::jsonb)
           IS NOT DISTINCT FROM coalesce(${read}::jsonb, 'null'::jsonb)
    RETURNING i.id
  `)) as unknown as Array<{ id: string }>;
  return done.length > 0;
}
