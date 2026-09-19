import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Either a live transaction handle or the root `db`. */
export type KernelExecutor = Tx | Db;

export async function stampKernelTxn(exec: KernelExecutor): Promise<void> {
  await exec.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
}

export async function withKernelMarker<T>(
  exec: KernelExecutor,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return exec.transaction(async (tx) => {
    await stampKernelTxn(tx);
    return fn(tx);
  });
}
