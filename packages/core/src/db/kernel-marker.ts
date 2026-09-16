/**
 * ISS-943 — `forge.kernel_txn`, the marker that separates a write this
 * application performed from a hand on the database.
 *
 * ISS-884 introduced it for one job, the terminal flip, stamped inside
 * `applyKernelTransition`. That left three classes outside the interventions
 * ruler — `agent_sessions`, every non-terminal flip, row deletion — not because
 * they needed a different discriminator, but because only the terminal writers
 * stamped this one. So the marker moves here and the chokepoint becomes one of
 * its callers, alongside every other legitimate writer of a kernel status and
 * every legitimate deleter of a kernel row.
 *
 * It lives in `db/` rather than `lifecycle/` because it is a transaction and a
 * GUC, not a policy: `applyKernelTransition` decides who may flip what, this
 * only tells the database the write came from code. `no-coordinator-blob` makes
 * the same point from the other side — four route files reach `core-db` already
 * and would cross the six-module fan-out limit on a `core-lifecycle` import.
 */

import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Either a live transaction handle or the root `db`. */
export type KernelExecutor = Tx | Db;

export async function stampKernelTxn(exec: KernelExecutor): Promise<void> {
  await exec.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
}

/**
 * Run `fn` in a transaction that carries the marker.
 *
 * On the root `db` this opens a real transaction; on a caller's `tx` it opens a
 * savepoint, and the marker is stamped either way because `txid_current()` is
 * the top-level transaction id in both cases.
 */
export async function withKernelMarker<T>(
  exec: KernelExecutor,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return exec.transaction(async (tx) => {
    await stampKernelTxn(tx);
    return fn(tx);
  });
}
