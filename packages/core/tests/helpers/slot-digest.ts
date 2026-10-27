import type { Sql, TransactionSql } from 'postgres';

export function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * Catalog columns that move by use rather than by DDL: storage, planner statistics, freeze
 * horizons, the `relhas*` flags vacuum clears lazily (the rows they summarise are read anyway), and
 * what a table rewrite (VACUUM FULL, CLUSTER) moves: a column's missing value, which it writes into
 * the rows, and the table's TOAST table, which it drops where no live column needs one.
 */
const MOVES_BY_USE: Record<string, string[]> = {
  pg_attribute: ['atthasmissing', 'attmissingval'],
  pg_class: [
    'relfilenode',
    'reltoastrelid',
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

/** Catalogs whose rows are data, not schema: what ANALYZE writes, and large objects the reset removes. */
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

/**
 * A TOAST table and its index are storage Postgres makes and drops with a rewrite, which `pg_dump
 * -s` never prints: every row belonging to one is left out, and the storage options a table set on
 * its TOAST table are read as the table's (`TOAST_OPTIONS`).
 */
const TOAST_RELATIONS = "SELECT oid FROM pg_class WHERE relnamespace = 'pg_toast'::regnamespace";

const TOAST_OPTIONS =
  "SELECT 'pg_class', 'toast options of ', 'pg_class'::regclass, c.oid, ROW(c.oid, t.reloptions)::text " +
  'FROM pg_class c JOIN pg_class t ON t.oid = c.reltoastrelid WHERE t.reloptions IS NOT NULL';

/** The first oid `initdb` does not hand out (`FirstNormalObjectId`): below it, a built-in object. */
const FIRST_NORMAL_OID = 16384;

/** A connection, or a transaction on one: a digest reads either as it stands. */
type Reader = Sql | TransactionSql;

/** A catalog, its columns less those that move by use, and the catalog each oid column names. */
interface Catalog {
  name: string;
  columns: string[];
  refs: Record<string, { pk: string; array: boolean }>;
}

/** Every database-local catalog and its columns, less those that move by use. */
function catalogs(client: Reader): Promise<Catalog[]> {
  // One server per run and no DDL reaches pg_catalog, so a process reads the list once.
  catalogList ??= listCatalogs(client);
  return catalogList;
}

let catalogList: Promise<Catalog[]> | undefined;

async function listCatalogs(client: Reader): Promise<Catalog[]> {
  const rows = await client<{ name: string; columns: string[] }[]>`
    SELECT c.relname AS name, array_agg(a.attname::text ORDER BY a.attnum) AS columns
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relnamespace = 'pg_catalog'::regnamespace AND c.relkind = 'r' AND NOT c.relisshared
      AND c.relname <> ALL(${DATA_CATALOGS})
    GROUP BY c.relname
    ORDER BY c.relname
  `;
  const keys = await client<{ fk: string; col: string; pk: string; array: boolean }[]>`
    SELECT fktable::text AS fk, fkcols[1] AS col, pktable::text AS pk, is_array AS array
    FROM pg_get_catalog_foreign_keys()
    WHERE cardinality(fkcols) = 1 AND pkcols = ARRAY['oid']
  `;
  return rows.map(({ name, columns }) => ({
    name,
    columns: columns.filter((col) => !(MOVES_BY_USE[name] ?? []).includes(col)),
    refs: Object.fromEntries(
      keys.filter((k) => k.fk === name).map((k) => [k.col, { pk: k.pk, array: k.array }]),
    ),
  }));
}

/** Columns naming an object of the catalog the column beside them names: `[class, object, sub]`. */
const NAMES_ANY: Record<string, Record<string, [string, string, string]>> = {
  pg_depend: {
    objid: ['classid', 'objid', 'objsubid'],
    refobjid: ['refclassid', 'refobjid', 'refobjsubid'],
  },
  pg_description: { objoid: ['classoid', 'objoid', 'objsubid'] },
  pg_init_privs: { objoid: ['classoid', 'objoid', 'objsubid'] },
  pg_seclabel: { objoid: ['classoid', 'objoid', 'objsubid'] },
};

/** A trigger a foreign key makes is named for its oid, so it is named by function and constraint. */
function triggerName(obj: string, otherwise: string): string {
  return (
    "(SELECT CASE WHEN tg.tgisinternal AND tg.tgconstraint <> 0 THEN 'trigger ' || " +
    "tg.tgfoid::regproc::text || ' for ' || pg_describe_object('pg_constraint'::regclass, " +
    `tg.tgconstraint, 0) ELSE ${otherwise} END FROM pg_trigger tg WHERE tg.oid = (${obj})::oid)`
  );
}

/** An object as a drift line names it, never by its oid. */
function identity(cls: string, obj: string): string {
  const described = `pg_describe_object((${cls})::oid, (${obj})::oid, 0)`;
  return (
    `CASE WHEN (${cls})::oid = 'pg_trigger'::regclass::oid THEN ${triggerName(obj, described)} ` +
    `ELSE ${described} END`
  );
}

/** The cast that names an object of each catalog, cheaper than describing it. */
const CAST: Record<string, string> = {
  pg_class: 'regclass',
  pg_type: 'regtype',
  pg_proc: 'regprocedure',
  pg_namespace: 'regnamespace',
  pg_collation: 'regcollation',
  pg_operator: 'regoperator',
  pg_ts_config: 'regconfig',
  pg_ts_dict: 'regdictionary',
};

/**
 * An oid a row holds, by name where the object is this database's: `ALTER COLUMN ... TYPE` to its
 * own type rebuilds indexes and keys under new oids and changes nothing `pg_dump -s` prints.
 */
function reference(cls: { name: string } | { expr: string }, obj: string, sub = '0'): string {
  const named =
    'name' in cls
      ? cls.name === 'pg_trigger'
        ? triggerName(obj, `pg_describe_object('pg_trigger'::regclass, (${obj})::oid, 0)`)
        : CAST[cls.name]
          ? `(${obj})::oid::${CAST[cls.name]}::text`
          : `pg_describe_object('pg_catalog.${cls.name}'::regclass, (${obj})::oid, 0)`
      : `CASE (${cls.expr})::oid ${Object.entries(CAST)
          .map(([c, cast]) => `WHEN '${c}'::regclass::oid THEN (${obj})::oid::${cast}::text`)
          .join(' ')} WHEN 'pg_trigger'::regclass::oid THEN ${triggerName(obj, 'NULL')} ` +
        `ELSE pg_describe_object((${cls.expr})::oid, (${obj})::oid, 0) END || ':' || (${sub})`;
  return `CASE WHEN (${obj})::oid < ${FIRST_NORMAL_OID} THEN (${obj})::text ELSE ${named} END`;
}

/** A column of a catalog row as the digest reads it, an oid it holds named by `reference`. */
function columnText(catalog: Catalog, col: string): string {
  const any = NAMES_ANY[catalog.name]?.[col];
  if (any) return reference({ expr: `t."${any[0]}"` }, `t."${any[1]}"`, `t."${any[2]}"`);
  if (catalog.name === 'pg_trigger' && col === 'tgname') {
    return 'CASE WHEN t.tgisinternal AND t.tgconstraint <> 0 THEN NULL ELSE t.tgname END';
  }
  const ref = catalog.refs[col];
  if (!ref) return `t."${col}"`;
  if (!ref.array) return reference({ name: ref.pk }, `t."${col}"`);
  return (
    `(SELECT string_agg(${reference({ name: ref.pk }, 'u.o')}, ',' ORDER BY u.i) ` +
    `FROM unnest((t."${col}")::oid[]) WITH ORDINALITY u(o, i))`
  );
}

/** One select per catalog: the object each row belongs to, and the row as text. */
function catalogRows(catalog: Catalog): string {
  const { name, columns } = catalog;
  const owner = BELONGS_TO[name];
  const [label, cls, obj] = owner
    ? [owner.what, owner.cls, `t.${owner.obj}`]
    : columns.includes('oid')
      ? ['', `'pg_catalog.${name}'::regclass`, 't.oid']
      : [`catalog ${name}`, 'NULL', 'NULL'];
  // A row's own oid is the object the digest names it under; a built-in row is read as it stands.
  const own = columns.filter((col) => col !== 'oid');
  const named = `ROW(${own.map((col) => columnText(catalog, col)).join(', ')})::text`;
  const row =
    obj === 'NULL'
      ? named
      : `CASE WHEN (${obj})::oid < ${FIRST_NORMAL_OID} THEN ROW(${own.map((col) => `t."${col}"`).join(', ')})::text ELSE ${named} END`;
  const kept =
    cls === 'NULL'
      ? []
      : [
          `NOT ((${cls})::oid = 'pg_class'::regclass::oid AND (${obj})::oid IN (${TOAST_RELATIONS}))`,
        ];
  if (SESSION_ROWS[name]) kept.push(SESSION_ROWS[name]);
  const where = kept.length > 0 ? ` WHERE ${kept.join(' AND ')}` : '';
  return (
    `SELECT ${literal(name)} AS catalog, ${literal(label)} AS label, (${cls})::oid AS cls, ` +
    `(${obj})::oid AS obj, ${row} AS r FROM pg_catalog."${name}" t${where}`
  );
}

/** Every catalog row of the database `client` is on, with what is not in a catalog of its own. */
async function everyRow(client: Reader): Promise<string> {
  const rows = (await catalogs(client)).map(catalogRows);
  rows.push(
    TOAST_OPTIONS,
    "SELECT 'pg_database', 'this database''s grants and settings', NULL, NULL, " +
      "concat_ws(E'\\n', datacl::text, datconnlimit, datallowconn, (SELECT string_agg(" +
      "setrole::regrole::text || ' ' || setconfig::text, E'\\n' ORDER BY setrole) " +
      'FROM pg_db_role_setting WHERE setdatabase = d.oid)) ' +
      'FROM pg_database d WHERE datname = current_database()',
    "SELECT 'drizzle', 'migrations applied', NULL, NULL, count(*)::text FROM drizzle.__drizzle_migrations",
  );
  return rows.join('\nUNION ALL\n');
}

/** `read` with JIT off, which compiling the digest's expressions cost 437ms of a 611ms read. */
async function withoutJit<T>(client: Reader, read: (c: Reader) => Promise<T>): Promise<T> {
  if ('savepoint' in client) {
    const [was] = await client<{ jit: string }[]>`SELECT current_setting('jit') AS jit`;
    await client`SELECT set_config('jit', 'off', true)`;
    try {
      return await read(client);
    } finally {
      await client`SELECT set_config('jit', ${was?.jit ?? 'on'}, true)`;
    }
  }
  return (await client.begin(async (tx) => {
    await tx`SET LOCAL jit = off`;
    return read(tx);
  })) as T;
}

/**
 * One hash over every catalog row of the database `client` is on, so any kind of schema change
 * moves it; a table's rows do not, its migration count, settings and grants do. Rows are summed by
 * hash, so where Postgres keeps them does not move it.
 */
async function schemaHashOn(client: Reader): Promise<string> {
  const every = await everyRow(client);
  const [row] = await withoutJit(client, (c) =>
    c.unsafe<{ hash: string }[]>(`
    WITH r AS (${every})
    SELECT md5(string_agg(catalog || ' ' || label || ' ' || n || ' ' || s, E'\\n'
      ORDER BY catalog, label)) AS hash
    FROM (
      SELECT catalog, CASE WHEN cls IS NULL THEN label ELSE '' END AS label, count(*) AS n,
        sum(hashtextextended(r, 0)::numeric) AS s
      FROM r GROUP BY 1, 2
    ) x
  `),
  );
  return row?.hash ?? '';
}

/**
 * The rows `schemaHashOn` reads, by the object each belongs to, named as Postgres names it, so a
 * difference names what changed; objects `initdb` made are read one catalog at a time.
 */
async function schemaDigestOn(client: Reader): Promise<Record<string, string>> {
  const every = await everyRow(client);
  const rows = await withoutJit(client, (c) =>
    c.unsafe<{ object: string; digest: string }[]>(`
    WITH r AS (${every}),
    grouped AS (
      SELECT catalog, label, cls, CASE WHEN obj >= ${FIRST_NORMAL_OID} THEN obj END AS obj,
        md5(string_agg(r, E'\\n' ORDER BY r)) AS digest
      FROM r GROUP BY 1, 2, 3, 4
    ),
    named AS (
      SELECT CASE
        WHEN cls IS NULL THEN label
        WHEN obj IS NULL THEN 'built-in rows of ' || catalog
        ELSE label || coalesce(${identity('cls', 'obj')}, catalog || ' row ' || obj)
      END AS object, digest
      FROM grouped
    )
    SELECT object, left(md5(string_agg(digest, '' ORDER BY digest)), 12) AS digest
    FROM named GROUP BY object
  `),
  );
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
 * since naming the object says it; then the objects themselves, and what belongs to the others.
 */
export function describeDrift(drift: string[]): string {
  const said = new Set(drift);
  const weight = (line: string): number =>
    belongsPrefix(line.slice(line.indexOf(' ') + 1)) ? 1 : 0;
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
