import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf, uuidArray } from '../db/raw-sql.js';

// the roster a cut, the draft and the sweep read is the issues module's, so a feedback item's release
// leg reads the same roster (ISS-1244)
export { waitingIssueIds } from '../issues/index.js';

/** An issue an open release run claims, the run, its version, and its latest approval's decision. */
export interface RunClaim {
  issueId: string;
  runId: string;
  version: string | null;
  /** Whether an approval was ever asked of the run. */
  asked: boolean;
  /** The latest approval's decision; null where it is undecided or none was asked. */
  decision: string | null;
}

/**
 * Of `issueIds` on the project, each an open release run (not shipped, not ended) claims, with that
 * run's version and approval (ISS-1186): one statement over every issue asked, read beside the
 * release leg so a requirement whose landed issues one run carries names that run's act.
 */
export async function runClaimsOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<RunClaim[]> {
  if (issueIds.length === 0) return [];
  const rows = rowsOf<{
    issue_id: string;
    run_id: string;
    version: string | null;
    decision: string | null;
    asked: boolean;
  }>(
    await db.execute(sql`
      SELECT i.id::text AS issue_id, r.id::text AS run_id, r.release_version AS version,
             (SELECT a.decision FROM release_approvals a WHERE a.run_id = r.id
               ORDER BY a.requested_at DESC, a.id DESC LIMIT 1) AS decision,
             EXISTS (SELECT 1 FROM release_approvals a WHERE a.run_id = r.id) AS asked
        FROM issues i
        JOIN pipeline_runs r ON r.id = i.release_batch_run_id AND r.project_id = i.project_id
       WHERE i.project_id = ${projectId}::uuid AND i.id = ANY(${uuidArray([...issueIds])})
         AND r.metadata ->> 'source' = 'release-batch'
         AND r.status IN ('running', 'paused') AND r.release_released_at IS NULL`),
  );
  return rows.map((r) => ({
    issueId: r.issue_id,
    runId: r.run_id,
    version: r.version,
    asked: r.asked,
    decision: r.decision,
  }));
}
