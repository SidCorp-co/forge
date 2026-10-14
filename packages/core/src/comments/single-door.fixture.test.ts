/**
 * The scan behind `single-door.test.ts`, shown red on each way a source can name the comments table
 * and quiet on the ones that merely say it. Every plant is a source in memory, so a form the scan
 * cannot see is a case here, not a file somebody has to remember to write and delete.
 */

import { describe, expect, it } from 'vitest';
import { commentWrites } from './single-door.fixture.js';

const SCHEMA = [
  "export const issues = pgTable('issues', {});",
  'export const comments = pgTable(',
  "  'comments',",
  '  {},',
  ');',
].join('\n');

const DOORS = new Set(['comments/service.ts']);

function writesIn(source: string, extra: Record<string, string> = {}) {
  const files = new Map<string, string>([
    ['db/schema.ts', SCHEMA],
    ['db/index.ts', "export * from './schema.js';"],
    ['pipeline/planted.ts', source],
    ...Object.entries(extra),
  ]);
  return commentWrites(files, DOORS);
}

const where = (source: string, extra?: Record<string, string>) =>
  writesIn(source, extra).map((w) => `${w.file}:${w.line}`);

describe('a write of the comments table the scan names by file and line', () => {
  it('finds the plain named import', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'export const go = (db: any) =>',
      '  db',
      '    .insert(comments)',
      '    .values({});',
    ].join('\n');
    expect(where(source)).toEqual(['pipeline/planted.ts:4']);
  });

  it('finds a namespace import written as s.comments', () => {
    const source = [
      "import * as s from '../db/schema.js';",
      'export const go = (db: any) => db.insert(s.comments).values({});',
    ].join('\n');
    expect(where(source)).toEqual(['pipeline/planted.ts:2']);
  });

  it('finds an aliased named import', () => {
    const source = [
      "import { comments as c } from '../db/schema.js';",
      'export const go = (db: any) => db.insert(c).values({});',
    ].join('\n');
    expect(where(source)).toEqual(['pipeline/planted.ts:2']);
  });

  it('finds update and delete as it finds insert', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'export const go = async (db: any) => {',
      '  await db.update(comments).set({});',
      '  await db.delete(comments);',
      '};',
    ].join('\n');
    expect(where(source)).toEqual(['pipeline/planted.ts:3', 'pipeline/planted.ts:4']);
  });

  it('finds the table through a local alias, an element access and a destructured namespace', () => {
    const source = [
      "import * as schema from '../db/schema.js';",
      'const t = schema.comments;',
      'const { comments: c2 } = schema;',
      'export const go = async (db: any) => {',
      '  await db.insert(t);',
      '  await db.insert(c2);',
      "  await db.insert(schema['comments']);",
      '};',
    ].join('\n');
    expect(where(source)).toEqual([
      'pipeline/planted.ts:5',
      'pipeline/planted.ts:6',
      'pipeline/planted.ts:7',
    ]);
  });

  it('finds the table through a dynamic import', () => {
    const source = [
      'export const go = async (db: any) => {',
      "  const { comments: c } = await import('../db/schema.js');",
      "  const s = await import('../db/schema.js');",
      '  await db.insert(c);',
      '  await db.delete(s.comments);',
      '};',
    ].join('\n');
    expect(where(source)).toEqual(['pipeline/planted.ts:4', 'pipeline/planted.ts:5']);
  });

  it('finds the table through a module that only re-exports it', () => {
    const source = [
      "import { comments as c } from '../db/index.js';",
      'export const go = (db: any) => db.insert(c);',
    ].join('\n');
    expect(where(source)).toEqual(['pipeline/planted.ts:2']);
  });

  it('finds the table through a re-export under another name', () => {
    const extra = { 'db/tables.ts': "export { comments as notes } from './schema.js';" };
    const source = [
      "import { notes } from '../db/tables.js';",
      'export const go = (db: any) => db.insert(notes);',
    ].join('\n');
    expect(where(source, extra)).toEqual(['pipeline/planted.ts:2']);
  });

  it('finds a raw SQL write of the table, on the line it starts', () => {
    const source = [
      'export const go = (db: any, sql: any) => {',
      '  return db.execute(sql`',
      '    DELETE FROM comments WHERE id = ${1}`);',
      '};',
    ].join('\n');
    expect(where(source)).toEqual(['pipeline/planted.ts:2']);
  });

  it('says which call it found', () => {
    const source = [
      "import { comments as c } from '../db/schema.js';",
      'export const go = (db: any) => db.delete(c);',
    ].join('\n');
    expect(writesIn(source)[0]?.how).toBe('.delete(c)');
  });
});

describe('what only looks like a write of the comments table', () => {
  it('leaves a comment, a string and a quoted example alone', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      '// await db.insert(comments).values({});',
      '/* db.update(comments) */',
      "export const note = 'call db.insert(comments) through the door';",
    ].join('\n');
    expect(where(source)).toEqual([]);
  });

  it('leaves a read of the table and a write of another table alone', () => {
    const source = [
      "import { comments, issues } from '../db/schema.js';",
      'export const go = async (db: any) => {',
      '  await db.select().from(comments);',
      '  await db.insert(issues).values({});',
      '  return db.query.comments.findMany();',
      '};',
    ].join('\n');
    expect(where(source)).toEqual([]);
  });

  it('leaves a name that is not the schema table alone, even where it is called comments', () => {
    const source = [
      "import { comments } from './local-comments.js';",
      'const other = { insert: (_x: unknown) => 1 };',
      'export const a = other.insert(comments);',
      'export const go = (db: any) => {',
      '  const comments = [1];',
      '  return db.insert(comments);',
      '};',
    ].join('\n');
    expect(where(source, { 'pipeline/local-comments.ts': 'export const comments = {};' })).toEqual(
      [],
    );
  });

  it('leaves the two doors alone and a write beside them in another file red', () => {
    const files = new Map([
      ['db/schema.ts', SCHEMA],
      ['comments/service.ts', "import { comments } from '../db/schema.js';\ndb.insert(comments);"],
      ['comments/other.ts', "import { comments } from '../db/schema.js';\ndb.insert(comments);"],
    ]);
    expect(commentWrites(files, DOORS).map((w) => `${w.file}:${w.line}`)).toEqual([
      'comments/other.ts:2',
    ]);
  });

  it('finds nothing when no module declares the comments table, rather than guessing a name', () => {
    const files = new Map([
      ['db/schema.ts', "export const issues = pgTable('issues', {});"],
      ['pipeline/planted.ts', "import { comments } from '../db/schema.js';\ndb.insert(comments);"],
    ]);
    expect(commentWrites(files, DOORS)).toEqual([]);
  });
});
