import { relative } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { expect } from 'vitest';
import type { TestDatabase } from './db.js';
import { ownDbName, retireScratchDb, slotRefusal, workerDbName } from './scratch-db.js';
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

function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * Catalog columns that move by use rather than by DDL: storage, planner statistics, freeze
 * horizons, and the `relhas*` flags vacuum clears lazily (the rows they summarise are read anyway).
 */
const MOVES_BY_USE: Record<string, string[]> = {
  pg_class: [
    'relfilenode',
    'relpages',
    'reltuples',
    'relallvisible',
    'relallfrozen',
    'relfrozenxid',
    'relminmxid',
    'relhasindex',
    'relhasrules',
    'relhastriggers',
    'relhassubclass',
  ],
};

/**
 * Catalogs whose rows are data rather than schema: what ANALYZE writes, and large objects, which
 * the reset removes as it removes rows.
 */
const DATA_CATALOGS = [
  'pg_statistic',
  'pg_statistic_ext_data',
  'pg_largeobject',
  'pg_largeobject_metadata',
];

/**
 * For a catalog with no `oid` of its own, the object a row belongs to — its catalog and its oid —
 * and what the row is of that object. A catalog neither here nor carrying an `oid` is digested
 * whole, under its own name, so a catalog a later Postgres adds is still read.
 */
const BELONGS_TO: Record<string, { cls: string; obj: string; what: string }> = {
  pg_attribute: { cls: "'pg_class'::regclass", obj: 'attrelid', what: 'columns of ' },
  pg_index: { cls: "'pg_class'::regclass", obj: 'indexrelid', what: '' },
  pg_inherits: { cls: "'pg_class'::regclass", obj: 'inhrelid', what: 'inheritance of ' },
  pg_sequence: { cls: "'pg_class'::regclass", obj: 'seqrelid', what: 'options of ' },
  pg_partitioned_table: { cls: "'pg_class'::regclass", obj: 'partrelid', what: 'partitioning of ' },
  pg_foreign_table: { cls: "'pg_class'::regclass", obj: 'ftrelid', what: 'foreign options of ' },
  pg_subscription_rel: { cls: "'pg_class'::regclass", obj: 'srrelid', what: 'subscription of ' },
  pg_aggregate: { cls: "'pg_proc'::regclass", obj: 'aggfnoid', what: 'aggregate ' },
  pg_range: { cls: "'pg_type'::regclass", obj: 'rngtypid', what: 'range of ' },
  // An enum label has an oid, but no description of its own (`pg_describe_object` refuses it).
  pg_enum: { cls: "'pg_type'::regclass", obj: 'enumtypid', what: 'labels of ' },
  pg_ts_config_map: { cls: "'pg_ts_config'::regclass", obj: 'mapcfg', what: 'mapping of ' },
  pg_depend: { cls: 'classid', obj: 'objid', what: 'dependencies of ' },
  pg_description: { cls: 'classoid', obj: 'objoid', what: 'comment on ' },
  pg_init_privs: { cls: 'classoid', obj: 'objoid', what: 'initial privileges of ' },
  pg_seclabel: { cls: 'classoid', obj: 'objoid', what: 'security label on ' },
};

/** Rows of a catalog that are a session's and not the database's: the namespaces temp tables use. */
const SESSION_ROWS: Record<string, string> = {
  pg_namespace: "nspname !~ '^pg_(toast_)?temp_'",
};

/** The first oid `initdb` does not hand out (`FirstNormalObjectId`): below it, a built-in object. */
const FIRST_NORMAL_OID = 16384;

/** A connection, or a transaction on one: a digest reads either as it stands. */
type Reader = Sql | TransactionSql;

/** Every database-local catalog and its columns, less those that move by use. */
function catalogs(client: Reader): Promise<{ name: string; columns: string[] }[]> {
  // One server per run and no DDL reaches pg_catalog, so a process reads the list once.
  catalogList ??= listCatalogs(client);
  return catalogList;
}

let catalogList: Promise<{ name: string; columns: string[] }[]> | undefined;

async function listCatalogs(client: Reader): Promise<{ name: string; columns: string[] }[]> {
  const rows = await client<{ name: string; columns: string[] }[]>`
    SELECT c.relname AS name, array_agg(a.attname::text ORDER BY a.attnum) AS columns
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relnamespace = 'pg_catalog'::regnamespace AND c.relkind = 'r' AND NOT c.relisshared
      AND c.relname <> ALL(${DATA_CATALOGS})
    GROUP BY c.relname
    ORDER BY c.relname
  `;
  return rows.map(({ name, columns }) => ({
    name,
    columns: columns.filter((col) => !(MOVES_BY_USE[name] ?? []).includes(col)),
  }));
}

/** One select per catalog: the object each row belongs to, and the row as text. */
function catalogRows({ name, columns }: { name: string; columns: string[] }): string {
  const owner = BELONGS_TO[name];
  const [label, cls, obj] = owner
    ? [owner.what, owner.cls, `t.${owner.obj}`]
    : columns.includes('oid')
      ? ['', `'pg_catalog.${name}'::regclass`, 't.oid']
      : [`catalog ${name}`, 'NULL', 'NULL'];
  const row = `ROW(${columns.map((col) => `t."${col}"`).join(', ')})::text`;
  const where = SESSION_ROWS[name] ? ` WHERE ${SESSION_ROWS[name]}` : '';
  return (
    `SELECT ${literal(name)} AS catalog, ${literal(label)} AS label, (${cls})::oid AS cls, ` +
    `(${obj})::oid AS obj, ${row} AS r FROM pg_catalog."${name}" t${where}`
  );
}

/** Every catalog row of the database `client` is on, with what is not in a catalog of its own. */
async function everyRow(client: Reader): Promise<string> {
  const rows = (await catalogs(client)).map(catalogRows);
  rows.push(
    "SELECT 'pg_database', 'this database''s grants and settings', NULL, NULL, " +
      "concat_ws(E'\\n', datacl::text, datconnlimit, datallowconn, (SELECT string_agg(" +
      "setrole::regrole::text || ' ' || setconfig::text, E'\\n' ORDER BY setrole) " +
      'FROM pg_db_role_setting WHERE setdatabase = d.oid)) ' +
      'FROM pg_database d WHERE datname = current_database()',
    "SELECT 'drizzle', 'migrations applied', NULL, NULL, count(*)::text FROM drizzle.__drizzle_migrations",
  );
  return rows.join('\nUNION ALL\n');
}

/**
 * One hash over every catalog row of the database `client` is on, which any schema change moves:
 * it reads every catalog rather than a list of object kinds, so a rule, an aggregate, a comment, a
 * collation, a statistics object or a storage option is a change as a table is. Rows of a table
 * are not in it; how many migrations it applied, its own settings and its grants are. The rows of
 * one catalog are summed by hash, so where Postgres keeps them does not move it.
 */
async function schemaHashOn(client: Reader): Promise<string> {
  const [row] = await client.unsafe<{ hash: string }[]>(`
    WITH r AS (${await everyRow(client)})
    SELECT md5(string_agg(catalog || ' ' || label || ' ' || n || ' ' || s, E'\\n'
      ORDER BY catalog, label)) AS hash
    FROM (
      SELECT catalog, CASE WHEN cls IS NULL THEN label ELSE '' END AS label, count(*) AS n,
        sum(hashtextextended(r, 0)::numeric) AS s
      FROM r GROUP BY 1, 2
    ) x
  `);
  return row?.hash ?? '';
}

/**
 * The same catalog rows as `schemaHashOn`, by the object each belongs to and named the way Postgres
 * names it (`pg_describe_object`), so a difference names what changed. Objects `initdb` made are
 * read one catalog at a time.
 */
async function schemaDigestOn(client: Reader): Promise<Record<string, string>> {
  const rows = await client.unsafe<{ object: string; digest: string }[]>(`
    WITH r AS (${await everyRow(client)}),
    grouped AS (
      SELECT catalog, label, cls, CASE WHEN obj >= ${FIRST_NORMAL_OID} THEN obj END AS obj,
        md5(string_agg(r, E'\\n' ORDER BY r)) AS digest
      FROM r GROUP BY 1, 2, 3, 4
    ),
    named AS (
      SELECT CASE
        WHEN cls IS NULL THEN label
        WHEN obj IS NULL THEN 'built-in rows of ' || catalog
        ELSE label || coalesce(pg_describe_object(cls, obj, 0), catalog || ' row ' || obj)
      END AS object, digest
      FROM grouped
    )
    SELECT object, left(md5(string_agg(digest, '' ORDER BY digest)), 12) AS digest
    FROM named GROUP BY object
  `);
  return Object.fromEntries(rows.map((r) => [r.object, r.digest]));
}

/** What a schema read answers: the hash, and the digest of every object where it was asked for. */
interface SchemaRead {
  hash: string;
  objects?: Record<string, string>;
}

/** The schema `client` reads as it stands, a transaction's own changes included. */
export async function readSchemaOn(client: Reader, named: boolean): Promise<SchemaRead> {
  const hash = await schemaHashOn(client);
  return named ? { hash, objects: await schemaDigestOn(client) } : { hash };
}

/**
 * The objects added, dropped or changed since a read that hashed to `hash`, named against its
 * digest, `objects`, which is unpacked only once the hash says something moved.
 */
export async function schemaChangesOn(
  client: Reader,
  hash: string,
  objects: () => Record<string, string>,
): Promise<string[]> {
  if ((await schemaHashOn(client)) === hash) return [];
  const drift = schemaDrift(objects(), await schemaDigestOn(client));
  return drift.length > 0 ? drift : ['changed a catalog row no named object owns'];
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

/** Every object `now` adds to, drops from or changes in `was`, one line each. */
function schemaDrift(was: Record<string, string>, now: Record<string, string>): string[] {
  const drift: string[] = [];
  for (const [object, digest] of Object.entries(now)) {
    if (!(object in was)) drift.push(`added ${object}`);
    else if (was[object] !== digest) drift.push(`changed ${object}`);
  }
  for (const object of Object.keys(was)) if (!(object in now)) drift.push(`dropped ${object}`);
  return drift.sort();
}

/** The prefix a row of `BELONGS_TO` puts before the object it belongs to, where `object` has one. */
function belongsPrefix(object: string): string | undefined {
  return Object.values(BELONGS_TO).find((b) => b.what && object.startsWith(b.what))?.what;
}

/**
 * The drift as a reader acts on it: what belongs to an object added or dropped with it is left out,
 * since naming the object says it; then the objects themselves, what belongs to the others, and
 * TOAST last.
 */
function describeDrift(drift: string[]): string {
  const said = new Set(drift);
  const weight = (line: string): number => {
    const object = line.slice(line.indexOf(' ') + 1);
    if (object.includes('pg_toast.')) return 2;
    return belongsPrefix(object) ? 1 : 0;
  };
  const kept = drift.filter((line) => {
    const [verb] = line.split(' ', 1);
    const object = line.slice(line.indexOf(' ') + 1);
    const prefix = belongsPrefix(object);
    return !prefix || verb === 'changed' || !said.has(`${verb} ${object.slice(prefix.length)}`);
  });
  const ordered = kept.sort((a, b) => weight(a) - weight(b) || a.localeCompare(b));
  const shown = ordered.slice(0, 8).join('; ');
  return ordered.length > 8 ? `${shown}; and ${ordered.length - 8} more` : shown;
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

/**
 * End every connection to `name` but the caller's and answer how many there were, refusing by pid
 * any that is still there after its termination was waited on.
 */
export async function sever(admin: Sql, name: string): Promise<number> {
  const others = () => admin<{ pid: number }[]>`
    SELECT pid FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid()
  `;
  const rows = await others();
  for (const { pid } of rows) {
    await admin`SELECT pg_terminate_backend(${pid}, 5000)`.catch(() => {});
  }
  const left = rows.length > 0 ? await others() : [];
  if (left.length > 0) {
    throw new Error(
      `[db] ${name}: connection(s) ${left.map((r) => r.pid).join(', ')} outlived a terminate ` +
        'waited on for 5s, so the database cannot be reset or handed on while they can still write.',
    );
  }
  return rows.length;
}

/** Report what is still connected to `name`, which is background work that outlived its file. */
export async function reportLingeringConnections(admin: Sql, name: string): Promise<void> {
  try {
    const rows = await admin<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_stat_activity
      WHERE datname = ${name} AND pid <> pg_backend_pid()
    `;
    const n = Number(rows[0]?.count ?? '0');
    if (n > 0) {
      console.error(
        `[db] ${name}: ${n} connection(s) still open at teardown, severed now; ` +
          'whatever holds them is background work that outlived this file.',
      );
    }
  } catch {}
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
      const severed = await sever(admin, name);
      if (severed > 0) {
        console.error(
          `[db] ${name}: ${severed} connection(s) the previous file in this slot left were severed ` +
            `before ${holder} was handed the database.`,
        );
      }
      prior = await readRecord(admin, name);
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
