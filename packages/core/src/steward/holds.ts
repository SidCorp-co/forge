// What the steward holds back from the master (REQ-48 BC-2, REQ-67 BC-4): an agreed requirement whose
// check asked its author a question is not the master's to break down until that question is
// answered, so a breakdown is never proposed against criteria the author is still settling. An undone
// question holds nothing.
// The check asks a question about the requirement (`door-ask.ts`). Before ISS-688 it posted a
// question comment, whose act cites the comment; migration 0623 asked each one still open as a
// question under the comment's own id (ISS-1084), so either act is read by the question it names.

import { requirementKey } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/** The keys of the project's agreed requirements whose steward check question is still unanswered. */
export async function breakdownsHeldBySteward(projectId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT r.req_seq
      FROM steward_acts a
      JOIN steward_runs sr ON sr.id = a.run_id
      JOIN requirements r ON r.id = sr.subject_id
     WHERE a.project_id = ${projectId}
       AND a.act IN ('intake_check', 'breakdown_check')
       AND a.undone_at IS NULL
       AND sr.subject_kind = 'requirement'
       AND r.status IN ('agreed', 'in_delivery', 'delivered')
       AND a.wrote->>'kind' IN ('question', 'comment')
       AND EXISTS (
         SELECT 1 FROM agent_questions q
          WHERE q.id::text = a.wrote->>'ref' AND q.status = 'open')
     ORDER BY r.req_seq
  `)) as unknown as { req_seq: number }[];
  return rows.map((r) => requirementKey(Number(r.req_seq)));
}
