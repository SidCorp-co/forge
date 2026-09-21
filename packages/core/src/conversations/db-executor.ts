import type { db } from '../db/client.js';

type Pool = typeof db;
type Tx = Parameters<Parameters<Pool['transaction']>[0]>[0];

export type Executor = Pool | Tx;

export type TxOnly = Tx;
