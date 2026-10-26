import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { installQueryErrorSeal } from './query-error-seal.js';
import * as baseSchema from './schema.js';
import * as activitySchema from './schema-activity.js';
import * as adminThresholdsSchema from './schema-admin-thresholds.js';
import * as agentSelvesSchema from './schema-agent-selves.js';
import * as agentSessionEventsSchema from './schema-agent-session-events.js';
import * as backfillMarkersSchema from './schema-backfill-markers.js';
import * as backlogIndexSchema from './schema-backlog-index.js';
import * as conversationsSchema from './schema-conversations.js';
import * as deployLocksSchema from './schema-deploy-locks.js';
import * as issueLeasesSchema from './schema-issue-leases.js';
import * as journalSchema from './schema-journal.js';
import * as masterCharterSchema from './schema-master-charter.js';
import * as memoryChunksSchema from './schema-memory-chunks.js';
import * as memoryRevisionsSchema from './schema-memory-revisions.js';
import * as questionsSchema from './schema-questions.js';
import * as reconcilerSchema from './schema-reconciler.js';
import * as repoProjectionSchema from './schema-repo-projection.js';
import * as rocketchatSchema from './schema-rocketchat.js';
import * as runLedgerSchema from './schema-run-ledger.js';
import * as runnerReleaseSchema from './schema-runner-release.js';
import * as sessionInboxSchema from './schema-session-inbox.js';
import * as speakerLinksSchema from './schema-speaker-links.js';
import * as transcriptIndexSchema from './schema-transcript-index.js';
import * as unauditedTransitionsSchema from './schema-unaudited-transitions.js';

const schema = {
  ...baseSchema,
  ...activitySchema,
  ...agentSelvesSchema,
  ...adminThresholdsSchema,
  ...conversationsSchema,
  ...transcriptIndexSchema,
  ...journalSchema,
  ...masterCharterSchema,
  ...questionsSchema,
  ...rocketchatSchema,
  ...agentSessionEventsSchema,
  ...backfillMarkersSchema,
  ...sessionInboxSchema,
  ...memoryChunksSchema,
  ...memoryRevisionsSchema,
  ...deployLocksSchema,
  ...issueLeasesSchema,
  ...backlogIndexSchema,
  ...runLedgerSchema,
  ...speakerLinksSchema,
  ...unauditedTransitionsSchema,
  ...repoProjectionSchema,
  ...runnerReleaseSchema,
  ...reconcilerSchema,
};

let queryCount = 0;
let queryClient: ReturnType<typeof postgres> | undefined;

function buildDb() {
  installQueryErrorSeal();
  queryClient = postgres(env.DATABASE_URL, {
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

  return drizzle(queryClient, { schema, ...queryLog });
}

export type Db = ReturnType<typeof buildDb>;

let instance: Db | undefined;
const bound = new Map<string | symbol, unknown>();
let closedFor: string | undefined;

function currentDb(): Db {
  if (closedFor !== undefined) {
    throw new Error(
      `The database client was closed ${closedFor}, so this access opens no new one: whatever ` +
        'made it is work that outlived that close.',
    );
  }
  instance ??= buildDb();
  return instance;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = currentDb();
    const value = Reflect.get(real as object, prop, real);
    if (typeof value !== 'function') return value;
    if (Object.hasOwn(real as object, prop)) return value;
    let fn = bound.get(prop);
    if (fn === undefined) {
      fn = value.bind(real);
      bound.set(prop, fn);
    }
    return fn;
  },
  has: (_target, prop) => prop in (currentDb() as object),
});

export type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export async function closeDb(): Promise<void> {
  if (queryClient === undefined) return;
  await queryClient.end({ timeout: 5 });
  queryClient = undefined;
  instance = undefined;
  bound.clear();
}

/**
 * Close the client and keep it closed: where an access after `closeDb` opens a new pool nobody
 * will close, one after this is refused naming `why`, until `reopenDb`.
 */
export async function closeDbFor(why: string): Promise<void> {
  closedFor = why;
  await closeDb();
}

/** Let the next access open a client again, after `closeDbFor`. */
export function reopenDb(): void {
  closedFor = undefined;
}
