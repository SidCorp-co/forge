import { relative } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { expect } from 'vitest';
import type { TestDatabase } from './db.js';
import { ownDbName, retireScratchDb, slotRefusal, workerDbName } from './scratch-db.js';
import { describeDrift, literal, readSchemaOn, schemaChangesOn } from './slot-digest.js';
import { truncateAll } from './truncate.js';

/**
 * What a slot database held the moment it was cloned, kept on the database's own comment so the
 * next file in the slot can read it without connecting: the schema to hold every holder to, the
 * rows the template seeds and the sequences' values, which is what a reset puts back.
 */
interface SlotRecord {
  v: 2;
  schema: { hash: string; objects: string };
  seed: Record<string, unknown[]>;
  sequences: Record<string, string | null>;
  holder: string;
}

const HELD = Symbol.for('forge.tests.slotDatabase');
type Holder = { [HELD]?: string };

const quiet = { onnotice: () => {} };

/**
 * Schemas the application creates when a file starts the queue (`src/queue/boss.ts`), not by
 * migration: runtime state, so the digest and the reset both drop them first.
 */
const RUNTIME_SCHEMAS = ['pgboss', 'pgboss_v10'];

async function dropRuntimeSchemas(client: Sql): Promise<void> {
  await client.unsafe(
    `DROP SCHEMA IF EXISTS ${RUNTIME_SCHEMAS.map((n) => `"${n}"`).join(', ')} CASCADE`,
  );
}

/** The test file this process is running, as the path a reader of a refusal would open. */
function currentFile(): string {
  const path = expect.getState().testPath;
  return path ? relative(process.cwd(), path) : 'a file vitest did not name';
}

function urlOf(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Open the database at `url` on a connection of its own, so nothing a test set on its sessions
 * changes how a definition reads, and drop the schemas the queue makes at runtime, as the reset
 * would, since no migration makes them; then answer what `read` reads there.
 */
async function settled<T>(url: string, read: (client: Sql) => Promise<T>): Promise<T> {
  const client = postgres(url, { max: 1, ...quiet });
  try {
    await dropRuntimeSchemas(client);
    return await read(client);
  } finally {
    await client.end({ timeout: 5 });
  }
}

function driftSince(was: SlotRecord['schema'], url: string): Promise<string[]> {
  return settled(url, (client) => schemaChangesOn(client, was.hash, () => unpack(was.objects)));
}

/** The per-object digest as the slot's record keeps it: compressed, since it runs to thousands. */
function pack(objects: Record<string, string>): string {
  return gzipSync(JSON.stringify(objects)).toString('base64');
}

function unpack(packed: string): Record<string, string> {
  return JSON.parse(gunzipSync(Buffer.from(packed, 'base64')).toString('utf8'));
}

const DECLARE =
  'A file that writes schema or runs a migration declares it at its own call site, ' +
  "setupTestDatabase({ own: '<what it changes>' }), and is given a database no other file is handed.";

async function snapshot(client: Sql, url: string, holder: string): Promise<SlotRecord> {
  const tables = await client<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
      AND table_name <> '__drizzle_migrations'
  `;
  const seed: Record<string, unknown[]> = {};
  if (tables.length > 0) {
    const seeded = await client.unsafe<{ name: string }[]>(
      tables
        .map((t) => `SELECT ${literal(t.name)} AS name WHERE EXISTS (SELECT 1 FROM "${t.name}")`)
        .join(' UNION ALL '),
    );
    for (const { name } of seeded) {
      const [row] = await client.unsafe<{ rows: unknown[] }[]>(
        `SELECT coalesce(json_agg(t), '[]'::json) AS rows FROM "${name}" t`,
      );
      seed[name] = row?.rows ?? [];
    }
  }
  const sequences = await client<{ name: string; last: string | null }[]>`
    SELECT quote_ident(schemaname) || '.' || quote_ident(sequencename) AS name, last_value::text AS last
    FROM pg_sequences
    WHERE schemaname <> 'information_schema' AND NOT starts_with(schemaname, 'pg_')
      AND schemaname <> ALL(${RUNTIME_SCHEMAS})
  `;
  const read = await settled(url, (client) => readSchemaOn(client, true));
  return {
    v: 2,
    schema: { hash: read.hash, objects: pack(read.objects ?? {}) },
    seed,
    sequences: Object.fromEntries(sequences.map((s) => [s.name, s.last])),
    holder,
  };
}

/**
 * Put a slot database back the way it was cloned: the queue's runtime schemas dropped, every table
 * emptied the way `truncateAll` empties one between cases, the template's seed rows written back,
 * every sequence set to its cloned value. Every slot database handed out goes through this and
 * nothing else, so no file is cleaned apart.
 */
async function resetSlot(client: Sql, record: SlotRecord): Promise<void> {
  await dropRuntimeSchemas(client);
  await truncateAll(drizzle(client, {}));
  await client`SELECT lo_unlink(oid) FROM pg_largeobject_metadata`;
  for (const [table, rows] of Object.entries(record.seed)) {
    const columns = await client<{ name: string }[]>`
      SELECT attname AS name FROM pg_attribute
      WHERE attrelid = ${`"${table}"`}::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''
      ORDER BY attnum
    `;
    const list = columns.map((c) => `"${c.name}"`).join(', ');
    await client.unsafe(
      `INSERT INTO "${table}" (${list}) OVERRIDING SYSTEM VALUE ` +
        `SELECT ${list} FROM json_populate_recordset(NULL::"${table}", $1::json)`,
      [JSON.stringify(rows)],
    );
  }
  for (const [sequence, last] of Object.entries(record.sequences)) {
    if (last === null) await client.unsafe(`ALTER SEQUENCE ${sequence} RESTART`);
    else await client.unsafe(`SELECT setval('${sequence}', ${BigInt(last)}, true)`);
  }
}

async function readRecord(admin: Sql, name: string): Promise<SlotRecord | null> {
  const [row] = await admin<{ comment: string | null }[]>`
    SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = ${name}
  `;
  if (!row?.comment) return null;
  try {
    const record = JSON.parse(row.comment) as SlotRecord;
    return record.v === 2 ? record : null;
  } catch {
    return null;
  }
}

async function writeRecord(admin: Sql, name: string, record: SlotRecord): Promise<void> {
  await admin.unsafe(`COMMENT ON DATABASE "${name}" IS ${literal(JSON.stringify(record))}`);
}

/** A session connected to a database, as a report names it. */
interface Session {
  pid: number;
  /** `pg_stat_activity.backend_type`: `client backend` for a connection somebody opened. */
  kind: string;
  app: string;
  state: string | null;
  query: string | null;
}

function sessionsOn(admin: Sql, name: string): Promise<Session[]> {
  return admin<Session[]>`
    SELECT pid, backend_type AS kind, application_name AS app, state, left(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 120) AS query
    FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid() ORDER BY pid
  `;
}

/**
 * A session a file can have left behind: every one but an autovacuum worker, which the server
 * starts on a database whose rows a file churned and no file opened or can close, so severing one
 * cancels a vacuum the next file's reset makes moot. A replication connection, a `walsender`, or a
 * parallel worker of a client's statement is named like the client's own.
 */
function opened(s: Session): boolean {
  return s.kind !== 'autovacuum worker';
}

function describeSession(s: Session): string {
  return `pid ${s.pid} ${s.app || 'with no application name'}, ${s.state} after "${s.query}"`;
}

/**
 * End every connection to `name` but the caller's and answer the sessions it ended, each as it was
 * last seen, refusing by pid any that is still there after its termination was waited on.
 */
export async function sever(admin: Sql, name: string): Promise<Session[]> {
  const rows = await sessionsOn(admin, name);
  for (const { pid } of rows) {
    await admin`SELECT pg_terminate_backend(${pid}, 5000)`.catch(() => {});
  }
  const left = rows.length > 0 ? await sessionsOn(admin, name) : [];
  if (left.length > 0) {
    throw new Error(
      `[db] ${name}: connection(s) ${left.map((r) => r.pid).join(', ')} outlived a terminate ` +
        'waited on for 5s, so the database cannot be reset or handed on while they can still write.',
    );
  }
  return rows;
}

/**
 * Report what is still connected to `name`, which is background work that outlived its file. A
 * client ended under a running statement resolves once the statement is done and its goodbye
 * written, while the server is still ending the session, so a session gets what Postgres gives one
 * before `DROP DATABASE` calls it in use (`CountOtherDBBackends`): fifty looks, 100ms apart.
 */
export async function reportLingeringConnections(admin: Sql, name: string): Promise<void> {
  let held: Session[];
  try {
    held = (await sessionsOn(admin, name)).filter(opened);
    for (let look = 1; held.length > 0 && look < 50; look++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      held = (await sessionsOn(admin, name)).filter(opened);
    }
  } catch (err) {
    console.error(
      `[db] ${name}: could not read what is still connected at teardown, so nothing still open ` +
        `is named: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (held.length > 0) {
    console.error(
      `[db] ${name}: ${held.length} connection(s) still open at teardown, severed now: ` +
        `${held.map(describeSession).join('; ')}. Whatever holds them is background work that ` +
        'outlived this file.',
    );
  }
}

/**
 * Move a slot database out of its slot's name so the next file there gets a fresh clone, and drop
 * it behind the caller: a rename is a catalog write, where a drop would wait on a checkpoint.
 */
async function setAside(admin: Sql, adminUrl: string, name: string): Promise<void> {
  await sever(admin, name);
  const aside = ownDbName();
  await admin.unsafe(`ALTER DATABASE "${name}" RENAME TO "${aside}"`);
  retireScratchDb(adminUrl, aside);
}

/** Clone the template under `name`; false where the slot already holds it. */
async function cloneUnlessHeld(
  admin: Sql,
  name: string,
  template: string,
  explain: (err: unknown) => string,
): Promise<boolean> {
  const [held] = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (held) return false;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '42P04') return false;
    throw new Error(explain(err), { cause: err });
  }
}

/** Hand the calling file its worker slot's database: tests/README.md, *One database per worker slot*. */
export async function claimSlotDatabase(
  adminUrl: string,
  template: string,
  explain: (err: unknown) => string,
  quiesce: () => Promise<void>,
): Promise<TestDatabase> {
  const refusal = slotRefusal(process.env);
  if (refusal) throw new Error(refusal);
  const holder = currentFile();
  const process_ = globalThis as Holder;
  const open = process_[HELD];
  if (open) {
    throw new Error(
      `[db] ${holder} asked for a second shared slot database while ${open} is still open. ` +
        'A file holds its slot database one at a time, because the second hand-out resets the ' +
        'database under the first. Give the first back through its cleanup() before asking again, ' +
        "or declare setupTestDatabase({ own: '<why>' }) for one no other harness is handed.",
    );
  }

  const name = workerDbName(process.env.VITEST_POOL_ID as string);
  const url = urlOf(adminUrl, name);
  const admin = postgres(adminUrl, { max: 1, ...quiet });
  let client: Sql | undefined;
  let record: SlotRecord;
  try {
    let fresh = await cloneUnlessHeld(admin, name, template, explain);
    let prior: SlotRecord | null = null;
    if (!fresh) {
      prior = await readRecord(admin, name);
      const severed = (await sever(admin, name)).filter(opened);
      if (severed.length > 0) {
        const since = prior ? prior.holder : 'a file that left no record';
        console.error(
          `[db] ${name}: ${severed.length} connection(s) left on it since ${since} held it were ` +
            `severed before ${holder} was handed it: ` +
            `${severed.map(describeSession).join('; ')}.`,
        );
      }
      if (prior === null) {
        console.error(
          `[db] ${name} carries no record of the clone it was, so a file that created it died ` +
            'before writing one; it is set aside and the slot cloned afresh.',
        );
        await setAside(admin, adminUrl, name);
        fresh = await cloneUnlessHeld(admin, name, template, explain);
      }
    }
    client = postgres(url, { max: 4, ...quiet });
    if (fresh || prior === null) {
      record = await snapshot(client, url, holder);
    } else {
      record = { ...prior, holder };
      const drift = await driftSince(prior.schema, url);
      if (drift.length > 0) {
        await client.end({ timeout: 5 }).catch(() => {});
        client = undefined;
        await setAside(admin, adminUrl, name);
        throw new Error(
          `[db] ${prior.holder} left the slot database ${name} with a schema the template does not ` +
            `have (${describeDrift(drift)}) and never gave it back through cleanup(), where it ` +
            `would have been refused. ${holder} is refused rather than run against it; the ` +
            `database is set aside and the next file in this slot gets a fresh clone. ${DECLARE}`,
        );
      }
    }
    await resetSlot(client, record);
    await writeRecord(admin, name, record);
  } catch (err) {
    await client?.end({ timeout: 5 }).catch(() => {});
    throw err;
  } finally {
    await admin.end({ timeout: 5 });
  }

  const live = client;
  process_[HELD] = holder;
  return {
    db: drizzle(live, {}),
    mode: 'container',
    client: live,
    url,
    cleanup: async () => {
      let drift: string[] = [];
      try {
        await quiesce();
      } finally {
        await live.end({ timeout: 5 }).catch(() => {});
        const reporter = postgres(adminUrl, { max: 1, ...quiet });
        try {
          await reportLingeringConnections(reporter, name);
          await sever(reporter, name);
          // Read once nothing else is connected: a temp table goes with its session, a rule does not.
          drift = await driftSince(record.schema, url);
          if (drift.length > 0) await setAside(reporter, adminUrl, name);
        } finally {
          await reporter.end({ timeout: 5 });
          delete process_[HELD];
        }
      }
      if (drift.length > 0) {
        throw new Error(
          `[db] ${holder} changed the schema of the slot database ${name}: ${describeDrift(drift)}. ` +
            'That database is handed to the next file in this worker slot, so it has to be given ' +
            `back the way the template made it. ${DECLARE} The database is set aside, so the next ` +
            'file in this slot gets a fresh clone.',
        );
      }
    },
  };
}
