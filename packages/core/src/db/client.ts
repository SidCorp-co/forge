import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as baseSchema from './schema.js';
import * as activitySchema from './schema-activity.js';
import * as adminThresholdsSchema from './schema-admin-thresholds.js';
import * as journalSchema from './schema-journal.js';
import * as memoryChunksSchema from './schema-memory-chunks.js';
import * as memoryRevisionsSchema from './schema-memory-revisions.js';
import * as questionsSchema from './schema-questions.js';
import * as rocketchatSchema from './schema-rocketchat.js';
import * as runLedgerSchema from './schema-run-ledger.js';
import * as sessionInboxSchema from './schema-session-inbox.js';
import * as speakerLinksSchema from './schema-speaker-links.js';
import * as unauditedTransitionsSchema from './schema-unaudited-transitions.js';

const schema = {
  ...baseSchema,
  ...activitySchema,
  ...adminThresholdsSchema,
  ...journalSchema,
  ...questionsSchema,
  ...rocketchatSchema,
  ...sessionInboxSchema,
  ...memoryChunksSchema,
  ...memoryRevisionsSchema,
  ...runLedgerSchema,
  ...speakerLinksSchema,
  ...unauditedTransitionsSchema,
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

// cm:guard the transaction handle a write joins rather than the pool: a caller that has to commit two rows together passes this, and defaulting a parameter to `db` is what keeps the single-door writes single while letting one of them enlist (ISS-981).
export type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
