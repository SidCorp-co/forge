// When and through whom each slot of a project was last given a value (ISS-1348): the Secrets page
// says a filled slot "has a value", when, and by whom or through which door, read off the one audit
// every variable and project secret write keeps (`project_variable_events`), never the value.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { slotKeyOf } from './variables-store.js';

export { listVariables, type VariableRow } from './variables-store.js';

export interface SlotFill {
  at: Date;
  /** The account that wrote it; null where a one-time write URL did. */
  by: string | null;
  via: 'page' | 'presigned';
}

/** The latest value-giving write of each variable and project secret, by the slot key asks name it with. */
export async function lastFills(projectId: string): Promise<Map<string, SlotFill>> {
  const rows = await db.execute<{
    key: string;
    environment: string | null;
    at: Date | string;
    actor_id: string | null;
    via: string | null;
  }>(sql`
    SELECT DISTINCT ON (key, coalesce(environment, '*')) key, environment, at, actor_id,
           detail->>'via' AS via
      FROM project_variable_events
     WHERE project_id = ${projectId}::uuid AND act IN ('created', 'updated', 'approved')
       AND new_fingerprint IS NOT NULL
     ORDER BY key, coalesce(environment, '*'), at DESC`);
  return new Map(
    [...rows].map((r) => [
      slotKeyOf({ projectId, key: r.key, environment: r.environment }),
      {
        at: new Date(r.at),
        by: r.actor_id,
        via: r.via === 'presigned' ? ('presigned' as const) : ('page' as const),
      },
    ]),
  );
}
