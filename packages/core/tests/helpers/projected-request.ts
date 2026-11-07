/**
 * A planted host's read of a change request where the suite's host is the projection itself: the
 * request answers as the hook last projected it, its head and target included. For suites whose
 * planted host merges and knows nothing else, so the merge door's read before a merge
 * (`merge-landed.ts:readBeforeMerge`) sees the head the suite planted. No module but the db, so a
 * `vi.mock` factory may import it.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';

type Row = {
  number: number;
  title: string;
  state: string;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
  merged_at: Date | null;
  merge_commit_sha: string | null;
};

export async function readProjectedRequest(number: number) {
  const [row] = [
    ...(await db.execute<Row>(sql`
      SELECT number, title, state, head_ref, head_sha, base_ref, base_sha, merged_at, merge_commit_sha
        FROM repo_pull_requests WHERE number = ${number} ORDER BY updated_at DESC LIMIT 1`)),
  ];
  if (!row) throw new Error(`no merge request !${number} projected`);
  return {
    number: row.number,
    url: null,
    title: row.title,
    state: row.state,
    draft: false,
    headRef: row.head_ref,
    headSha: row.head_sha,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    updatedAt: null,
    body: null,
    mergedAt: row.merged_at ? new Date(row.merged_at).toISOString() : null,
    mergeCommitSha: row.merge_commit_sha,
  };
}
