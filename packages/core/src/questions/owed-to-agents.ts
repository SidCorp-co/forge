import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/** An open question a project's agents owe, named by its id and the issue it stands on, if any. */
export interface AgentOwedQuestion {
  readonly id: string;
  readonly on: string | null;
}

/**
 * Every open question on `projectId` blocked on its master or a peer agent (`master_or_peer`), oldest
 * first. Outside strict a decision is the master's (REQ-79 BC-13, BC-14), and no person's Needs you
 * lists it, so the master's pass is where it is owed.
 */
export async function questionsOwedToAgents(projectId: string): Promise<AgentOwedQuestion[]> {
  const rows = (await db.execute(sql`
    SELECT q.id, i.iss_seq, p.issue_prefix
      FROM agent_questions q
      JOIN projects p ON p.id = q.project_id
      LEFT JOIN issues i ON i.id = q.issue_id
     WHERE q.project_id = ${projectId} AND q.status = 'open' AND q.blocker_kind = 'master_or_peer'
     ORDER BY q.created_at, q.id
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    on:
      r.iss_seq == null
        ? null
        : `${(r.issue_prefix as string | null) ?? 'ISS'}-${Number(r.iss_seq)}`,
  }));
}
