/**
 * The scan behind `single-door.test.ts` on what is not a name: a table handed to a helper that
 * writes it, a namespace re-exported or renamed, a table held in an object or returned by a
 * function. Each is red where the table is the comments table and, where the scan cannot tell what
 * table it is, refused by name instead of passed.
 */

import { describe, expect, it } from 'vitest';
import { commentWrites } from './single-door.fixture.js';

const SCHEMA = [
  "export const issues = pgTable('issues', {});",
  "export const comments = pgTable('comments', {});",
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

const found = (source: string, extra?: Record<string, string>) =>
  writesIn(source, extra).map((w) => `${w.file}:${w.line} ${w.kind}`);

describe('a table handed to a helper that writes whatever it is given', () => {
  const HELPER = [
    'export function writeTo<T>(table: T) {',
    '  return db.insert(table).values({});',
    '}',
  ].join('\n');

  it('names the call that hands the comments table to a generic helper', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'function writeTo<T>(table: T) {',
      '  return db.insert(table).values({});',
      '}',
      'writeTo(comments);',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:5 write']);
  });

  it('follows an arrow helper, a helper in another module and one reached through a namespace', () => {
    const extra = { 'pipeline/helper.ts': HELPER };
    const source = [
      "import { comments } from '../db/schema.js';",
      "import { writeTo as put } from './helper.js';",
      "import * as helpers from './helper.js';",
      'const arrow = async (t: unknown) => await db.delete(t);',
      'put(comments);',
      'helpers.writeTo(comments);',
      'arrow(comments);',
    ].join('\n');
    expect(found(source, extra)).toEqual([
      'pipeline/planted.ts:5 write',
      'pipeline/planted.ts:6 write',
      'pipeline/planted.ts:7 write',
    ]);
  });

  it('follows a helper that only hands its parameter on to another helper', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'const inner = (t: unknown) => db.insert(t).values({});',
      'const outer = (t: unknown, n: number) => inner(t);',
      'outer(comments, 1);',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:4 write']);
  });

  it('follows the table into the second parameter and ignores the first', () => {
    const source = [
      "import { comments, issues } from '../db/schema.js';",
      'const into = (note: string, t: unknown) => db.insert(t).values({ note });',
      "into('x', issues);",
      "into('x', comments);",
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:4 write']);
  });

  it('leaves a helper given another table alone', () => {
    const source = [
      "import { issues } from '../db/schema.js';",
      'function writeTo<T>(table: T) {',
      '  return db.insert(table).values({});',
      '}',
      'writeTo(issues);',
    ].join('\n');
    expect(found(source)).toEqual([]);
  });

  it('leaves a keyed helper alone, a string parameter not being a table', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'const seen = new Map<string, number>();',
      'const forget = (key: string) => seen.delete(key);',
      "forget('comments');",
      'export const n = comments;',
    ].join('\n');
    expect(found(source)).toEqual([]);
  });

  it('refuses a helper used as a value, where what it is given is out of sight', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'function writeTo<T>(table: T) {',
      '  return db.insert(table).values({});',
      '}',
      '[comments].forEach(writeTo);',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:5 unresolved']);
    expect(writesIn(source)[0]?.how).toContain('`writeTo` hands a table to a write');
  });

  it('refuses a helper whose table argument is spread', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'function writeTo<T>(table: T) {',
      '  return db.insert(table).values({});',
      '}',
      'writeTo(...[comments]);',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:5 unresolved']);
  });

  it('refuses a write whose table is a parameter of a method, which no caller is traced into', () => {
    const source = [
      'export class Writer {',
      '  write(table: unknown) {',
      '    return db.insert(table).values({});',
      '  }',
      '}',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:3 unresolved']);
    expect(writesIn(source)[0]?.how).toContain('a parameter of a function the scan cannot follow');
  });

  it('refuses a write whose table is a parameter of a callback or a destructured parameter', () => {
    const source = [
      'export const a = (tables: unknown[]) => tables.map((t) => db.delete(t).where());',
      'export const b = async ({ table }: { table: unknown }) => { await db.insert(table); };',
    ].join('\n');
    expect(found(source)).toEqual([
      'pipeline/planted.ts:1 unresolved',
      'pipeline/planted.ts:2 unresolved',
    ]);
  });
});

describe('a namespace that is re-exported or bound to another name', () => {
  const barrel = (text: string) => ({ 'pipeline/barrel.ts': text });
  const use = [
    "import { dbSchema } from './barrel.js';",
    'export const go = (db: any) => db.insert(dbSchema.comments).values({});',
  ].join('\n');

  it('finds the table through `export { s as name }` of a namespace import', () => {
    const extra = barrel("import * as s from '../db/schema.js';\nexport { s as dbSchema };");
    expect(found(use, extra)).toEqual(['pipeline/planted.ts:2 write']);
  });

  it('finds the table through `export * as name from`', () => {
    const extra = barrel("export * as dbSchema from '../db/schema.js';");
    expect(found(use, extra)).toEqual(['pipeline/planted.ts:2 write']);
  });

  it('finds the table through an exported constant holding the namespace', () => {
    const extra = barrel("import * as s from '../db/schema.js';\nexport const dbSchema = s;");
    expect(found(use, extra)).toEqual(['pipeline/planted.ts:2 write']);
  });

  it('finds the table through a namespace that is a member of another namespace', () => {
    const extra = barrel("export * as dbSchema from '../db/schema.js';");
    const source = [
      "import * as barrel from './barrel.js';",
      'export const go = (db: any) => db.delete(barrel.dbSchema.comments);',
    ].join('\n');
    expect(found(source, extra)).toEqual(['pipeline/planted.ts:2 write']);
  });

  it('finds the table through a default export of the namespace and a renamed re-export of it', () => {
    const extra = {
      'pipeline/barrel.ts': "import * as s from '../db/schema.js';\nexport default s;",
      'pipeline/again.ts': "export { default as dbSchema } from './barrel.js';",
    };
    const source = [
      "import { dbSchema } from './again.js';",
      'export const go = (db: any) => db.insert(dbSchema.comments);',
    ].join('\n');
    expect(found(source, extra)).toEqual(['pipeline/planted.ts:2 write']);
  });

  it('leaves another member of the same namespace alone', () => {
    const extra = barrel("export * as dbSchema from '../db/schema.js';");
    const source = [
      "import { dbSchema } from './barrel.js';",
      'export const go = (db: any) => db.insert(dbSchema.issues).values({});',
    ].join('\n');
    expect(found(source, extra)).toEqual([]);
  });
});

describe('a table the scan reaches through a shape other than a name', () => {
  it('finds the table in an object or an array that holds it, however it is read back', () => {
    const source = [
      "import { comments, issues } from '../db/schema.js';",
      'const registry = { notes: comments, work: issues };',
      'const list = [issues, comments];',
      'export const go = async (db: any) => {',
      '  await db.insert(registry.notes);',
      '  for (const t of list) await db.delete(t);',
      '  const [first] = [comments];',
      '  await db.update(first).set({});',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([
      'pipeline/planted.ts:5 write',
      'pipeline/planted.ts:6 write',
      'pipeline/planted.ts:8 write',
    ]);
  });

  it('finds the table a function returns, and one picked by a key only known when it runs', () => {
    const source = [
      "import * as s from '../db/schema.js';",
      "import { comments } from '../db/schema.js';",
      'function tableFor(kind: string) {',
      "  return kind === 'c' ? comments : s.issues;",
      '}',
      'export const go = async (db: any, kind: string) => {',
      '  await db.insert(tableFor(kind));',
      '  await db.delete(s[kind]);',
      '};',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:7 write', 'pipeline/planted.ts:8 write']);
  });

  it('finds the table written through a method picked by a key', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      "export const go = (db: any, op: 'insert' | 'delete') => db[op](comments);",
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:2 write']);
  });

  it('refuses a table that is a member of `this`, which no call is traced into', () => {
    const source = [
      'export class Store {',
      '  table: unknown;',
      '  async drop() {',
      '    await this.db.delete(this.table).where();',
      '  }',
      '}',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:4 unresolved']);
    expect(writesIn(source)[0]?.how).toContain('`this`');
  });

  it('refuses a table that is the result of a call it cannot enter', () => {
    const source = [
      "import { pickTable } from 'some-package';",
      'export const go = async (db: any, k: string) => {',
      '  await db.delete(pickTable(k)).where();',
      '};',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:3 unresolved']);
  });

  it('refuses a write method taken as a value, where the table it is given is out of sight', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'export const go = (db: any) => db.insert.bind(db)(comments);',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:2 unresolved']);
  });

  it('leaves a keyed delete, a hash update and a stored path alone, none being drizzle-shaped', () => {
    const source = [
      "import { createHash } from 'node:crypto';",
      "import { comments } from '../db/schema.js';",
      'const seen = new Map<string, number>();',
      'export const go = async (storage: any, row: { path: string }, key: string, t: unknown) => {',
      '  seen.delete(key);',
      "  createHash('sha256').update(key).digest('hex');",
      '  await storage.delete(row.path);',
      '  seen.delete(t as string);',
      '  return comments;',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([]);
  });
});

describe('a member of a parameter handed to a write', () => {
  it('passes one the parameter type declares a string, in a literal type or a named one', () => {
    const source = [
      'interface Row { path: string; meta: { key: string | number } }',
      'type Opts = { name: string };',
      'export const go = async (storage: any, row: Row, o: Opts, lit: { id: string }) => {',
      '  await storage.delete(row.path);',
      '  await storage.delete(row.meta.key);',
      '  await storage.delete(o.name);',
      '  await storage.delete(lit.id);',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([]);
  });

  it('refuses one the parameter type does not declare a string, which may be the table itself', () => {
    const source = [
      'interface Row { path: string; table: unknown }',
      'export const go = async (db: any, row: Row, other: Elsewhere) => {',
      '  await db.delete(row.table).where();',
      '  await db.delete(other.path).where();',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([
      'pipeline/planted.ts:3 unresolved',
      'pipeline/planted.ts:4 unresolved',
    ]);
  });
});
