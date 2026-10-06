// Which runs and sessions carry an issue. A job's run names its issue in `pipeline_runs.issue_id` and
// its session in `metadata->>'issueId'`; a run session names none, its run carrying the issues it was
// opened over as a group of canonical keys (`runGroup`, ISS-992). Every read by issue goes through here.

import { RUN_GROUP_METADATA_KEY, RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { type AnyColumn, and, eq, or, type SQL, sql } from 'drizzle-orm';
import { agentSessions } from '../db/schema.js';
import { LEGACY_ISSUE_PREFIX } from './issue-ref.js';

/** `canonicalIssueKey` in SQL, over an `iss_seq` column or expression. */
export function canonicalIssueKeySql(issSeq: SQL | AnyColumn): SQL<string> {
  return sql<string>`(${sql.raw(`'${LEGACY_ISSUE_PREFIX}-'`)} || ${issSeq})`;
}

/** Whether the run group on a pipeline run's `metadata` holds the issue whose key is `key`. */
export function runGroupHolds(runMetadata: SQL | AnyColumn, key: SQL): SQL {
  return sql`${runMetadata} -> ${RUN_GROUP_METADATA_KEY} ? ${key}`;
}

/** Whether that run group holds the issue `issueId` of `projectId`; an issue of another project
 *  answers to the same canonical key, so the key is read inside the run's own project. */
export function runGroupHoldsIssue(
  runMetadata: SQL | AnyColumn,
  issueId: string,
  projectId: SQL | AnyColumn | string,
): SQL {
  return runGroupHolds(
    runMetadata,
    sql`(SELECT ${canonicalIssueKeySql(sql`i.iss_seq`)} FROM issues i
          WHERE i.id = ${issueId} AND i.project_id = ${projectId})`,
  );
}

/** The run group of an agent session's run, read beside the session row. */
export const sessionRunGroupSql = sql<unknown>`(SELECT pr.metadata -> ${RUN_GROUP_METADATA_KEY}
  FROM pipeline_runs pr WHERE pr.id = ${agentSessions.pipelineRunId})`;

/** An agent session working `issueId`: a job's session by its own link, a run session through its
 *  run's group. */
export function sessionWorksIssue(issueId: string): SQL {
  const runMetadata = sql`(SELECT pr.metadata FROM pipeline_runs pr WHERE pr.id = ${agentSessions.pipelineRunId})`;
  const byGroup = and(
    eq(agentSessions.kind, RUN_SESSION_KIND),
    runGroupHoldsIssue(runMetadata, issueId, agentSessions.projectId),
  );
  return or(sql`${agentSessions.metadata}->>'issueId' = ${issueId}`, byGroup) as SQL;
}
