import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';
import * as baseSchema from './schema.js';
import * as activitySchema from './schema-activity.js';
import * as adminThresholdsSchema from './schema-admin-thresholds.js';
import * as agentSelvesSchema from './schema-agent-selves.js';
import * as agentSessionEventsSchema from './schema-agent-session-events.js';
import * as backfillMarkersSchema from './schema-backfill-markers.js';
import * as conversationsSchema from './schema-conversations.js';
import * as deployLocksSchema from './schema-deploy-locks.js';
import * as issueCriteriaSchema from './schema-issue-criteria.js';
import * as issueLeasesSchema from './schema-issue-leases.js';
import * as issueWorkStateSchema from './schema-issue-work-state.js';
import * as journalSchema from './schema-journal.js';
import * as masterCharterSchema from './schema-master-charter.js';
import * as masterPassesSchema from './schema-master-passes.js';
import * as memoryChunksSchema from './schema-memory-chunks.js';
import * as memoryRevisionsSchema from './schema-memory-revisions.js';
import * as projectConfigSchema from './schema-project-config.js';
import * as questionsSchema from './schema-questions.js';
import * as rateLimitsSchema from './schema-rate-limits.js';
import * as repoProjectionSchema from './schema-repo-projection.js';
import * as rocketchatSchema from './schema-rocketchat.js';
import * as runLedgerSchema from './schema-run-ledger.js';
import * as sessionInboxSchema from './schema-session-inbox.js';
import * as speakerLinksSchema from './schema-speaker-links.js';
import * as transcriptIndexSchema from './schema-transcript-index.js';
import * as unauditedTransitionsSchema from './schema-unaudited-transitions.js';
import { refuseBareDates } from './sql-timestamp.js';

const schema = {
  ...baseSchema,
  ...activitySchema,
  ...agentSelvesSchema,
  ...adminThresholdsSchema,
  ...conversationsSchema,
  ...transcriptIndexSchema,
  ...journalSchema,
  ...masterCharterSchema,
  ...masterPassesSchema,
  ...projectConfigSchema,
  ...questionsSchema,
  ...rateLimitsSchema,
  ...rocketchatSchema,
  ...agentSessionEventsSchema,
  ...backfillMarkersSchema,
  ...sessionInboxSchema,
  ...memoryChunksSchema,
  ...memoryRevisionsSchema,
  ...deployLocksSchema,
  ...issueLeasesSchema,
  ...issueWorkStateSchema,
  ...issueCriteriaSchema,
  ...runLedgerSchema,
  ...speakerLinksSchema,
  ...unauditedTransitionsSchema,
  ...repoProjectionSchema,
};

let queryCount = 0;
let queryClient: ReturnType<typeof postgres> | undefined;

function buildDb() {
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

  const built = drizzle(queryClient, { schema, ...queryLog });
  refuseBareDates(queryClient);
  return built;
}

export type Db = ReturnType<typeof buildDb>;

let instance: Db | undefined;
const bound = new Map<string | symbol, unknown>();

function currentDb(): Db {
  instance ??= buildDb();
  return instance;
}

const commitHooks = new AsyncLocalStorage<Array<() => void>>();

/**
 * Runs `fn` after the `db.transaction` it is called inside commits, or at once outside any. A
 * transaction that rolls back runs none of its hooks.
 */
export function afterCommit(fn: () => void): void {
  const hooks = commitHooks.getStore();
  if (hooks) hooks.push(fn);
  else runHook(fn);
}

function runHook(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.error({ err }, 'db: an after-commit hook threw');
  }
}

const transactionWithHooks = (async (...args: Parameters<Db['transaction']>) => {
  const hooks: Array<() => void> = [];
  const result = await commitHooks.run(hooks, () => currentDb().transaction(...args));
  for (const fn of hooks) runHook(fn);
  return result;
}) as Db['transaction'];

export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    if (prop === 'transaction') return transactionWithHooks;
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
