// The one type the conversation modules take for "a database handle", so a
// caller may hand them the pool or an open transaction without either side
// knowing which. Drizzle types the two differently and neither is assignable
// to the other.

import type { db } from '../db/client.js';

type Pool = typeof db;
type Tx = Parameters<Parameters<Pool['transaction']>[0]>[0];

export type Executor = Pool | Tx;
