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

// cm:edge contract -> packages/core/drizzle/migrations/0217_unaudited_transition_detector.sql — `forge.kernel_txn` is read by `forge_detect_unaudited_transition` and `forge_detect_unaudited_deletion`; the setting name and the `txid_current()` value are the whole contract between this module and those functions.
// cm:guard the `true` third argument makes this LOCAL to the transaction, which is what makes the marker un-leakable: a stamp on an autocommit connection would still be set on the next statement that connection served, and every hand-written flip arriving down a pooled connection after one app write would read as audited. It must be stamped INSIDE the transaction that performs the write, never before opening it.
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
// cm:guard this deliberately writes NO `kernel_transitions` row, and widening it to do so is not a small change. An audit row per dispatch and per heartbeat would flood the table, and a `user`-actor row on `entity='run'` is exactly what the `user_run_flip` arm of `issue_intervention_events` selects — so auditing an operator's run pause here would count it a second time against the `manual_*` arm that already has it. The marker answers "did code write this"; the audit row answers "who flipped this terminal, and why". Only the second belongs to `applyKernelTransition`.
// cm:guard every call site that writes a status or deletes a row on `jobs` / `agent_sessions` / `pipeline_runs` must go through here — `db/kernel-marker-guard.test.ts` fails the build on one that does not, because a single unstamped writer charges its whole traffic to the north-star metric as manual SQL.
export async function withKernelMarker<T>(
  exec: KernelExecutor,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return exec.transaction(async (tx) => {
    await stampKernelTxn(tx);
    return fn(tx);
  });
}
