import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

/**
 * ISS-196 — Actor context carrier for the `pipeline_outbox` AFTER UPDATE
 * trigger on issues.status.
 *
 * The trigger has no app context, so it reads three Postgres session
 * settings (`pipeline.actor_id`, `pipeline.actor_type`, `pipeline.reason`)
 * to stamp each outbox row. `set_config(..., true)` is the function form of
 * `SET LOCAL` — its effect is scoped to the surrounding transaction and is
 * cleared on COMMIT/ROLLBACK. Calling this outside a transaction is a
 * silent no-op (the settings would leak across statements on the pool
 * connection), so callers MUST wrap the UPDATE in `db.transaction(...)`.
 *
 * Raw psql UPDATEs that skip this helper fall through with
 * `actor_id=NULL, actor_type='system'` — the trigger's COALESCE handles it.
 */
export type OutboxActor =
  | { type: 'user'; id: string }
  | { type: 'device'; id: string }
  | { type: 'system'; id: string };

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
      set_config('pipeline.reason', ${reason ?? ''}, true)
  `);
  return fn(tx);
}
