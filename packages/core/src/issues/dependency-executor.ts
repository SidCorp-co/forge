/**
 * The executor an edge write runs on: the pool, or a caller's open transaction.
 *
 * Its own module because `dependency-service.ts` and `cycle-detect.ts` both
 * need the type and the service already imports the detector — declaring it in
 * either one makes the pair circular.
 */

import type { Db } from '../db/client.js';

/** Drizzle transaction handle — `Parameters<…>` chains to the callback's argument. */
export type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type IssueDependencyExecutor = Db | DrizzleTx;
