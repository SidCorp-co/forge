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
import * as repoProjectionSchema from './schema-repo-projection.js';
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
  ...repoProjectionSchema,
};

let queryCount = 0;
let queryClient: ReturnType<typeof postgres> | undefined;

// cm:guard both statement timeouts must stay bound — unbounded, a hung or leaked `db.transaction()` callback pins a stale MVCC snapshot on a POOLED connection indefinitely, so the damage outlives the request that caused it (ISS-663)
// cm:guard nothing in here runs at import — this whole function is reached by the FIRST PROPERTY READ
// of `db` below and by nothing else. Importing this module used to construct the pool, which is what
// made 372 test files mock it and what turned an import-time failure into a stack with no assertion
// in it (ISS-1067).
function buildDb() {
  queryClient = postgres(env.DATABASE_URL, {
    max: 10,
    connection: {
      statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: env.DATABASE_IDLE_IN_TX_TIMEOUT_MS,
    },
  });

  // cm:guard OFF unless `DB_QUERY_LOG=1`, and it prints the statement rather than the params: this exists to count round trips per request and read their shape — measured 2026-09-15, one `GET /issues?limit=1` ran ~40 of them — and a logger that printed params would put row contents into the log on every query (ISS-1009).
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

// cm:guard `Db` is still exactly what `drizzle()` returns, read off the builder rather than spelled
// out, so the `$client` field and the schema generic stay on it. Spelling `PostgresJsDatabase<typeof
// schema>` here would drop `$client` and every `typeof db` in the tree would narrow with it.
export type Db = ReturnType<typeof buildDb>;

let instance: Db | undefined;
const bound = new Map<string | symbol, unknown>();

function currentDb(): Db {
  instance ??= buildDb();
  return instance;
}

// cm:guard a Proxy rather than a `getDb()` function so that all 391 importers keep reading `db.select`:
// the point of ISS-1067 is that an IMPORT does no work, not that every caller is rewritten.
// cm:guard bind ONLY what the prototype chain owns, and hand back an own property untouched. That is
// not a nicety: drizzle's `select`/`transaction`/`execute` live on `PgDatabase.prototype` and read
// private state off `this`, so they need the real receiver — while `$client` is an OWN property whose
// value is postgres.js's tagged-template FUNCTION carrying `.unsafe`, `.begin`, `.end`, `.listen`,
// `.file`, `.json` and `.array` as own properties of its own. `Function.prototype.bind` copies none
// of them, so binding `$client` would hand back something that still passes `typeof … === 'function'`
// and answers `undefined` to every one of those — the silent substitution, on a handle whose whole
// purpose is the escape hatch. `query` is an own property too and already closes over the instance.
// The bound copy is memoised so `db.select === db.select`, which nothing should have to reason about.
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

// cm:guard the transaction handle a write joins rather than the pool: a caller that has to commit two rows together passes this, and defaulting a parameter to `db` is what keeps the single-door writes single while letting one of them enlist (ISS-981).
export type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

// cm:guard returns without building when nothing ever touched `db`. Constructing a pool in order to
// close it is the substitution this refuses: a shutdown path that opens a connection is how a process
// that had none acquires one on its way out (ISS-1067).
export async function closeDb(): Promise<void> {
  if (queryClient === undefined) return;
  await queryClient.end({ timeout: 5 });
  queryClient = undefined;
  instance = undefined;
  bound.clear();
}
