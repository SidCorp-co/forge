/**
 * Which requirements hold an open question a person owes (REQ-48 BC-5, REQ-68 BC-9). A steward
 * decision is the one question the steward asked on a stuck draft, every option of which carries the
 * run that asked (`steward:<run>:<basis>`). Any other open question asked of the requirement waits on
 * a person too. The standing then waits on a signer to answer it (`standing.ts`), and Needs you builds
 * the decision.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';

export interface AskedRequirements {
  /** The requirements holding an open steward decision. */
  steward: Set<string>;
  /** The requirements holding any other open question a person owes. */
  person: Set<string>;
}

export async function askedOf(ids: readonly string[]): Promise<AskedRequirements> {
  const out: AskedRequirements = { steward: new Set(), person: new Set() };
  if (ids.length === 0) return out;
  const rows = rowsOf<{ requirement_id: string; steward: boolean }>(
    await db.execute(sql`
      SELECT DISTINCT q.requirement_id,
             coalesce(q.steps -> -1 -> 'options' -> 0 ->> 'fingerprint' LIKE 'steward:%', false) AS steward
        FROM agent_questions q
       WHERE q.requirement_id IN (${idList(ids)})
         AND q.status = 'open'
         AND q.blocker_kind = 'human'
         AND q.batch_id IS NULL`),
  );
  for (const r of rows) (r.steward ? out.steward : out.person).add(r.requirement_id);
  return out;
}
