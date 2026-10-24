// Whether a verdict was recorded by the issue's builder, as SQL a read can select beside the
// verdict (ISS-475, REQ-36 BC-16). A session built the issue when it recorded a check on it other
// than a review's (`review.ts:buildersOf`), or its run was declared over the issue before the work
// landed (the status its run opened the issue at, `runIssueStatuses`, is not awaiting_release,
// closed or dropped), or it holds the issue's lease with no declaration saying it came after. A
// judge run declared over an awaiting_release issue holds its lease too, on the same box, and is
// not the builder: its declaration says the work had landed.
//
// A verdict naming the session that recorded it (`criterion_verdicts.run_session_id`, 0528) is read
// by that session alone. One naming none, as every row before 0528, is read off its box: the
// builder's where a building session was live on the box it came from when it was recorded, or,
// with no box, where its account recorded a check with no session. A session keeps no end time, so
// its last update stands for one: a later touch reads it live for longer, which errs toward not
// counting.

import { RUN_ISSUE_STATUSES_METADATA_KEY, RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { ISSUE_DISPATCH_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { type SQL, sql } from 'drizzle-orm';
import { terminalAgentSessionStatuses } from '../db/session-vocabulary.js';
import { canonicalIssueKeySql, runGroupHolds } from '../lib/issue-run-group.js';

const TERMINAL = sql.join(
  terminalAgentSessionStatuses.map((s) => sql`${s}`),
  sql`, `,
);

/** The statuses a run opens an issue at once the work left the pipeline's hands: a run declared then judges it. */
const LANDED_LIST = sql.join(
  ISSUE_DISPATCH_TERMINAL_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/** True where session `session` built issue `issueId`. */
function builtBySessionSql(issueId: SQL, session: SQL): SQL<boolean> {
  const key = sql`(SELECT ${canonicalIssueKeySql(sql`bi.iss_seq`)} FROM issues bi WHERE bi.id = ${issueId})`;
  const opened = sql`(r.metadata -> ${RUN_ISSUE_STATUSES_METADATA_KEY} ->> ${key})`;
  const declaredAfterLanding = sql`EXISTS (
    SELECT 1 FROM agent_sessions ds JOIN pipeline_runs r ON r.id = ds.pipeline_run_id
     WHERE ds.id = ${session} AND ds.kind = ${RUN_SESSION_KIND}
       AND ${runGroupHolds(sql`r.metadata`, key)} AND ${opened} IN (${LANDED_LIST})
  )`;
  return sql<boolean>`(
    EXISTS (
      SELECT 1 FROM issue_check_runs k
       WHERE k.issue_id = ${issueId} AND k.kind <> 'review' AND k.run_session_id = ${session}
    )
    OR EXISTS (
      SELECT 1 FROM agent_sessions ds JOIN pipeline_runs r ON r.id = ds.pipeline_run_id
       WHERE ds.id = ${session} AND ds.kind = ${RUN_SESSION_KIND}
         AND ${runGroupHolds(sql`r.metadata`, key)}
         AND COALESCE(${opened}, '') NOT IN (${LANDED_LIST})
    )
    OR (EXISTS (
      SELECT 1 FROM issue_leases l JOIN issues bi ON bi.id = ${issueId}
       WHERE l.session_id = ${session} AND l.project_id = bi.project_id
         AND l.issue_key = ${canonicalIssueKeySql(sql`bi.iss_seq`)}
    ) AND NOT ${declaredAfterLanding})
  )`;
}

/**
 * True where the verdict on `issueId` recorded at `at` by `authorUser` from `authorDevice` (null
 * where it came from no box), naming `runSession` (null where it names none), is the builder's.
 * Every argument is a column or expression of the calling query.
 */
export function verdictByBuilderSql(args: {
  issueId: SQL;
  authorUser: SQL;
  authorDevice: SQL;
  at: SQL;
  runSession: SQL;
}): SQL<boolean> {
  const { issueId, authorUser, authorDevice, at, runSession } = args;
  return sql<boolean>`(
    (${runSession} IS NOT NULL AND ${builtBySessionSql(issueId, runSession)})
    OR (${runSession} IS NULL AND ${authorDevice} IS NOT NULL AND EXISTS (
      SELECT 1 FROM agent_sessions s
       WHERE s.device_id = ${authorDevice}
         -- a building session live on the box when the verdict was recorded
         AND s.created_at <= ${at}
         AND (s.status NOT IN (${TERMINAL}) OR s.updated_at >= ${at})
         AND ${builtBySessionSql(issueId, sql`s.id`)}
    ))
    OR (${runSession} IS NULL AND ${authorDevice} IS NULL AND EXISTS (
      SELECT 1 FROM issue_check_runs k
       WHERE k.issue_id = ${issueId} AND k.kind <> 'review'
         AND k.run_session_id IS NULL AND k.recorded_by = ${authorUser}
    ))
  )`;
}
