/**
 * What counts as live work on an issue, in SQL, against an `issues i`.
 *
 * Two passes ask this question — `issue-run-invariant.ts` and `idle-issues.ts` — and a second copy
 * of the predicate is how one of them goes blind while the other keeps working. It lives in a
 * module neither of them owns so that neither has to import the other for it.
 */

import { sql } from 'drizzle-orm';

/** No job on this issue is still to run. */
export const NO_LIVE_JOB = sql`
  NOT EXISTS (
    SELECT 1 FROM jobs j
     WHERE j.issue_id = i.id AND j.status NOT IN ('done', 'failed', 'cancelled')
  )
`;

/** No pipeline run opened for this issue is still going. */
export const NO_LIVE_RUN = sql`
  NOT EXISTS (
    SELECT 1 FROM pipeline_runs pr
     WHERE pr.issue_id = i.id AND pr.status IN ('running', 'paused')
  )
`;

/**
 * No live system run names this issue.
 *
 * The literal prefix is the one `runIssues` is written with: matching on `issue_prefix` instead
 * makes a live run's issues invisible to the pass reading this, and every one of them is reported
 * as an orphan (ISS-992).
 */
export const NO_SYSTEM_RUN_NAMING_IT = sql`
  NOT EXISTS (
    SELECT 1 FROM pipeline_runs rs
     WHERE rs.project_id = i.project_id
       AND rs.kind = 'system'
       AND rs.status IN ('running', 'paused')
       AND rs.metadata -> 'runIssues' @> to_jsonb('ISS-' || i.iss_seq) -- ISS-992:canonical
  )
`;

/** All three at once: nothing anywhere is working this issue. */
export const NOTHING_LIVE_ON_THIS_ISSUE = sql`
  ${NO_LIVE_JOB} AND ${NO_LIVE_RUN} AND ${NO_SYSTEM_RUN_NAMING_IT}
`;
