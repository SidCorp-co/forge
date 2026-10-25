// A failure is corrected in the issue that owns the work, never in a new one (REQ-74 BC-3, REQ-45
// BC-10): tracing an issue to a business criterion that stands failed on another issue that delivers
// it is refused by name, naming that owner, which the fail reopened (`issues/fail-reopen.ts`). A
// criterion stands failed where its newest verdict, on the owner's criteria tracing it or at the
// requirement itself, is a fail. An issue already tracing the criterion keeps its trace: only taking
// a failure up anew is refused. Independently actionable work traces the criterion its own
// deliverable proves.

import { type SQL, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issueDisplayIds } from '../display-ids.js';

interface FailedOwner {
  code: string;
  req_seq: number;
  owner_id: string;
  owner_status: string;
}

/**
 * Why tracing `issueId` to any of `wordingIds` is refused: the first whose criterion stands failed on
 * another issue, naming it. Null where none does.
 */
export async function failureOwnedElsewhere(
  tx: Tx,
  issueId: string,
  wordingIds: readonly string[],
): Promise<string | null> {
  if (wordingIds.length === 0) return null;
  const ids = sql.join(
    wordingIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const me = sql`${issueId}::uuid`;
  // the other issues tracing each wanted criterion, by its code across the requirement's wordings
  const traces = (code: SQL, requirement: SQL) => sql`
    JOIN requirement_criteria rc ON rc.requirement_id = ${requirement} AND rc.code = ${code}
    JOIN issue_criteria ic ON ic.requirement_criterion_id = rc.id AND ic.retired_at IS NULL
    JOIN issues o ON o.id = ic.issue_id AND o.id <> ${me} AND o.status <> 'dropped'`;
  const [failed] = (await tx.execute(sql`
    WITH wanted AS (
      SELECT DISTINCT rc.requirement_id, rc.code, r.req_seq
        FROM requirement_criteria rc JOIN requirements r ON r.id = rc.requirement_id
       WHERE rc.id IN (${ids})
         AND NOT EXISTS (
           SELECT 1 FROM issue_criteria mine
             JOIN requirement_criteria mrc ON mrc.id = mine.requirement_criterion_id
            WHERE mine.issue_id = ${me} AND mine.retired_at IS NULL
              AND mrc.requirement_id = rc.requirement_id AND mrc.code = rc.code)
    ), owners AS (
      SELECT DISTINCT ON (w.requirement_id, w.code)
             w.requirement_id, w.code, w.req_seq, o.id AS owner_id, o.status AS owner_status
        FROM wanted w ${traces(sql`w.code`, sql`w.requirement_id`)}
       ORDER BY w.requirement_id, w.code, o.merged_at DESC NULLS LAST, o.iss_seq DESC
    ), judged AS (
      SELECT ow.requirement_id, ow.code, v.verdict, v.created_at
        FROM owners ow ${traces(sql`ow.code`, sql`ow.requirement_id`)}
        JOIN criterion_verdicts v ON v.criterion_id = ic.id
      UNION ALL
      SELECT ow.requirement_id, ow.code, rv.verdict, rv.created_at
        FROM owners ow
        JOIN requirement_criteria rc ON rc.requirement_id = ow.requirement_id AND rc.code = ow.code
        JOIN requirement_criterion_verdicts rv ON rv.requirement_criterion_id = rc.id
    ), newest AS (
      SELECT DISTINCT ON (requirement_id, code) requirement_id, code, verdict
        FROM judged ORDER BY requirement_id, code, created_at DESC
    )
    SELECT ow.code, ow.req_seq, ow.owner_id, ow.owner_status
      FROM owners ow JOIN newest n ON n.requirement_id = ow.requirement_id AND n.code = ow.code
     WHERE n.verdict = 'fail'
     ORDER BY ow.code LIMIT 1`)) as unknown as FailedOwner[];
  if (!failed) return null;
  const owner =
    (await issueDisplayIds([failed.owner_id], tx)).get(failed.owner_id) ?? failed.owner_id;
  return `REQ-${failed.req_seq} ${failed.code} stands failed on ${owner}, the issue that delivered it (now \`${failed.owner_status}\`): a failure is corrected in the issue that owns the work, never in a new one. Work it on ${owner}; trace this issue only to a criterion its own deliverable proves.`;
}
