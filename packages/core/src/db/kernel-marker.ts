// The kernel's transaction-local flag, `forge.kernel_txn`. The status trigger on every machine's
// status column (`forge_kernel_status_guard`, migration 0392) refuses an UPDATE of the status unless
// the flag holds the current transaction id; the deletion detectors chart a delete made without it.

import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Either a live transaction handle or the root `db`. */
export type KernelExecutor = Tx | Db;

export async function stampKernelTxn(exec: KernelExecutor): Promise<void> {
  await exec.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
}

/** A delete made under the flag for the whole of its own transaction. */
export async function withKernelMarker<T>(
  exec: KernelExecutor,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return exec.transaction(async (tx) => {
    await stampKernelTxn(tx);
    return fn(tx);
  });
}

/**
 * The kernel transition's status write, made under the flag, which then goes back to what the
 * transaction held before: a status write later in the same transaction is judged on its own.
 */
export async function asKernelStatusWrite<T>(tx: Tx, write: () => Promise<T>): Promise<T> {
  const [held] = (await tx.execute(
    sql`SELECT current_setting('forge.kernel_txn', true) AS prior, set_config('forge.kernel_txn', txid_current()::text, true)`,
  )) as unknown as Array<{ prior: string | null }>;
  const written = await write();
  await tx.execute(sql`SELECT set_config('forge.kernel_txn', ${held?.prior ?? ''}, true)`);
  return written;
}
