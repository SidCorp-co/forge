// Whether a verdict was recorded by the issue's builder, as SQL a read can select beside the
// verdict. The builder is the one `review.ts:buildersOf` names for a review (Issue to release r20
// `rule-merge`): the run sessions that hold the issue's lease or recorded a check on it, and the
// accounts that recorded a check with no session. A box's runs share one credential, so a verdict
// sent from a box is the builder's where a building session was live on that box when it was
// recorded (`review-rules.ts:reviewerRefusal`, `REVIEW_RUN_UNNAMED`), and one sent with no box is
// the builder's where its account recorded a check with no session. A verdict recorded on a box
// after the building run ended there is another run's. A session keeps no end time, so its last
// update stands for one: a later touch reads it live for longer, which errs toward not counting.

import { type SQL, sql } from 'drizzle-orm';
import { terminalAgentSessionStatuses } from '../db/session-vocabulary.js';

const TERMINAL = sql.join(
  terminalAgentSessionStatuses.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * True where the verdict on `issueId` recorded at `at` by `authorUser` from `authorDevice` (null
 * where it came from no box) is the builder's. Every argument is a column or expression of the
 * calling query.
 */
export function verdictByBuilderSql(args: {
  issueId: SQL;
  authorUser: SQL;
  authorDevice: SQL;
  at: SQL;
}): SQL<boolean> {
  const { issueId, authorUser, authorDevice, at } = args;
  return sql<boolean>`(
    (${authorDevice} IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM issue_check_runs k
          JOIN agent_sessions s ON s.id = k.run_session_id
         WHERE k.issue_id = ${issueId} AND k.kind <> 'review'
           AND s.device_id = ${authorDevice}
           -- a building session live on the box when the verdict was recorded
           AND s.created_at <= ${at}
           AND (s.status NOT IN (${TERMINAL}) OR s.updated_at >= ${at})
      )
      OR EXISTS (
        SELECT 1 FROM issues bi
          JOIN issue_leases l ON l.project_id = bi.project_id AND l.issue_key = 'ISS-' || bi.iss_seq
          JOIN agent_sessions ls ON ls.id = l.session_id
         WHERE bi.id = ${issueId} AND l.device_id = ${authorDevice}
           AND ls.created_at <= ${at}
           AND (ls.status NOT IN (${TERMINAL}) OR ls.updated_at >= ${at})
      )
    ))
    OR (${authorDevice} IS NULL AND EXISTS (
      SELECT 1 FROM issue_check_runs k
       WHERE k.issue_id = ${issueId} AND k.kind <> 'review'
         AND k.run_session_id IS NULL AND k.recorded_by = ${authorUser}
    ))
  )`;
}
