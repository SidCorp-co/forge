import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import * as baseSchema from './schema.js';
import * as activitySchema from './schema-activity.js';
import * as adminThresholdsSchema from './schema-admin-thresholds.js';
import * as agentSelvesSchema from './schema-agent-selves.js';
import * as conversationsSchema from './schema-conversations.js';
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
  ...agentSelvesSchema,
  ...adminThresholdsSchema,
  ...conversationsSchema,
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

const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  connection: {
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: env.DATABASE_IDLE_IN_TX_TIMEOUT_MS,
  },
});

const queryLog =
  process.env.DB_QUERY_LOG === '1'
    ? {
        logger: {
          logQuery(query: string) {
            queryCount += 1;
            logger.info(
              { n: queryCount, sql: query.replace(/\s+/g, ' ').slice(0, 220) },
              'db.query',
            );
          },
        },
      }
    : {};
let queryCount = 0;

export const db = drizzle(queryClient, { schema, ...queryLog });

export type Db = typeof db;

export type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
