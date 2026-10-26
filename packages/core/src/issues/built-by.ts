// Whether a verdict was recorded by the issue's builder, as SQL a read can select beside the
// verdict (ISS-475, REQ-36 BC-16). A session built the issue when it recorded a check on it other
// than a review's (`review.ts:buildersOf`), or its run was declared over the issue before the work
// landed (the status its run opened the issue at, `runIssueStatuses`, is not awaiting_release,
// closed or dropped), or it holds the issue's lease with no declaration saying it came after. A
// judge run declared over an awaiting_release issue holds its lease too, on the same box, and is
// not the builder: its declaration says the work had landed. So is one declared over a reopen the
// steward made of landed work that only owed verdicts, before that reopen was refused
// (`owedVerdictsReopenSql`, a priced amnesty).
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

/**
 * Before this instant the delivery-policy steward's output check could send landed work back to
 * `reopen` when all it lacked was verdicts at its landing (catalog-fe ISS-11 and ISS-14..19,
 * 2026-10-26 03:53Z); from the change that takes that move away from the steward
 * (`steward/door-writes.ts:MOVE`) it sends nothing back. A cut-off, not a flag: no reopen made
 * after it is ever read this way.
 */
export const OWED_VERDICTS_REOPEN_CUTOFF = '2026-10-27T00:00:00Z';

/**
 * A priced amnesty for the reopens made before the cut-off: a run declared over an issue standing at
 * such a reopen judges it rather than builds it, read off the record because no declaration names a
 * role. It holds where the issue's latest move into `reopen` by the run's declaration was from
 * `awaiting_release`, before the cut-off, over a recorded landing (`merged_commit_sha`), with no
 * failing verdict recorded on the issue by then and no check other than a review recorded on it
 * after (nothing was built since). The declaration is read with `REOPEN_DECLARATION_SLACK` of give:
 * catalog-fe ISS-23's bounce landed as judge run e8996d8d was declared, so its run row is stamped a
 * moment before the reopen its `runIssueStatuses` read. The landing is not required to predate the
 * reopen, because a later merge of the same issue moves it (`merge-record.ts:recordIssueMerge`).
 * What it costs: a builder declared over such a reopen to rebuild, before recording any check, reads
 * as a judge. What ends it: no issue stands at a reopen made before the cut-off; then this clause
 * matches nothing and is deleted.
 */
const REOPEN_DECLARATION_SLACK = sql.raw(`interval '10 minutes'`);

function owedVerdictsReopenSql(issueId: SQL): SQL<boolean> {
  const declared = sql`(r.created_at + ${REOPEN_DECLARATION_SLACK})`;
  return sql<boolean>`EXISTS (
    SELECT 1 FROM kernel_transitions t JOIN issues ai ON ai.id = ${issueId}
     WHERE t.entity = 'issue' AND t.entity_id = ${issueId}
       AND t.to_status = 'reopen' AND t.from_status = 'awaiting_release'
       AND t.created_at < ${OWED_VERDICTS_REOPEN_CUTOFF}::timestamptz
       AND t.created_at <= ${declared}
       AND NOT EXISTS (
         SELECT 1 FROM kernel_transitions later
          WHERE later.entity = 'issue' AND later.entity_id = ${issueId}
            AND later.to_status = 'reopen' AND later.created_at > t.created_at
            AND later.created_at <= ${declared})
       AND ai.merged_commit_sha IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM criterion_verdicts fv JOIN issue_criteria fc ON fc.id = fv.criterion_id
          WHERE fc.issue_id = ${issueId} AND fv.verdict = 'fail' AND fv.created_at <= t.created_at)
       AND NOT EXISTS (
         SELECT 1 FROM issue_check_runs bk
          WHERE bk.issue_id = ${issueId} AND bk.kind <> 'review' AND bk.created_at > t.created_at)
  )`;
}

/** The canonical key of `issueId`, which a run's group and a lease name it by. */
const keyOf = (issueId: SQL) =>
  sql`(SELECT ${canonicalIssueKeySql(sql`bi.iss_seq`)} FROM issues bi WHERE bi.id = ${issueId})`;

/** Whether run `r`'s group holds `issueId`: its key, read inside the run's own project, since an
 *  issue of another project answers to the same key (`lib/issue-run-group.ts:runGroupHoldsIssue`). */
const runHoldsIssue = (issueId: SQL) =>
  sql`r.project_id = (SELECT bp.project_id FROM issues bp WHERE bp.id = ${issueId})
       AND ${runGroupHolds(sql`r.metadata`, keyOf(issueId))}`;

/**
 * Every session `builtBySessionSql` could answer yes for on `issueId`: one that recorded a check on it
 * other than a review's, a run session whose run's group holds it, or one holding its lease. A box's
 * verdict is weighed against these alone, never against every session the box ever ran (dev's one box
 * ran 12,979: the release list read each verdict against all of them, 2 ms a verdict).
 */
function builderCandidatesSql(issueId: SQL): SQL {
  return sql`(
    SELECT k.run_session_id FROM issue_check_runs k
     WHERE k.issue_id = ${issueId} AND k.kind <> 'review' AND k.run_session_id IS NOT NULL
    UNION ALL
    SELECT ds.id FROM agent_sessions ds JOIN pipeline_runs r ON r.id = ds.pipeline_run_id
     WHERE ds.kind = ${RUN_SESSION_KIND} AND ${runHoldsIssue(issueId)}
    UNION ALL
    SELECT l.session_id FROM issue_leases l JOIN issues bi ON bi.id = ${issueId}
     WHERE l.project_id = bi.project_id AND l.issue_key = ${canonicalIssueKeySql(sql`bi.iss_seq`)}
  )`;
}

/** True where session `session` built issue `issueId`. */
function builtBySessionSql(issueId: SQL, session: SQL): SQL<boolean> {
  const key = keyOf(issueId);
  const opened = sql`(r.metadata -> ${RUN_ISSUE_STATUSES_METADATA_KEY} ->> ${key})`;
  const declaredAfterLanding = sql`EXISTS (
    SELECT 1 FROM agent_sessions ds JOIN pipeline_runs r ON r.id = ds.pipeline_run_id
     WHERE ds.id = ${session} AND ds.kind = ${RUN_SESSION_KIND}
       AND ${runHoldsIssue(issueId)}
       AND (${opened} IN (${LANDED_LIST})
            OR (${opened} = 'reopen' AND ${owedVerdictsReopenSql(issueId)}))
  )`;
  return sql<boolean>`(
    EXISTS (
      SELECT 1 FROM issue_check_runs k
       WHERE k.issue_id = ${issueId} AND k.kind <> 'review' AND k.run_session_id = ${session}
    )
    OR EXISTS (
      SELECT 1 FROM agent_sessions ds JOIN pipeline_runs r ON r.id = ds.pipeline_run_id
       WHERE ds.id = ${session} AND ds.kind = ${RUN_SESSION_KIND}
         AND ${runHoldsIssue(issueId)}
         AND COALESCE(${opened}, '') NOT IN (${LANDED_LIST})
         AND NOT (COALESCE(${opened}, '') = 'reopen' AND ${owedVerdictsReopenSql(issueId)})
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
       WHERE s.id IN ${builderCandidatesSql(issueId)}
         AND s.device_id = ${authorDevice}
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
