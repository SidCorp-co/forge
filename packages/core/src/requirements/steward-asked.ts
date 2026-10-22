/**
 * Which requirements hold an open steward decision (REQ-48 BC-5): the one question the steward asked
 * on a stuck draft, every option of which carries the run that asked (`steward:<run>:<basis>`). Its
 * standing then waits on a signer to answer it (`standing.ts`), and Needs you builds the decision.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';

export async function stewardAskedOf(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = rowsOf<{ requirement_id: string }>(
    await db.execute(sql`
      SELECT DISTINCT q.requirement_id
        FROM agent_questions q
       WHERE q.requirement_id IN (${idList(ids)})
         AND q.status = 'open'
         AND q.steps -> -1 -> 'options' -> 0 ->> 'fingerprint' LIKE 'steward:%'`),
  );
  return new Set(rows.map((r) => r.requirement_id));
}
