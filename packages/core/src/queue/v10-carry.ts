/**
 * pg-boss 12 cannot migrate a pg-boss 10 schema (version 24): its oldest starting version is 25, and
 * 11.0.0 shipped no migration from 10 at all. So the v10 schema is set aside whole before pg-boss 12
 * installs, and its live jobs are carried across by id in one transaction. Completed, failed and
 * cancelled jobs and the archive stay where they were, readable, under `<schema>_v10`.
 */
import pg from 'pg';
import { type JobInsert, type PgBoss, policies, type Queue, type QueuePolicy } from 'pg-boss';

export const V10_SCHEMA_VERSION = 24;
const FIRST_SELF_MIGRATING_VERSION = 25;
const CARRY_APPLICATION = 'forge-pgboss-carry';
/** pg-boss's own sessions name themselves this unless told otherwise, in 10 as in 12. */
const PGBOSS_APPLICATION = 'pgboss';
const LIVE_STATES = ['created', 'retry', 'active'] as const;

export class BossSchemaRefusal extends Error {
  override name = 'BossSchemaRefusal';
}

export interface BossSchemas {
  schema: string;
  setAside: string;
}

export function bossSchemas(schema = 'pgboss'): BossSchemas {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new BossSchemaRefusal(
      `pg-boss schema name "${schema}" is not a lowercase SQL identifier ([a-z_][a-z0-9_]*).`,
    );
  }
  return { schema, setAside: `${schema}_v10` };
}

type Client = pg.Client;

async function connect(connectionString: string): Promise<Client> {
  const client = new pg.Client({ connectionString, application_name: CARRY_APPLICATION });
  await client.connect();
  return client;
}

async function inTransaction<T>(
  connectionString: string,
  lockKey: string,
  body: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connect(connectionString);
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

async function exists(client: Client, relation: string): Promise<boolean> {
  const { rows } = await client.query<{ found: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS found',
    [relation],
  );
  return rows[0]?.found === true;
}

async function count(client: Client, sql: string, values: unknown[] = []): Promise<number> {
  const { rows } = await client.query<{ n: number }>(sql, values);
  return Number(rows[0]?.n ?? 0);
}

export type SetAside =
  | { action: 'none'; version: number | null }
  | { action: 'set-aside'; version: typeof V10_SCHEMA_VERSION };

/**
 * Renames a pg-boss 10 schema out of pg-boss 12's way. Refuses, naming what it found, a schema older
 * than 10's, a pg-boss session still connected to this database, and a v10 subscription.
 */
export async function setAsideV10Schema(
  connectionString: string,
  schemas: BossSchemas = bossSchemas(),
): Promise<SetAside> {
  const { schema, setAside } = schemas;
  return inTransaction(connectionString, `forge.pgboss-set-aside:${schema}`, async (client) => {
    if (!(await exists(client, `${schema}.version`))) return { action: 'none', version: null };
    const version = await count(client, `SELECT max(version)::int AS n FROM ${schema}.version`);
    if (version >= FIRST_SELF_MIGRATING_VERSION) return { action: 'none', version };
    if (version < V10_SCHEMA_VERSION) {
      throw new BossSchemaRefusal(
        `pg-boss schema "${schema}" is at version ${version}. This core carries work only from pg-boss 10's version ${V10_SCHEMA_VERSION}: start a pg-boss 10 release against this database first so it migrates to ${V10_SCHEMA_VERSION}.`,
      );
    }
    await client.query(
      `LOCK TABLE ${schema}.job, ${schema}.queue, ${schema}.schedule, ${schema}.version IN ACCESS EXCLUSIVE MODE`,
    );
    const held = await client.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()`,
      [PGBOSS_APPLICATION],
    );
    if (held.rows.length > 0) {
      throw new BossSchemaRefusal(
        `pg-boss schema "${schema}" is still pg-boss 10's and ${held.rows.length} pg-boss session(s) are connected to this database (pid ${held.rows.map((r) => r.pid).join(', ')}). The schema is set aside only once no pg-boss 10 process runs: stop it, and this boot is retried.`,
      );
    }
    const subscriptions = await count(
      client,
      `SELECT count(*)::int AS n FROM ${schema}.subscription`,
    );
    if (subscriptions > 0) {
      throw new BossSchemaRefusal(
        `pg-boss schema "${schema}" holds ${subscriptions} pub/sub subscription(s), which this carry does not move: core never subscribes, so read ${schema}.subscription and remove them by hand before booting.`,
      );
    }
    if (await exists(client, `${setAside}.version`)) {
      throw new BossSchemaRefusal(
        `pg-boss schema "${schema}" is at version ${V10_SCHEMA_VERSION} and "${setAside}" already exists, so there is nowhere to set it aside. Read both before booting.`,
      );
    }
    await client.query(`ALTER SCHEMA ${schema} RENAME TO ${setAside}`);
    return { action: 'set-aside', version: V10_SCHEMA_VERSION };
  });
}

interface V10Job {
  id: string;
  name: string;
  priority: number;
  data: object | null;
  state: (typeof LIVE_STATES)[number];
  retry_limit: number;
  retry_count: number;
  retry_delay: number;
  retry_backoff: boolean;
  start_after: Date;
  singleton_key: string | null;
  expire_seconds: number;
  dead_letter: string | null;
  retention_seconds: number;
}

interface V10Queue {
  name: string;
  policy: string | null;
  retry_limit: number | null;
  retry_delay: number | null;
  retry_backoff: boolean | null;
  expire_seconds: number | null;
  retention_minutes: number | null;
  dead_letter: string | null;
}

export interface Carry {
  carried: Record<(typeof LIVE_STATES)[number], number>;
  queues: string[];
  /** Live jobs pg-boss 10 would already have deleted at its next maintenance. */
  pastRetention: number;
  history: number;
  /** Schedules core does not carry: it registers its own at boot. */
  schedulesLeft: number;
}

function queueOptions(row: V10Queue): Omit<Queue, 'name'> {
  const options: Omit<Queue, 'name'> = {};
  if (row.policy) {
    if (!(row.policy in policies)) {
      throw new BossSchemaRefusal(
        `pg-boss 10 queue "${row.name}" has policy "${row.policy}", which pg-boss 12 does not know (${Object.keys(policies).join(', ')}).`,
      );
    }
    options.policy = row.policy as QueuePolicy;
  }
  if (row.retry_limit !== null) options.retryLimit = row.retry_limit;
  if (row.retry_delay !== null) options.retryDelay = row.retry_delay;
  if (row.retry_backoff !== null) options.retryBackoff = row.retry_backoff;
  if (row.expire_seconds) options.expireInSeconds = row.expire_seconds;
  if (row.retention_minutes) options.retentionSeconds = row.retention_minutes * 60;
  if (row.dead_letter) options.deadLetter = row.dead_letter;
  return options;
}

/**
 * pg-boss 10 allows `retry_limit + 1` attempts and counts a re-attempt in `retry_count` only when it
 * is fetched, so a job waiting in `retry` has used `retry_count + 1` of them. An `active` job's
 * attempt was cut short by the deploy, and is not counted against it.
 */
function retriesLeft(row: V10Job): number {
  const used = row.state === 'retry' ? row.retry_count + 1 : row.retry_count;
  return Math.max(row.retry_limit - used, 0);
}

function jobInsert(row: V10Job): JobInsert {
  const job: JobInsert = {
    id: row.id,
    priority: row.priority,
    retryLimit: retriesLeft(row),
    retryDelay: row.retry_delay,
    retryBackoff: row.retry_backoff,
    startAfter: row.start_after,
    expireInSeconds: row.expire_seconds,
    retentionSeconds: row.retention_seconds,
  };
  if (row.data !== null) job.data = row.data;
  if (row.singleton_key !== null) job.singletonKey = row.singleton_key;
  if (row.dead_letter !== null) job.deadLetter = row.dead_letter;
  return job;
}

/** Queues in an order where each dead-letter target is created before the queue naming it. */
function inCreationOrder(queues: Map<string, V10Queue>, wanted: Iterable<string>): V10Queue[] {
  const ordered: V10Queue[] = [];
  const placed = new Set<string>();
  const place = (name: string, path: string[]) => {
    if (placed.has(name)) return;
    const row = queues.get(name);
    if (!row) {
      throw new BossSchemaRefusal(
        `pg-boss 10 job or dead letter names queue "${name}", which its queue table does not hold (via ${path.join(' -> ')}).`,
      );
    }
    if (row.dead_letter && !path.includes(row.dead_letter)) place(row.dead_letter, [...path, name]);
    placed.add(name);
    ordered.push(row);
  };
  for (const name of wanted) place(name, []);
  return ordered;
}

/**
 * Carries every live pg-boss 10 job into pg-boss 12 by id, once. Queue creation goes first and is
 * idempotent; the inserts and the marker that lists them commit together or not at all.
 */
export async function carryV10Jobs(
  boss: PgBoss,
  connectionString: string,
  schemas: BossSchemas = bossSchemas(),
): Promise<Carry | null> {
  const { schema, setAside } = schemas;
  return inTransaction(connectionString, `forge.pgboss-carry:${schema}`, async (client) => {
    if (!(await exists(client, `${setAside}.version`))) return null;
    if (await exists(client, `${setAside}.carried_to_v12`)) return null;
    const live = await client.query<V10Job>(
      `SELECT id, name, priority, data, state::text AS state, retry_limit, retry_count, retry_delay,
              retry_backoff, start_after, singleton_key, dead_letter,
              EXTRACT(epoch FROM expire_in)::int AS expire_seconds,
              GREATEST(CEIL(EXTRACT(epoch FROM keep_until - now())), 1)::int AS retention_seconds
         FROM ${setAside}.job
        WHERE state::text = ANY($1) AND keep_until > now()
        ORDER BY name, created_on, id`,
      [LIVE_STATES],
    );
    const pastRetention = await count(
      client,
      `SELECT count(*)::int AS n FROM ${setAside}.job WHERE state::text = ANY($1) AND keep_until <= now()`,
      [LIVE_STATES],
    );
    const history = await count(
      client,
      `SELECT (SELECT count(*) FROM ${setAside}.job WHERE NOT (state::text = ANY($1)))::int
            + (SELECT count(*) FROM ${setAside}.archive)::int AS n`,
      [LIVE_STATES],
    );
    const schedulesLeft = await count(
      client,
      `SELECT count(*)::int AS n FROM ${setAside}.schedule`,
    );
    const queueRows = await client.query<V10Queue>(
      `SELECT name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds,
              retention_minutes, dead_letter
         FROM ${setAside}.queue`,
    );
    const byName = new Map(queueRows.rows.map((row) => [row.name, row]));
    const wanted = new Set(
      live.rows.flatMap((row) => [row.name, ...(row.dead_letter ? [row.dead_letter] : [])]),
    );
    const queues = inCreationOrder(byName, wanted);
    for (const row of queues) await boss.createQueue(row.name, queueOptions(row));

    const db = {
      executeSql: async (text: string, values?: unknown[]) => {
        const result = await client.query(text, values);
        return { rows: result.rows };
      },
    };
    const carried = { created: 0, retry: 0, active: 0 };
    const byQueue = new Map<string, V10Job[]>();
    for (const row of live.rows) {
      const bucket = byQueue.get(row.name);
      if (bucket) bucket.push(row);
      else byQueue.set(row.name, [row]);
    }
    for (const [name, rows] of byQueue) {
      const ids = (await boss.insert(name, rows.map(jobInsert), { db, returnId: true })) ?? [];
      if (ids.length !== rows.length) {
        const kept = new Set(ids);
        const dropped = rows.filter((row) => !kept.has(row.id)).map((row) => row.id);
        throw new BossSchemaRefusal(
          `pg-boss 12 kept ${ids.length} of ${rows.length} pg-boss 10 job(s) carried into queue "${name}"; it dropped ${dropped.join(', ')}, which a singleton key or id it already holds refuses. Nothing was carried.`,
        );
      }
      for (const row of rows) carried[row.state] += 1;
    }
    await client.query(
      `CREATE TABLE ${setAside}.carried_to_v12 (
         id uuid PRIMARY KEY,
         name text NOT NULL,
         carried_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    if (live.rows.length > 0) {
      // Unqualified, so the comments table's single-door scan can read which table this writes.
      await client.query(`SET LOCAL search_path TO ${setAside}`);
      await client.query(
        'INSERT INTO carried_to_v12 (id, name) SELECT * FROM unnest($1::uuid[], $2::text[])',
        [live.rows.map((row) => row.id), live.rows.map((row) => row.name)],
      );
    }
    return {
      carried,
      queues: queues.map((row) => row.name),
      pastRetention,
      history,
      schedulesLeft,
    };
  });
}
