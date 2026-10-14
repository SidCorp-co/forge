/**
 * Two doors write the `comments` table and nothing else does: `service.ts` for a caller's write,
 * which refuses a stored test credential, and `system-write.ts` for core's own writers, which
 * withhold it. A third writer is a path on which text reaches an issue unchecked, which is how a
 * run-close reason carrying a stored credential was posted whole (ISS-1389).
 *
 * The scan reads each source's syntax tree and follows the table through aliases, namespaces
 * (re-exported or renamed), re-exports and helpers that write what they are handed
 * (`single-door.fixture.ts`), so `db.insert(s.comments)` is a write and a comment that says
 * `insert(comments)` is not. A write it cannot trace to a table is refused by name, never passed.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { type CommentWrite, commentWrites } from './single-door.fixture.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const DOORS = new Set(['comments/service.ts', 'comments/system-write.ts']);

function sources(dir: string, out: Map<string, string> = new Map()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.ts$/.test(entry.name) && !/\.(?:test|fixture)\.ts$/.test(entry.name)) {
      out.set(relative(SRC, path).split(sep).join('/'), readFileSync(path, 'utf8'));
    }
  }
  return out;
}

const named = (writes: readonly CommentWrite[]): string[] =>
  writes.map((w) => `${w.file}:${w.line} ${w.how}`);

/** One way a source can write the table, each planted in a module of its own under `zz/`. */
interface Plant {
  form: string;
  /** The module, under `zz/`, that the plant imports and the real tree does not have. */
  barrel?: string;
  /** The plant's source, at `zz/plant-<n>.ts`, its imports reading `./barrel.js` where there is one. */
  plant: string;
  /** The line of the plant, counting from one, that the scan names. */
  at: number;
}

const PLANTS: Plant[] = [
  {
    form: 'the literal table',
    plant: "import { comments } from '../db/schema.js';\ndb.insert(comments);",
    at: 2,
  },
  {
    form: 'a namespace import',
    plant: "import * as s from '../db/schema.js';\ndb.insert(s.comments);",
    at: 2,
  },
  {
    form: 'an aliased import',
    plant: "import { comments as c } from '../db/schema.js';\ndb.update(c).set({});",
    at: 2,
  },
  {
    form: 'a table passed to a generic helper that writes it',
    plant: [
      "import { comments } from '../db/schema.js';",
      'function writeTo<T>(table: T) {',
      '  return db.insert(table).values({});',
      '}',
      'writeTo(comments);',
    ].join('\n'),
    at: 5,
  },
  {
    form: 'a namespace re-exported under another name',
    barrel: "import * as s from '../db/schema.js';\nexport { s as dbSchema };",
    plant: "import { dbSchema } from './barrel.js';\ndb.delete(dbSchema.comments);",
    at: 2,
  },
  {
    form: 'a namespace re-exported by `export * as`',
    barrel: "export * as dbSchema from '../db/schema.js';",
    plant: "import * as barrel from './barrel.js';\ndb.delete(barrel.dbSchema.comments);",
    at: 2,
  },
  {
    form: 'a helper that takes the table by default',
    plant: [
      "import { comments } from '../db/schema.js';",
      'function writeTo(table: unknown = comments) {',
      '  return db.insert(table).values({});',
      '}',
    ].join('\n'),
    at: 3,
  },
  {
    form: 'a table stored into an object after it is written',
    plant: [
      "import { comments } from '../db/schema.js';",
      'const box: { table?: unknown } = {};',
      'box.table = comments;',
      'await db.delete(box.table);',
    ].join('\n'),
    at: 4,
  },
  {
    form: 'a table returned by a method and kept in a variable',
    plant: [
      "import { comments } from '../db/schema.js';",
      'const registry = { pick: () => comments };',
      'const t = registry.pick();',
      'await db.delete(t);',
    ].join('\n'),
    at: 4,
  },
  {
    form: 'raw SQL that interpolates the table',
    plant: [
      "import { comments } from '../db/schema.js';",
      'db.execute(sql`delete from $' + '{comments}`);',
    ].join('\n'),
    at: 2,
  },
  {
    form: 'raw SQL whose table name is joined from two strings',
    plant: "db.execute(sql.raw('delete from ' + 'comments'));",
    at: 1,
  },
  {
    form: 'raw SQL appended onto a write verb',
    plant: [
      "import { comments } from '../db/schema.js';",
      'db.execute(sql`insert into `.append(sql`$' + '{comments} (body) values (1)`));',
    ].join('\n'),
    at: 2,
  },
  {
    form: 'raw SQL joined from a verb in sql.raw and the table',
    plant: [
      "import { comments } from '../db/schema.js';",
      "db.execute(sql.join([sql.raw('insert into'), comments], sql.raw(' ')));",
    ].join('\n'),
    at: 2,
  },
  {
    form: 'raw SQL joined from a verb and the table as two sql parts',
    plant: [
      "import { comments } from '../db/schema.js';",
      'db.execute(sql.join([sql`DELETE FROM`, sql`$' + '{comments}`]));',
    ].join('\n'),
    at: 2,
  },
  {
    form: 'a table held by an exported constant that is a namespace',
    barrel: "import * as s from '../db/schema.js';\nexport const dbSchema = s;",
    plant: "import { dbSchema } from './barrel.js';\ndb.insert(dbSchema['comments']);",
    at: 2,
  },
];

describe('who writes the comments table', () => {
  const real = sources(SRC);
  const pmOriginal = real.get('pm/routes.ts') as string;
  let clean: CommentWrite[] = [];
  let found: CommentWrite[] = [];

  // Two scans of the whole tree, one as it is and one with every plant in it, so each case below
  // reads its own finding out of the second instead of paying for a scan of its own.
  beforeAll(() => {
    const planted = new Map(real);
    PLANTS.forEach((p, n) => {
      planted.set(`zz/plant-${n}.ts`, p.plant.replaceAll('./barrel.js', `./barrel-${n}.js`));
      if (p.barrel) planted.set(`zz/barrel-${n}.ts`, p.barrel);
    });
    planted.set(
      'pm/routes.ts',
      `${pmOriginal}\nimport { comments as c } from '../db/schema.js';\nawait db.insert(c).values({});\n`,
    );
    clean = commentWrites(real, DOORS);
    found = commentWrites(planted, DOORS);
  }, 120_000);

  it('is the two doors, and a writer outside them fails naming its file and line', () => {
    expect(
      named(clean),
      'post through postSystemComment, insertSystemComment or deleteSystemComment (core writing) or insertComment (a caller writing): a direct write skips the stored-credential check. A line saying the scan cannot follow a table is a shape to write plainly: name the table where it is written',
    ).toEqual([]);
  });

  it.each(PLANTS.map((p, n) => ({ ...p, n })))(
    'goes red on $form planted in a source, naming its file and line',
    ({ n, at }) => {
      const here = found.filter((w) => w.file === `zz/plant-${n}.ts`);
      expect(here.map((w) => `${w.file}:${w.line} ${w.kind}`)).toEqual([
        `zz/plant-${n}.ts:${at} write`,
      ]);
    },
  );

  it('keeps a write planted in pm/routes.ts failing, there being no amnesty for the file', () => {
    const line = pmOriginal.split('\n').length + 2;
    expect(found.filter((w) => w.file === 'pm/routes.ts').map((w) => w.line)).toEqual([line]);
  });

  it('names nothing else, so each finding above is its own plant and the real schema was followed', () => {
    expect(found.length).toBe(PLANTS.length + 1);
  });
});
