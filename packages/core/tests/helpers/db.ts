import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { startPostgresContainer } from './container.js';
import { runMigrations } from './migrate.js';
import { createTestSchema, resolveDbSource } from './schema-mode.js';
import { drainRetiredScratchDbs, ownDbName, retireScratchDb } from './scratch-db.js';
import { claimSlotDatabase, reportLingeringConnections } from './slot-db.js';

export type TestDb = PostgresJsDatabase<Record<string, unknown>>;

export interface TestDatabase {
  db: TestDb;
  /** Mode actually used (`schema-mode.ts:resolveDbSource`). */
  mode: 'container' | 'schema';
  /** Raw postgres-js client — exposed for `end()` and advanced uses. */
  client: Sql;
  /** The URL to set as `process.env.DATABASE_URL` before importing the app under test. */
  url: string;
  /** Stop the connection + tear down the container / drop the schema. */
  cleanup: () => Promise<void>;
}

export interface SetupOptions {
  /**
   * Why this file cannot share its worker slot's database — what it changes that the next file in
   * the slot would inherit, such as schema written or a migration run. Declaring it clones a
   * database no other file is handed.
   */
  own?: string;
}

export async function setupTestDatabase(options: SetupOptions = {}): Promise<TestDatabase> {
  const source = resolveDbSource(process.env);
  const own = ownReason(options);
  const { reopenAfterQuiesce } = await import('./quiesce.js');
  await reopenAfterQuiesce();

  const workerId = process.env.VITEST_POOL_ID ?? '0';

  const cloned = await cloneFromTemplate(own);
  if (cloned) return cloned;

  let url: string;
  let teardown: () => Promise<void>;

  if (source.mode === 'container') {
    const container = await startPostgresContainer();
    url = container.url;
    teardown = container.stop;
  } else {
    const schema = await createTestSchema(source.url, workerId);
    url = schema.url;
    teardown = schema.drop;
  }

  const client = postgres(url, { max: 4, onnotice: () => {} });
  const db = drizzle(client, {});

  try {
    await runMigrations(db);
  } catch (err) {
    await client.end({ timeout: 5 }).catch(() => {});
    await teardown().catch(() => {});
    throw err;
  }

  return {
    db,
    mode: source.mode,
    client,
    url,
    cleanup: async () => {
      await quiesce();
      try {
        await client.end({ timeout: 5 });
      } finally {
        await teardown();
      }
    },
  };
}

/** The reason a caller declared for a database of its own, refused by name where it gives none. */
function ownReason(options: SetupOptions): string | undefined {
  if (!('own' in options)) return undefined;
  if (typeof options.own === 'string' && options.own.trim() !== '') return options.own;
  throw new Error(
    `setupTestDatabase({ own }) takes the reason this file cannot share its worker slot's ` +
      `database — what it changes that the next file would inherit — and ${JSON.stringify(options.own)} ` +
      'gives none.',
  );
}

/**
 * Fast path: the already-migrated template built once by `tests/helpers/global-setup.ts`. A file
 * shares its worker slot's database (`slot-db.ts:claimSlotDatabase`) unless it declared `own`, which
 * clones one for it alone. Postgres copies a template at the file level, so either replaces a
 * container boot AND a full migration replay with one `CREATE DATABASE`.
 *
 * Null where global setup did not run (a config without `globalSetup`): the container or schema
 * path is then the fallback.
 */
async function cloneFromTemplate(own: string | undefined): Promise<TestDatabase | null> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  const template = process.env.TEST_PG_TEMPLATE;
  if (!adminUrl || !template) return null;
  const explain = (err: unknown) => explainCloneFailure(template, err);
  if (own === undefined) {
    return claimSlotDatabase(adminUrl, template, explain, quiesce);
  }
  return cloneOwnDatabase(adminUrl, template, explain);
}

/** A clone for one file that declared it cannot share, dropped behind it when it is done. */
async function cloneOwnDatabase(
  adminUrl: string,
  template: string,
  explain: (err: unknown) => string,
): Promise<TestDatabase> {
  const dbName = ownDbName();

  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${template}"`);
  } catch (err) {
    throw new Error(explain(err), { cause: err });
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const client = postgres(url.toString(), { max: 4, onnotice: () => {} });

  return {
    db: drizzle(client, {}),
    mode: 'container',
    client,
    url: url.toString(),
    cleanup: async () => {
      await quiesce();
      await client.end({ timeout: 5 }).catch(() => {});
      const reporter = postgres(adminUrl, { max: 1 });
      try {
        await reportLingeringConnections(reporter, dbName);
      } finally {
        await reporter.end({ timeout: 5 });
      }
      // This runs inside the file's `afterAll`, which vitest gives 60s. `DROP DATABASE` forces a
      // cluster-wide checkpoint and waits for it, which is a number this file does not own and
      // which was sampled past that budget with two suites on one server. So the name goes to the
      // drain and the wait is bounded by a grace instead: what the grace does not reach is the run
      // sweep's, and after that the next run's reaper.
      retireScratchDb(adminUrl, dbName);
      await drainRetiredScratchDbs();
    },
  };
}

function explainCloneFailure(template: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (/does not exist/.test(detail)) {
    return (
      `could not clone the template database "${template}" — it is gone. ` +
      'This is an ENVIRONMENT condition, not a failure of the code under test: global setup ' +
      'built or took this template and something outside this run removed it. Re-run the suite; if it ' +
      'recurs, look for another process dropping databases on this server.'
    );
  }
  if (/being accessed by other users/.test(detail)) {
    return (
      `could not clone the template database "${template}" — it still has open connections. ` +
      'This is an ENVIRONMENT condition, not a failure of the code under test. Postgres copies ' +
      'a template at the file level and refuses while anything is attached to it.'
    );
  }
  return `could not clone the template database "${template}": ${detail}`;
}

async function quiesce(): Promise<void> {
  const { quiesceBackgroundWork } = await import('./quiesce.js');
  await quiesceBackgroundWork();
}
