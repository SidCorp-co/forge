import { type SQL, sql } from 'drizzle-orm';
import { RUN_GROUP_METADATA_KEY, RUN_RELEASED_METADATA_KEY } from '../devices/run-session-keys.js';

/** When an issue entered its status — never `updated_at`, which any write moves (ISS-1229). Retention
 *  keeps every move of a non-terminal issue; no row means it still holds the status it was created at. */
export function statusEnteredAtSql(issue: { id: SQL; status: SQL; createdAt: SQL }): SQL {
  return sql`COALESCE(
    (SELECT max(et.created_at) FROM kernel_transitions et
      WHERE et.entity = 'issue' AND et.entity_id = ${issue.id} AND et.to_status = ${issue.status}),
    ${issue.createdAt}
  )`;
}

/** When the issue's last job, run or run session ended or gave it back, or it entered its status. */
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
      WHERE ll.project_id = ${issue.projectId} AND ll.issue_key = (${issue.issueKey})),
    (SELECT max(GREATEST(gr.finished_at,
                         (gr.metadata -> ${RUN_RELEASED_METADATA_KEY}::text ->> (${issue.issueKey}))::timestamptz))
       FROM pipeline_runs gr
      WHERE gr.project_id = ${issue.projectId}
        AND gr.metadata -> ${RUN_GROUP_METADATA_KEY}::text @> to_jsonb((${issue.issueKey})::text))
  )`;
}
