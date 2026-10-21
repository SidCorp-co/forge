// What the steward holds back from the master (REQ-48 BC-2): an agreed requirement whose intake check
// asked its author a question is not the master's to break down until somebody other than the steward
// replies to that question, so a breakdown is never proposed against criteria the author is still
// settling. An undone question holds nothing.

import { requirementKey } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/** The keys of the project's agreed requirements whose steward intake question is still unanswered. */
export async function breakdownsHeldBySteward(projectId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT r.req_seq
      FROM steward_acts a
      JOIN steward_runs sr ON sr.id = a.run_id
      JOIN requirements r ON r.id = sr.subject_id
      JOIN comments q ON q.requirement_id = r.id AND q.id::text = a.wrote->>'ref'
     WHERE a.project_id = ${projectId}
       AND a.act = 'intake_check'
       AND a.undone_at IS NULL
       AND sr.subject_kind = 'requirement'
       AND a.wrote->>'kind' = 'comment'
       AND q.intent = 'question'
       AND r.status = 'agreed'
       AND NOT EXISTS (
         SELECT 1 FROM comments reply
          WHERE reply.parent_id = q.id AND reply.author_id <> q.author_id)
     ORDER BY r.req_seq
  `)) as unknown as { req_seq: number }[];
  return rows.map((r) => requirementKey(Number(r.req_seq)));
}
