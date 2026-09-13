// The one type the conversation modules take for "a database handle", so a
// caller may hand them the pool or an open transaction without either side
// knowing which. Drizzle types the two differently and neither is assignable
// to the other.

import type { db } from '../db/client.js';

type Pool = typeof db;
type Tx = Parameters<Parameters<Pool['transaction']>[0]>[0];

export type Executor = Pool | Tx;

/**
 * A handle that is definitely INSIDE a transaction, for the operations whose
 * correctness is a lock held across two statements.
 */
// cm:guard `Executor` is deliberately NOT this: it accepts the POOL, where `FOR UPDATE` drops its
// lock at the end of its own statement — a param named `tx` taking a pool is the defect (ISS-1001)
export type TxOnly = Tx;
