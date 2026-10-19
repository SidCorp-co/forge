/**
 * The scan behind `single-door.test.ts` on raw SQL: a write that names the comments table by
 * interpolation or by joining text is red, and one whose table the scan cannot read is refused by
 * name, never passed because no string in it says `comments`.
 */

import { describe, expect, it } from 'vitest';
import { commentWrites } from './single-door.fixture.js';

const SCHEMA = [
  "export const issues = pgTable('issues', {});",
  "export const comments = pgTable('comments', {});",
].join('\n');

const DOORS = new Set(['comments/service.ts']);

/** Plants write `«x»` where the source holds `${x}`, so this file's own strings carry no placeholder. */
const plant = (text: string): string => text.replaceAll('«', '${').replaceAll('»', '}');

function writes(planted: string) {
  const source = plant(planted);
  const files = new Map<string, string>([
    ['db/schema.ts', SCHEMA],
    ['pipeline/planted.ts', source],
  ]);
  return commentWrites(files, DOORS);
}

const found = (source: string) => writes(source).map((w) => `${w.line} ${w.kind}`);

const IMPORT = "import { comments, issues } from '../db/schema.js';";

describe('raw SQL that names the comments table without writing its name', () => {
  it.each([
    ['an interpolated table', 'sql`insert into «comments» (body) values (1)`'],
    ['an interpolated table under another name', 'sql`delete from «c»`'],
    ['an interpolated table through a namespace', 'sql`update «s.comments» set body = 1`'],
    ['a table in a quoted, schema-qualified name', 'sql`delete from public.«comments»`'],
    [
      'a name joined from two strings',
      "sql.raw('insert into ' + 'comments' + ' (body) values (1)')",
    ],
    ['a name held by a constant', "sql.raw('delete from ' + TABLE)"],
    ['a template that joins a constant', 'sql.raw(`update «TABLE» set body = 1`)'],
    ['a verb and a name held by constants', 'sql.raw(`«VERB» «TABLE»`)'],
  ])('is red for %s', (_how, expr) => {
    const source = [
      IMPORT,
      "import { comments as c } from '../db/schema.js';",
      "import * as s from '../db/schema.js';",
      "const TABLE = 'comments';",
      "const VERB = 'delete from';",
      `export const go = (db: any) => db.execute(${expr});`,
    ].join('\n');
    const [first] = writes(source);
    expect(first?.line).toBe(6);
    expect(first?.kind).toBe('write');
  });

  it('is refused by name where the table is a part the scan cannot read', () => {
    const source = [
      IMPORT,
      'export const go = (db: any, table: unknown, name: string, run: () => string) => {',
      '  db.execute(sql`insert into «table» (body) values (1)`);',
      "  db.execute(sql.raw('delete from ' + name));",
      "  db.execute(sql.raw('update ' + run() + ' set body = 1'));",
      '};',
    ].join('\n');
    expect(found(source)).toEqual(['3 unresolved', '4 unresolved', '5 unresolved']);
    expect(writes(source)[0]?.how).toContain('a table the scan cannot read the name of');
  });

  it('is refused for an interpolated table that is not the comments table too, since it cannot tell', () => {
    const source = [
      IMPORT,
      'export const go = (db: any) => db.execute(sql`delete from «issues»`);',
    ].join('\n');
    expect(found(source)).toEqual(['2 unresolved']);
  });

  it('is quiet for a read, a write of a table named in text, and values interpolated after the table', () => {
    const source = [
      IMPORT,
      'export const go = (db: any, id: string, set: unknown) => {',
      '  db.execute(sql`select * from «comments» where id = «id»`);',
      '  db.execute(sql`update issues set title = «id» where id = «id»`);',
      '  db.execute(sql`delete from issues where id = «id»`);',
      '  db.execute(sql`insert into runner_releases (a) values («id»)`);',
      "  db.execute(sql.raw('select 1 from ' + 'comments'));",
      '  db.execute(sql`update runner_releases set «set» where id = «id»`);',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([]);
  });

  it('does not trust a `let` or `var` for the table it holds, which can change before it is used', () => {
    const source = [
      IMPORT,
      'export const go = (db: any) => {',
      "  let table = 'issues';",
      "  table = 'comments';",
      "  db.execute(sql.raw('delete from ' + table));",
      "  var other = 'issues';",
      "  db.execute(sql.raw('delete from ' + other));",
      '};',
    ].join('\n');
    expect(found(source)).toEqual(['5 unresolved', '7 unresolved']);
  });

  it('does not take a sentence that says "update" for a write', () => {
    const source = [
      IMPORT,
      'export const go = (name: string) => `we update «name» tomorrow, then insert «name» twice`;',
    ].join('\n');
    expect(found(source)).toEqual([]);
  });

  it('reads an update only where it is followed by SET after the table', () => {
    const source = [
      IMPORT,
      'export const go = (db: any, t: unknown) => db.execute(sql`update «t» set body = 1`);',
    ].join('\n');
    expect(found(source)).toEqual(['2 unresolved']);
  });
});

describe("raw SQL built with drizzle's join and append", () => {
  it.each([
    [
      'a query appended onto a verb, chained',
      ['db.execute(sql`insert into `.append(sql`«comments» (body) values (1)`));'],
      ['2 write'],
    ],
    [
      'a query appended onto a verb held by a constant',
      [
        'const q = sql`insert into `;',
        'q.append(sql`«comments» (body) values (1)`);',
        'db.execute(q);',
      ],
      ['2 unresolved', '3 write'],
    ],
    [
      'a verb in sql.raw joined to the table',
      [
        "db.execute(sql.join([sql.raw('insert into'), comments, sql.raw('(body) values (1)')], sql.raw(' ')));",
      ],
      ['2 write'],
    ],
    [
      'a verb and the table as two sql parts, joined with no separator',
      ['db.execute(sql.join([sql`DELETE FROM`, sql`«comments»`]));'],
      ['2 write'],
    ],
    [
      'a verb and the table joined by an empty separator',
      ['db.execute(sql.join([sql`DELETE FROM`, sql`«comments»`], sql``));'],
      ['2 write'],
    ],
    [
      'the verb split into words, joined',
      ["db.execute(sql.join([sql.raw('insert'), sql.raw('into'), c], sql.raw(' ')));"],
      ['2 write'],
    ],
    [
      'an update whose table is joined between the verb and its set',
      ['db.execute(sql.join([sql`update`, s.comments, sql`set body = 1`], sql` `));'],
      ['2 write'],
    ],
    [
      'parts held by a constant array',
      [
        "const parts = [sql.raw('delete from'), comments];",
        "db.execute(sql.join(parts, sql.raw(' ')));",
      ],
      ['2 unresolved', '3 write'],
    ],
    [
      'a verb appended onto a query the scan cannot read, the table appended after it',
      [
        'const q = sql.empty();',
        'q.append(sql`delete from `);',
        'q.append(sql`«comments»`);',
        'db.execute(q);',
      ],
      ['3 unresolved'],
    ],
  ])("reads through drizzle's join and append: %s", (_how, lines, expected) => {
    const source = [
      [
        IMPORT,
        "import { comments as c } from '../db/schema.js';",
        "import * as s from '../db/schema.js';",
      ].join(' '),
      ...lines,
    ].join('\n');
    expect(found(source)).toEqual(expected);
  });

  it('names a verb whose table is out of its sight, saying where it went', () => {
    const source = [IMPORT, "db.execute(sql.join([sql.raw('delete from'), table()]));"].join('\n');
    expect(found(source)).toEqual(['2 unresolved']);
    const source2 = [IMPORT, 'const q = sql`insert into `;', 'more(q);'].join('\n');
    expect(writes(source2).map((w) => w.how)).toEqual([
      expect.stringContaining(
        "a write verb whose table is joined or appended out of the scan's sight",
      ),
    ]);
  });

  it('is quiet for a join of columns, a form append and an array join that write nothing', () => {
    const source = [
      IMPORT,
      'export const go = (db: any, cols: string[], form: any, id: string) => {',
      '  db.execute(sql`update runner_releases set «sql.join(cols.map((c) => sql`«c» = 1`), sql`, `)» where id = «id»`);',
      "  form.append('update', id);",
      "  const words = ['insert', 'delete'].join(', ');",
      '  db.execute(sql.join([sql`select 1 from`, comments], sql` `));',
      '  return words;',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([]);
  });
});
