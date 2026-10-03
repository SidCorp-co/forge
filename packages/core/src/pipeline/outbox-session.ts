import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { ActorAgency } from '../issues/actor-agency.js';

/** Who a status change is by, as the outbox trigger copies it; `agency` is who acted. */
export type OutboxActor = { type: 'user' | 'device' | 'system'; id: string; agency: ActorAgency };

type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function withActorContext<T>(
  tx: DrizzleTx,
  actor: OutboxActor,
  reason: string | null,
  fn: (tx: DrizzleTx) => Promise<T>,
): Promise<T> {
  // set_config(..., is_local=true) — local to this transaction; never leaks.
  await tx.execute(sql`
    SELECT
      set_config('pipeline.actor_id', ${actor.id}, true),
      set_config('pipeline.actor_type', ${actor.type}, true),
      set_config('pipeline.actor_agency', ${actor.agency}, true),
      set_config('pipeline.reason', ${reason ?? ''}, true)
  `);
  return fn(tx);
}
