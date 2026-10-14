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
