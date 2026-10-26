import { relative } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
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
  v: 1;
  schema: Record<string, string>;
  seed: Record<string, unknown[]>;
  sequences: Record<string, string | null>;
  holder: string;
}

const HELD = Symbol.for('forge.tests.slotDatabase');
type Holder = { [HELD]?: string };

const quiet = { onnotice: () => {} };

/**
 * Schemas the application creates when a file starts the queue (`src/queue/boss.ts`), not by
 * migration: runtime state, so the digest leaves them out and the reset drops them.
 */
const RUNTIME_SCHEMAS = ['pgboss', 'pgboss_v10'];

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
 * One line per schema object of this database, mapped to a digest of its definition. Rows are not
 * in it; everything a migration could write is: relations with their columns, constraints, indexes,
 * triggers, policies and grants, functions, enums and domains, extensions, schemas, the database's
 * own settings, and how many migrations it has applied.
 */
export async function schemaDigest(url: string): Promise<Record<string, string>> {
  // A connection of its own, so nothing a test set on its sessions changes how a definition reads.
  const client = postgres(url, { max: 1, ...quiet });
  try {
    return await digestOn(client);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function digestOn(client: Sql): Promise<Record<string, string>> {
  const rows = await client<{ object: string; digest: string }[]>`
    WITH ns AS (
      SELECT oid, nspname FROM pg_namespace
      WHERE nspname <> 'information_schema' AND NOT starts_with(nspname, 'pg_')
        AND nspname <> ALL(${RUNTIME_SCHEMAS})
    )
    SELECT 'relation ' || ns.nspname || '.' || c.relname AS object, md5(concat_ws(E'\n',
      c.relkind, c.relrowsecurity, c.relacl::text,
      (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' ||
         a.attnotnull || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), E'\n' ORDER BY a.attnum)
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
      (SELECT string_agg(conname || ' ' || pg_get_constraintdef(oid), E'\n' ORDER BY conname)
       FROM pg_constraint WHERE conrelid = c.oid),
      (SELECT string_agg(pg_get_indexdef(indexrelid), E'\n' ORDER BY 1) FROM pg_index WHERE indrelid = c.oid),
      (SELECT string_agg(pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::text, E'\n' ORDER BY 1)
       FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal),
      (SELECT string_agg(polname || ' ' || coalesce(pg_get_expr(polqual, polrelid), ''), E'\n' ORDER BY 1)
       FROM pg_policy WHERE polrelid = c.oid),
      CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid) END,
      (SELECT concat_ws(' ', seqtypid, seqstart, seqincrement, seqmax, seqmin, seqcache, seqcycle)
       FROM pg_sequence WHERE seqrelid = c.oid)
    )) AS digest
    FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
    UNION ALL
    SELECT 'function ' || p.oid::regprocedure::text,
      md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, ''))
    FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.objid = p.oid AND e.deptype = 'e')
    UNION ALL
    SELECT 'type ' || t.oid::regtype::text, md5(concat_ws(E'\n', t.typtype,
      (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = t.oid),
      format_type(t.typbasetype, t.typtypmod), t.typnotnull, t.typdefault,
      (SELECT string_agg(conname || ' ' || pg_get_constraintdef(oid), E'\n' ORDER BY conname)
       FROM pg_constraint WHERE contypid = t.oid)))
    FROM pg_type t JOIN ns ON ns.oid = t.typnamespace
    WHERE t.typtype IN ('e', 'd')
    UNION ALL
    SELECT 'extension ' || extname, md5(extversion) FROM pg_extension
    UNION ALL
    SELECT 'schema ' || ns.nspname, md5(coalesce(n.nspacl::text, ''))
    FROM ns JOIN pg_namespace n ON n.oid = ns.oid
    UNION ALL
    SELECT 'database settings', md5(coalesce((SELECT setconfig::text FROM pg_db_role_setting
      WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())), ''))
    UNION ALL
    SELECT 'migrations applied', md5((SELECT count(*) FROM drizzle.__drizzle_migrations)::text)
  `;
  return Object.fromEntries(rows.map((r) => [r.object, r.digest]));
}

/** Every object `now` adds to, drops from or changes in `was`, one line each. */
export function schemaDrift(was: Record<string, string>, now: Record<string, string>): string[] {
  const drift: string[] = [];
  for (const [object, digest] of Object.entries(now)) {
    if (!(object in was)) drift.push(`added ${object}`);
    else if (was[object] !== digest) drift.push(`changed ${object}`);
  }
  for (const object of Object.keys(was)) if (!(object in now)) drift.push(`dropped ${object}`);
  return drift.sort();
}

function describeDrift(drift: string[]): string {
  const shown = drift.slice(0, 8).join('; ');
  return drift.length > 8 ? `${shown}; and ${drift.length - 8} more` : shown;
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
  return {
    v: 1,
    schema: await schemaDigest(url),
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
  await client.unsafe(
    `DROP SCHEMA IF EXISTS ${RUNTIME_SCHEMAS.map((n) => `"${n}"`).join(', ')} CASCADE`,
  );
  await truncateAll(drizzle(client, {}));
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
    return record.v === 1 ? record : null;
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
      const drift = schemaDrift(prior.schema, await schemaDigest(url));
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
        drift = schemaDrift(record.schema, await schemaDigest(url));
      } finally {
        await live.end({ timeout: 5 }).catch(() => {});
        const reporter = postgres(adminUrl, { max: 1, ...quiet });
        try {
          await reportLingeringConnections(reporter, name);
          await sever(reporter, name);
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
