import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as baseSchema from './schema.js';
import * as activitySchema from './schema-activity.js';
import * as adminThresholdsSchema from './schema-admin-thresholds.js';
import * as journalSchema from './schema-journal.js';
import * as memoryChunksSchema from './schema-memory-chunks.js';
import * as memoryRevisionsSchema from './schema-memory-revisions.js';
import * as sessionInboxSchema from './schema-session-inbox.js';

const schema = {
  ...baseSchema,
  ...activitySchema,
  ...adminThresholdsSchema,
  ...journalSchema,
  ...sessionInboxSchema,
  ...memoryChunksSchema,
  ...memoryRevisionsSchema,
};

// cm:guard both statement timeouts must stay bound — unbounded, a hung or leaked `db.transaction()` callback pins a stale MVCC snapshot on a POOLED connection indefinitely, so the damage outlives the request that caused it (ISS-663)
const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  connection: {
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: env.DATABASE_IDLE_IN_TX_TIMEOUT_MS,
  },
});

export const db = drizzle(queryClient, { schema });

export type Db = typeof db;

export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
