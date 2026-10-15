import { type SQL, sql } from 'drizzle-orm';

/**
 * When an issue entered the status it holds: the newest transition into it, or the issue's creation
 * where none was recorded, which is an issue still at the status it was created at.
 *
 * `updated_at` is not this. Every write to the row moves it — a field edit, a lease renewal, a
 * strand finding — so a notice counting from it says an issue has stood somewhere for less time
 * than it has (ISS-1229 judge j16). `kernel_transitions` keeps every issue move while the issue is
 * not terminal (retention's `ENTITY_IS_TERMINAL`), so the row this reads is there for any issue a
 * sweep still watches.
 */
export function statusEnteredAtSql(issue: { id: SQL; status: SQL; createdAt: SQL }): SQL {
  return sql`COALESCE(
    (SELECT max(et.created_at) FROM kernel_transitions et
      WHERE et.entity = 'issue' AND et.entity_id = ${issue.id} AND et.to_status = ${issue.status}),
    ${issue.createdAt}
  )`;
}

/**
 * When the last thing that worked an issue stopped, or when it entered its status if that is later:
 * the end of its newest job, of its newest pipeline run, and of the run session behind its lease.
 * Read only where nothing is live on the issue, so every one of them has ended.
 */
export function lastWorkedAtSql(issue: {
  id: SQL;
  status: SQL;
  createdAt: SQL;
  projectId: SQL;
  issueKey: SQL;
}): SQL {
  return sql`GREATEST(
    ${statusEnteredAtSql(issue)},
    (SELECT max(lj.finished_at) FROM jobs lj WHERE lj.issue_id = ${issue.id}),
    (SELECT max(lr.finished_at) FROM pipeline_runs lr WHERE lr.issue_id = ${issue.id}),
    (SELECT max(GREATEST(lls.updated_at, llr.finished_at))
       FROM issue_leases ll
       JOIN agent_sessions lls ON lls.id = ll.session_id
       LEFT JOIN pipeline_runs llr ON llr.id = ll.run_id
      WHERE ll.project_id = ${issue.projectId} AND ll.issue_key = ${issue.issueKey})
  )`;
}
