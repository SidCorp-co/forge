/** Consumed points per rate-limit key, written by `rate-limiter-flexible`'s Postgres store
 *  (`middleware/rate-limit.ts`). Its column shape is the library's; `expire` is epoch ms. */

import { bigint, integer, pgTable, varchar } from 'drizzle-orm/pg-core';

export const RATE_LIMIT_POINTS_TABLE = 'rate_limit_points';

export const rateLimitPoints = pgTable(RATE_LIMIT_POINTS_TABLE, {
  key: varchar('key', { length: 255 }).primaryKey(),
  points: integer('points').notNull().default(0),
  expire: bigint('expire', { mode: 'number' }),
});
