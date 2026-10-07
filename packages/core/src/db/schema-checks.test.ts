import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTBOX_EVENT_TYPES } from '@forge/contracts/outbox-events';
import { is, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', '..', 'drizzle', 'migrations');
// The modules `drizzle.config.ts` reads as the schema: every `src/db/schema*.ts`.
const schemaModules: Record<string, unknown>[] = await Promise.all(
  readdirSync(__dirname)
    .filter((f) => /^schema.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
    .map((f) => import(join(__dirname, f)) as Promise<Record<string, unknown>>),
);

/** Every single-quoted literal in a CHECK body: the vocabulary it admits, in either rendering. */
function literalsOf(body: string): Set<string> {
  return new Set([...body.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1] as string));
}

/** The body of the parenthesis opening at `open`, quotes respected, or null if it never closes. */
function parenBody(text: string, open: number): string | null {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

const NAME = '"?([A-Za-z0-9_]+)"?';
const STATEMENTS = new RegExp(
  [
    `CONSTRAINT\\s+${NAME}\\s+CHECK\\s*\\(`,
    `DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?${NAME}`,
    `RENAME\\s+CONSTRAINT\\s+${NAME}\\s+TO\\s+${NAME}`,
  ].join('|'),
  'gi',
);

/**
 * Replays every migration in journal order and keeps, per CHECK name, the body the last statement
 * to touch it left: an ADD defines it, a DROP removes it, a RENAME moves it. A CHECK built inside a
 * DO block's EXECUTE string is invisible here, and the test then names it as defined by no
 * migration rather than passing it.
 */
function checksInMigrations(
  migrations: { tag: string; sql: string }[],
): Map<string, { tag: string; sql: string }> {
  const live = new Map<string, { tag: string; sql: string }>();
  for (const { tag, sql } of migrations) {
    const text = sql.replace(/--[^\n]*/g, '');
    for (const m of text.matchAll(STATEMENTS)) {
      const [, defined, dropped, from, to] = m;
      if (defined !== undefined) {
        const body = parenBody(text, (m.index ?? 0) + m[0].length - 1);
        if (body === null)
          throw new Error(`${tag}: CHECK ${defined} opens a parenthesis it never closes`);
        live.set(defined, { tag, sql: body });
      } else if (dropped !== undefined) {
        live.delete(dropped);
      } else if (from !== undefined && to !== undefined) {
        const was = live.get(from);
        live.delete(from);
        if (was !== undefined) live.set(to, was);
      }
    }
  }
  return live;
}

function migrationSources(): { tag: string; sql: string }[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => ({ tag: e.tag, sql: readFileSync(join(MIGRATIONS, `${e.tag}.sql`), 'utf8') }));
}

function declaredChecks(): { table: string; name: string; sql: string }[] {
  const dialect = new PgDialect();
  const out = new Map<string, { table: string; name: string; sql: string }>();
  for (const mod of schemaModules) {
    for (const value of Object.values(mod)) {
      if (value === null || typeof value !== 'object' || !is(value, PgTable)) continue;
      const config = getTableConfig(value);
      for (const check of config.checks) {
        const value_ = check.value as unknown;
        if (!is(value_, SQL)) continue;
        out.set(`${config.name}.${check.name}`, {
          table: config.name,
          name: check.name,
          sql: dialect.sqlToQuery(value_).sql,
        });
      }
    }
  }
  return [...out.values()];
}

describe('replaying the migrations leaves the CHECK the last statement to touch it wrote', () => {
  const m = (tag: string, sql: string) => ({ tag, sql });

  it('a later ADD replaces an earlier one, and a DROP then ADD leaves the ADD', () => {
    const live = checksInMigrations([
      m('a', `CREATE TABLE "t" ("k" text, CONSTRAINT "t_k_chk" CHECK ("k" IN ('x')));`),
      m(
        'b',
        `ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "t_k_chk";--> statement-breakpoint\nALTER TABLE "t" ADD CONSTRAINT "t_k_chk" CHECK ("k" IN ('x', 'y'));`,
      ),
    ]);
    expect(live.get('t_k_chk')).toEqual({ tag: 'b', sql: `"k" IN ('x', 'y')` });
  });

  it('a DROP with no later ADD leaves no CHECK, and a RENAME moves the body to the new name', () => {
    const live = checksInMigrations([
      m(
        'a',
        `ALTER TABLE "t" ADD CONSTRAINT "gone" CHECK (a > 0);\nALTER TABLE "t" ADD CONSTRAINT old_name CHECK ((b) IN ('p'));`,
      ),
      m(
        'b',
        `ALTER TABLE "t" DROP CONSTRAINT "gone";\nALTER TABLE "t" RENAME CONSTRAINT "old_name" TO "new_name";`,
      ),
    ]);
    expect(live.has('gone')).toBe(false);
    expect(live.has('old_name')).toBe(false);
    expect(live.get('new_name')).toEqual({ tag: 'a', sql: `(b) IN ('p')` });
  });

  it('a commented-out statement is not replayed, and a parenthesis inside a literal does not close the body', () => {
    const live = checksInMigrations([
      m(
        'a',
        `-- ALTER TABLE "t" ADD CONSTRAINT "c" CHECK (false);\nALTER TABLE "t" ADD CONSTRAINT "c" CHECK (v ~ '^(a|b)$');`,
      ),
    ]);
    expect(live.get('c')?.sql).toBe(`v ~ '^(a|b)$'`);
  });

  it('a CHECK whose parenthesis never closes is refused naming its migration', () => {
    expect(() =>
      checksInMigrations([m('0999_x', `ADD CONSTRAINT "c" CHECK ("k" IN ('a')`)]),
    ).toThrow(/0999_x: CHECK c opens a parenthesis it never closes/);
  });
});

const EVENT_TYPE_WRITES =
  /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE|TRUNCATE(?:\s+TABLE)?)\s+"?outbox_event_types"?([^;]*);/gi;

/**
 * Replays every migration's writes to `outbox_event_types` in journal order: an INSERT adds each
 * literal it names, a DELETE removes each. Any other write to the table is refused naming its
 * migration, since what it leaves cannot be read from the text.
 */
function eventTypesInMigrations(migrations: { tag: string; sql: string }[]): Set<string> {
  const held = new Set<string>();
  for (const { tag, sql } of migrations) {
    const text = sql.replace(/--[^\n]*/g, '');
    for (const [, verb = '', rest = ''] of text.matchAll(EVENT_TYPE_WRITES)) {
      const literals = literalsOf(rest);
      if (/^INSERT/i.test(verb)) for (const l of literals) held.add(l);
      else if (/^DELETE/i.test(verb) && literals.size > 0) for (const l of literals) held.delete(l);
      else throw new Error(`${tag}: a ${verb} on outbox_event_types this replay cannot read`);
    }
  }
  return held;
}

describe('the outbox event types the migrations seed are the registry', () => {
  const m = (tag: string, sql: string) => ({ tag, sql });

  it('an INSERT adds its literals and a later DELETE removes them', () => {
    const held = eventTypesInMigrations([
      m(
        'a',
        `INSERT INTO "outbox_event_types" ("type") VALUES ('x.a'), ('x.b') ON CONFLICT DO NOTHING;`,
      ),
      m('b', `DELETE FROM "outbox_event_types" WHERE "type" IN ('x.a');`),
      m('c', `-- INSERT INTO "outbox_event_types" ("type") VALUES ('x.c');`),
    ]);
    expect([...held]).toEqual(['x.b']);
  });

  it('a write the replay cannot read is refused naming its migration', () => {
    expect(() =>
      eventTypesInMigrations([m('0999_x', `UPDATE outbox_event_types SET type = 'y';`)]),
    ).toThrow(/0999_x: a UPDATE on outbox_event_types/);
  });

  it('every type OUTBOX_EVENT_TYPES emits is seeded, and nothing else is', () => {
    const held = eventTypesInMigrations(migrationSources());
    const unseeded = OUTBOX_EVENT_TYPES.filter((t) => !held.has(t));
    const stray = [...held].filter((t) => !(OUTBOX_EVENT_TYPES as readonly string[]).includes(t));
    expect({ unseeded, stray }).toEqual({ unseeded: [], stray: [] });
  });

  it('the outbox type CHECK the table replaced is dropped and declared nowhere', () => {
    expect(checksInMigrations(migrationSources()).has('pipeline_outbox_type_chk')).toBe(false);
    expect(declaredChecks().map((c) => c.name)).not.toContain('pipeline_outbox_type_chk');
  });
});

describe('every CHECK the schema derives from a vocabulary is the CHECK the migrations leave', () => {
  const effective = checksInMigrations(migrationSources());
  const declared = declaredChecks();

  it('reads CHECKs from both sides, so an empty read cannot pass', () => {
    expect(declared.length).toBeGreaterThan(0);
    expect(effective.size).toBeGreaterThan(0);
  });

  it('the drizzle schema and the last migration to define each CHECK hold the same literals', () => {
    const drift: string[] = [];
    for (const { table, name, sql } of declared) {
      const migrated = effective.get(name);
      if (migrated === undefined) {
        drift.push(`${table}.${name}: declared in the schema, defined by no migration`);
        continue;
      }
      const want = literalsOf(sql);
      const have = literalsOf(migrated.sql);
      const missing = [...want].filter((l) => !have.has(l));
      const extra = [...have].filter((l) => !want.has(l));
      if (missing.length > 0 || extra.length > 0) {
        drift.push(
          `${table}.${name} (last defined by ${migrated.tag}): ` +
            (missing.length ? `the migrations refuse ${missing.join(', ')}` : '') +
            (missing.length && extra.length ? '; ' : '') +
            (extra.length ? `the schema no longer holds ${extra.join(', ')}` : ''),
        );
      }
    }
    expect(drift).toEqual([]);
  });
});
