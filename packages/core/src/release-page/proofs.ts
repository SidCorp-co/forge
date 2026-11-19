// How each New and Fixed line's call to an outside provider was proven (ISS-1329): what its judges
// said on their verdicts (`integrationProof`), never what core guessed from evidence text. A master
// asked for production approval of an integration that had run only against a mock, and its release
// said nothing of it; a line now reads `simulated` while any of its issue's criteria rests on a mock.

import type { IntegrationProof, ReleasePage } from '@forge/contracts/release-page';
import type { ReleaseDetail } from '@forge/contracts/releases';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { uuidArray } from '../db/raw-sql.js';

type Change = ReleasePage['improvements'][number];
type Changes = { improvements: Change[]; fixes: Change[] };

/**
 * Each issue's outside-call proof, by issue id: the newest saying of each live criterion, `simulated`
 * where any is, else `live`. A verdict that says nothing keeps the saying before it, so a re-judge
 * restating a pass does not wipe it, and only a later saying of `live` clears a mock.
 */
export async function lineProofsOf(
  issueIds: readonly string[],
): Promise<Map<string, IntegrationProof>> {
  if (issueIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    WITH said AS (
      SELECT DISTINCT ON (v.criterion_id) c.issue_id::text AS issue_id, v.integration_proof AS proof
        FROM criterion_verdicts v
        JOIN issue_criteria c ON c.id = v.criterion_id
       WHERE c.issue_id = ANY(${uuidArray(issueIds)}) AND c.retired_at IS NULL
         AND v.integration_proof IS NOT NULL
       ORDER BY v.criterion_id, v.created_at DESC, v.id DESC
    )
    SELECT issue_id, bool_or(proof = 'simulated') AS simulated
      FROM said GROUP BY issue_id`)) as unknown as { issue_id: string; simulated: boolean }[];
  return new Map(rows.map((r) => [r.issue_id, r.simulated ? 'simulated' : 'live']));
}

/** Each line with its issue's outside-call proof, null where no judge said one. */
export async function withProofs<T extends Changes>(
  detail: Pick<ReleaseDetail, 'issues'>,
  changes: T,
): Promise<T> {
  const idOf = new Map(detail.issues.map((i) => [i.key, i.id] as const));
  const proofs = await lineProofsOf(detail.issues.map((i) => i.id));
  const on = (c: Change): Change => {
    const id = idOf.get(c.issueKey);
    return { ...c, proof: (id && proofs.get(id)) || null };
  };
  return { ...changes, improvements: changes.improvements.map(on), fixes: changes.fixes.map(on) };
}
