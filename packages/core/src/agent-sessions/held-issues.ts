/**
 * The issues a session works (ISS-1228): its `issue_leases` rows, the issue its job names in
 * `metadata.issueId` (the bind pipeline-health reads), and the issues its run's `device_run_ledger`
 * entry reports, each where neither half before it names it. The sessions list and the Pipeline's
 * sessions-and-holds read both take a session's issues from this one query, so no two screens can
 * name different issues for one session.
 */

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { formatIssueRef } from '../lib/issue-ref.js';

export interface HeldIssueRow {
  session_id: string;
  session_title: string | null;
  session_kind: string;
  device_name: string | null;
  /** When the lease was taken, or for a job's issue when its session started. */
  acquired_at: Date | string;
  issue_id: string;
  iss_seq: number;
  title: string;
  status: string;
  issue_prefix: string | null;
  /** False only where every ledger entry naming the issue says the run has returned its lease. */
  held: boolean;
}

/**
 * Every issue each session `where` admits holds, ordered by issue number. `where` reads the session
 * as `s` and the issue as `issues`, and is applied to both halves, so a caller deciding archived
 * issues or ended sessions decides them for leases and jobs alike.
 */
export function heldIssueRowsSql(where: SQL): SQL {
  return sql`
    SELECT l.session_id, s.title AS session_title, s.kind AS session_kind, d.name AS device_name,
           l.acquired_at, issues.id AS issue_id, issues.iss_seq, issues.title, issues.status,
           p.issue_prefix, true AS held
      FROM issue_leases l
      JOIN agent_sessions s ON s.id = l.session_id
      JOIN issues ON issues.project_id = l.project_id
                 AND l.issue_key = 'ISS-' || issues.iss_seq -- ISS-992:canonical
      JOIN projects p ON p.id = issues.project_id
      LEFT JOIN devices d ON d.id = l.device_id
     WHERE ${where}
    UNION ALL
    SELECT s.id, s.title, s.kind, d.name, coalesce(s.started_at, s.created_at),
           issues.id, issues.iss_seq, issues.title, issues.status, p.issue_prefix, true
      FROM agent_sessions s
      JOIN issues ON issues.project_id = s.project_id AND issues.id::text = s.metadata ->> 'issueId'
      JOIN projects p ON p.id = issues.project_id
      LEFT JOIN devices d ON d.id = s.device_id
     WHERE ${where}
       AND NOT EXISTS (
         SELECT 1 FROM issue_leases l
          WHERE l.session_id = s.id AND l.issue_key = 'ISS-' || issues.iss_seq -- ISS-992:canonical
       )
    UNION ALL
    SELECT s.id, s.title, s.kind, d.name, coalesce(s.started_at, s.created_at),
           issues.id, issues.iss_seq, issues.title, issues.status, p.issue_prefix,
           bool_or(NOT coalesce((e.item ->> 'leaseReturned')::boolean, false))
      FROM device_run_ledger lr
      JOIN agent_sessions s ON s.id = lr.session_id
      CROSS JOIN LATERAL jsonb_array_elements(lr.issues) AS e(item)
      JOIN issues ON issues.project_id = s.project_id
                 AND e.item ->> 'issueKey' = 'ISS-' || issues.iss_seq -- ISS-992:canonical
      JOIN projects p ON p.id = issues.project_id
      LEFT JOIN devices d ON d.id = s.device_id
     WHERE ${where}
       AND s.metadata ->> 'issueId' IS DISTINCT FROM issues.id::text
       AND NOT EXISTS (
         SELECT 1 FROM issue_leases l
          WHERE l.session_id = s.id AND l.issue_key = 'ISS-' || issues.iss_seq -- ISS-992:canonical
       )
     GROUP BY s.id, s.title, s.kind, d.name, s.started_at, s.created_at, issues.id, issues.iss_seq,
              issues.title, issues.status, p.issue_prefix
     ORDER BY iss_seq
  `;
}

export interface SessionIssueRef {
  id: string;
  displayId: string;
  title: string;
}

/** Each listed session's issues by session id, in issue order; a session holding none is absent. */
export async function loadSessionIssues(
  sessionIds: readonly string[],
): Promise<Map<string, SessionIssueRef[]>> {
  const out = new Map<string, SessionIssueRef[]>();
  if (sessionIds.length === 0) return out;
  const ids = sql.join(
    sessionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(
    heldIssueRowsSql(sql`s.id IN (${ids})`),
  )) as unknown as HeldIssueRow[];
  for (const r of rows) {
    const held = out.get(r.session_id) ?? [];
    if (held.some((h) => h.id === r.issue_id)) continue;
    held.push({
      id: r.issue_id,
      displayId: formatIssueRef(r.issue_prefix, r.iss_seq),
      title: r.title,
    });
    out.set(r.session_id, held);
  }
  return out;
}
