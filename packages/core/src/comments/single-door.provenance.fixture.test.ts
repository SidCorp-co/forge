/**
 * The scan behind `single-door.test.ts` on a table that reaches a write some way later than where it
 * is named: stored into an object, returned by a method or a getter, taken by default, handed to a
 * function by a caller, kept by a rest binding or an `Object` built-in. Each is red where the table
 * is the comments table, and refused by name where the scan cannot tell what table it is.
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

const _found = (source: string, extra?: Record<string, string>) =>
  writesIn(source, extra).map((w) => `${w.file}:${w.line} ${w.kind}`);

const found = (source: string, extra?: Record<string, string>) =>
  writesIn(source, extra).map((w) => `${w.file}:${w.line} ${w.kind}`);

describe('a table that arrives some way later than where it is named', () => {
  it('finds the table a method of an object, an arrow property or an immediate call returns', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'const registry = { pick() { return comments; }, fetch: () => comments };',
      'export const go = async (db: any) => {',
      '  const a = registry.pick();',
      '  const b = registry.fetch();',
      '  const c = (() => comments)();',
      '  await db.delete(a);',
      '  await db.delete(b);',
      '  await db.delete(c);',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([
      'pipeline/planted.ts:7 write',
      'pipeline/planted.ts:8 write',
      'pipeline/planted.ts:9 write',
    ]);
  });

  it('refuses the result of a method of a class or an object the sources build and it cannot enter', () => {
    const source = [
      'class Picker { pick(): unknown { return null; } }',
      'const holder = { items: [] as unknown[] };',
      'export const go = async (db: any) => {',
      '  const t = new Picker().pick();',
      '  await db.delete(t).where();',
      '  const u = holder.items.at(0);',
      '  await db.delete(u).where();',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([
      'pipeline/planted.ts:5 unresolved',
      'pipeline/planted.ts:7 unresolved',
    ]);
  });

  it('finds the table stored into an object, an alias of it or an array after they are written', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'export const go = async (db: any, key: string) => {',
      '  const box: { table?: unknown } = {};',
      '  const alias = box;',
      '  box.table = comments;',
      '  await db.delete(alias.table);',
      '  const list: unknown[] = [];',
      '  list.push(comments);',
      '  await db.delete(list[0]);',
      '  const bag: Record<string, unknown> = {};',
      '  bag[key] = comments;',
      '  await db.delete(bag.anything);',
      '  const target = {};',
      '  Object.assign(target, { table: comments });',
      '  await db.delete((target as { table: unknown }).table);',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([
      'pipeline/planted.ts:6 write',
      'pipeline/planted.ts:9 write',
      'pipeline/planted.ts:12 write',
      'pipeline/planted.ts:15 write',
    ]);
  });

  it('finds the table a helper takes by default, whether the call gives one or leaves it out', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'function writeTo(table: unknown = comments) {',
      '  return db.insert(table).values({});',
      '}',
      'writeTo();',
      'writeTo(undefined);',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:3 write']);
  });

  it('leaves another table stored into an object alone', () => {
    const source = [
      "import { issues } from '../db/schema.js';",
      'export const go = async (db: any) => {',
      '  const box: { table?: unknown } = {};',
      '  box.table = issues;',
      '  await db.delete(box.table);',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([]);
  });
});

describe('a table that reaches a write through what a call or a container hands on', () => {
  it('finds the table a method of an object returns when the object is handed in by a caller', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'async function drop(db: any, registry: { pick(): unknown }) {',
      '  const t = registry.pick();',
      '  await db.delete(t);',
      '}',
      'drop(null, { pick: () => comments });',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:4 write']);
  });

  it('follows what a call hands a function through a second function and into a destructured parameter', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'async function inner(db: any, { table }: { table: unknown }) {',
      '  await db.delete(table);',
      '}',
      'const outer = (db: any, opts: { table: unknown }) => inner(db, opts);',
      'outer(null, { table: comments });',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:3 write']);
  });

  it('leaves a function that is only ever handed another table alone', () => {
    const source = [
      "import { issues } from '../db/schema.js';",
      'async function drop(db: any, registry: { pick(): unknown }) {',
      '  await db.delete(registry.pick());',
      '}',
      'drop(null, { pick: () => issues });',
    ].join('\n');
    expect(found(source)).toEqual([]);
  });

  it('finds the table in an array read by a string index or a numeric key in a pattern', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'export const go = async (db: any) => {',
      '  const tables = [comments];',
      "  await db.delete(tables['0']);",
      '  const { 0: first } = tables;',
      '  await db.delete(first);',
      '};',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:4 write', 'pipeline/planted.ts:6 write']);
  });

  it('finds the table in what an object or array rest binding keeps of its source', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'export const go = async (db: any) => {',
      '  const { ...rest } = { table: comments };',
      '  await db.delete(rest.table);',
      '  const [, ...others] = [comments, comments];',
      '  await db.delete(others[0]);',
      '  const [...all] = [comments];',
      '  await db.delete(all.at(0));',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([
      'pipeline/planted.ts:4 write',
      'pipeline/planted.ts:6 write',
      'pipeline/planted.ts:8 unresolved',
    ]);
  });

  it('finds the table a getter of an object returns, read into a variable or as the argument', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'const registry = { get table() { return comments; } };',
      'export const go = async (db: any) => {',
      '  const t = registry.table;',
      '  await db.delete(t);',
      '  await db.delete(registry.table);',
      '};',
    ].join('\n');
    expect(found(source)).toEqual(['pipeline/planted.ts:5 write', 'pipeline/planted.ts:6 write']);
  });

  it('finds the table in what Object and Array built-ins hand back of an object or array', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'export const go = async (db: any) => {',
      '  await db.delete(Object.fromEntries([["t", comments]]).t);',
      '  await db.delete(Object.values({ t: comments })[0]);',
      '  await db.delete(Object.entries({ t: comments })[0][1]);',
      '  await db.delete(Object.freeze({ t: comments }).t);',
      '  await db.delete(Array.from([comments])[0]);',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([
      'pipeline/planted.ts:3 write',
      'pipeline/planted.ts:4 write',
      'pipeline/planted.ts:5 write',
      'pipeline/planted.ts:6 write',
      'pipeline/planted.ts:7 write',
    ]);
  });

  it('refuses the table read from a class, a static member or an instance', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      'class Holder { static table = comments; }',
      'const Anon = class { static table = comments; };',
      'export const go = async (db: any) => {',
      '  await db.delete(Holder.table).where();',
      '  await db.delete(Anon.table).where();',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([
      'pipeline/planted.ts:5 unresolved',
      'pipeline/planted.ts:6 unresolved',
    ]);
  });

  it('finds the table under a member declared with a quoted name, and refuses one with a computed name', () => {
    const source = [
      "import { comments } from '../db/schema.js';",
      "const registry = { get 'table'() { return comments; }, 'pick'() { return comments; } };",
      "const keyed = { ['t' + 1]: comments };",
      'export const go = async (db: any) => {',
      '  await db.delete(registry.table);',
      '  await db.delete(registry.pick());',
      '  await db.delete(keyed.t1).where();',
      '};',
    ].join('\n');
    expect(found(source)).toEqual([
      'pipeline/planted.ts:5 write',
      'pipeline/planted.ts:6 write',
      'pipeline/planted.ts:7 unresolved',
    ]);
  });
});
