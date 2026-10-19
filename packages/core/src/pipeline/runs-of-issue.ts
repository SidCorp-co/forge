import { sql } from 'drizzle-orm';
import { heldIssueRowsSql } from '../agent-sessions/held-issues.js';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import {
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
} from '../devices/run-session-keys.js';
import { canonicalIssueKey } from '../lib/issue-ref.js';
import type { JournalRunHead } from './run-journal-routes.js';

/** The most runs one journal read returns, newest first. */
export const RUN_LIMIT = 50;

type RunKind = JournalRunHead['kind'];
type RunStatus = JournalRunHead['status'];

export interface RunRow extends Record<string, unknown> {
  id: string;
  kind: RunKind;
  status: RunStatus;
  started_at: string | Date;
  finished_at: string | Date | null;
  grp: string[] | null;
  session_id: string | null;
}

/**
 * Every run of the issue, oldest first: the runs whose own column names it, and the group runs it
 * was opened in, by `runGroup` or — on a run older than that key — the keys `runIssueStatuses` was
 * stamped with, or by an attempt the journal holds for it.
 */
export async function runsOfIssue(
  projectId: string,
  issueId: string,
  key: string,
): Promise<RunRow[]> {
  const keysOf = (field: string, shape: 'array' | 'object') =>
    shape === 'array'
      ? sql`(SELECT array_agg(k) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.metadata -> ${field}::text) = 'array' THEN r.metadata -> ${field}::text ELSE '[]'::jsonb END) AS k)`
      : sql`(SELECT array_agg(k) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(r.metadata -> ${field}::text) = 'object' THEN r.metadata -> ${field}::text ELSE '{}'::jsonb END) AS k)`;
  return (await db.execute(sql`
    SELECT r.id, r.kind, r.status, r.started_at, r.finished_at,
           CASE WHEN r.issue_id IS NULL
                THEN COALESCE(${keysOf(RUN_GROUP_METADATA_KEY, 'array')},
                              ${keysOf(RUN_ISSUE_STATUSES_METADATA_KEY, 'object')},
                              ARRAY[]::text[])
           END AS grp,
           (SELECT s.id FROM agent_sessions s WHERE s.pipeline_run_id = r.id
             ORDER BY s.started_at DESC, s.id DESC LIMIT 1) AS session_id
      FROM pipeline_runs r
     WHERE r.project_id = ${projectId}
       AND (r.issue_id = ${issueId}
            OR (r.issue_id IS NULL
                AND (COALESCE(jsonb_exists(r.metadata -> ${RUN_GROUP_METADATA_KEY}::text, ${key}), false)
                     OR COALESCE(jsonb_exists(r.metadata -> ${RUN_ISSUE_STATUSES_METADATA_KEY}::text, ${key}), false)
                     OR EXISTS (SELECT 1 FROM run_journal j
                                 WHERE j.run_id = r.id AND j.issue_id = ${issueId}))))
     ORDER BY r.started_at, r.id
  `)) as unknown as RunRow[];
}

/**
 * Whether the issue page offers Open session, by the rule its header reads (`issueSessionId`): a
 * live session holding the issue, else a run of it the journal shows with a session.
 */
export async function issueHasSession(projectId: string, issueId: string): Promise<boolean> {
  const [issue] = (await db.execute(sql`
    SELECT iss_seq FROM issues WHERE id = ${issueId}::uuid AND project_id = ${projectId}::uuid
  `)) as unknown as Array<{ iss_seq: number | null }>;
  if (!issue) return false;
  const ended = sql.join(
    terminalAgentSessionStatuses.map((s) => sql`${s}`),
    sql`, `,
  );
  const held = (await db.execute(
    heldIssueRowsSql(sql`issues.id = ${issueId}::uuid AND s.status NOT IN (${ended})`),
  )) as unknown as Array<{ held: boolean }>;
  if (held.some((row) => row.held)) return true;
  const key = issue.iss_seq ? canonicalIssueKey(issue.iss_seq) : '';
  const runs = await runsOfIssue(projectId, issueId, key);
  return runs.slice(-RUN_LIMIT).some((run) => run.session_id !== null);
}
