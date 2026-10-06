import type { Db, TxOnly } from '../db/client.js';

export type Executor = Db | TxOnly;
