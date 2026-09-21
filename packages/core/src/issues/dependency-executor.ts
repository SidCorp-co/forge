import type { Db } from '../db/client.js';

export type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type IssueDependencyExecutor = Db | DrizzleTx;
