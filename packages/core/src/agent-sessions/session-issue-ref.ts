/**
 * The issue a session works, named the way a reader names it: a job's session records only its
 * issue's id (`metadata.issueId`, the bind pipeline-health reads), so a list showing that id alone
 * names no issue. One query per page, matched within the session's own project.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { formatIssueRef } from '../lib/issue-ref.js';

export interface SessionIssueRef {
  id: string;
  displayId: string;
  title: string;
}

/** Each listed session's issue by session id; a session that records none, or an id that matches
 *  no issue of its project, is absent. */
export async function loadSessionIssueRefs(
  sessionIds: readonly string[],
): Promise<Map<string, SessionIssueRef>> {
  const out = new Map<string, SessionIssueRef>();
  if (sessionIds.length === 0) return out;
  const ids = sql.join(
    sessionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT s.id AS session_id, i.id AS issue_id, i.iss_seq, i.title, p.issue_prefix
      FROM agent_sessions s
      JOIN issues i ON i.project_id = s.project_id AND i.id::text = s.metadata ->> 'issueId'
      JOIN projects p ON p.id = s.project_id
     WHERE s.id IN (${ids})
  `)) as unknown as Array<{
    session_id: string;
    issue_id: string;
    iss_seq: number;
    title: string;
    issue_prefix: string | null;
  }>;
  for (const r of rows) {
    out.set(r.session_id, {
      id: r.issue_id,
      displayId: formatIssueRef(r.issue_prefix, r.iss_seq),
      title: r.title,
    });
  }
  return out;
}
