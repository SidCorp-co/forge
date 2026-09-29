import { describe, expect, it } from 'vitest';
import {
  allocate,
  objectDelta,
  rebaseSnapshot,
  referencesOf,
  retag,
  rewriteReferences,
} from './migrations.mjs';

const DAY = 86_400_000;
const W = 1_800_000_000_000;
const e = (idx, when, tag) => ({ idx, version: '7', when, tag, breakpoints: true });

describe('allocate', () => {
  const combined = [e(1, W, '0001_init')];

  it('keeps numbers that clear the combination and the open set', () => {
    const r = allocate({ combined, member: [e(2, W + DAY, '0002_b')], open: [] });
    expect(r.renumbered).toBe(false);
    expect(r.moves[0].to).toEqual(e(2, W + DAY, '0002_b'));
  });

  it('gives the next free number above a non-member branch holding the one it wanted', () => {
    const open = [{ branch: 'origin/other', entries: [e(2, W + DAY, '0002_other')] }];
    const r = allocate({
      combined,
      member: [e(2, W + DAY, '0002_b'), e(3, W + 2 * DAY, '0003_c')],
      open,
    });
    expect(r.renumbered).toBe(true);
    expect(r.moves.map((m) => m.to)).toEqual([
      e(3, W + 2 * DAY, '0003_b'),
      e(4, W + 3 * DAY, '0004_c'),
    ]);
  });

  it('renumbers a member landing on a number the combination already took', () => {
    const r = allocate({
      combined: [...combined, e(2, W + DAY, '0002_a')],
      member: [e(2, W + DAY, '0002_b')],
      open: [],
    });
    expect(r.moves[0].to).toEqual(e(3, W + 2 * DAY, '0003_b'));
  });

  it('keeps a tag with no numeric prefix, moving only its numbers', () => {
    expect(retag('hand_written', 7)).toBe('hand_written');
    expect(retag('0002_x_y', 12)).toBe('0012_x_y');
  });
});

describe('rewriteReferences', () => {
  it('moves each tag once, so a tag renumbered onto another renumbered tag keeps its own target', () => {
    const moves = [
      { from: { tag: '0002_update' }, to: { tag: '0003_update' } },
      { from: { tag: '0003_update' }, to: { tag: '0004_update' } },
    ];
    expect(rewriteReferences('first 0002_update, then 0003_update', moves)).toBe(
      'first 0003_update, then 0004_update',
    );
  });

  it('moves a tag only where it stands whole, leaving a longer tag it prefixes alone', () => {
    const moves = [{ from: { tag: '0002_add' }, to: { tag: '0005_add' } }];
    expect(rewriteReferences("'0002_add.sql', 0002_add_column, db/0002_add", moves)).toBe(
      "'0005_add.sql', 0002_add_column, db/0005_add",
    );
  });

  it('moves the longer of two tags one prefixes as itself', () => {
    const moves = [
      { from: { tag: '0002_add' }, to: { tag: '0005_add' } },
      { from: { tag: '0002_add_col' }, to: { tag: '0006_add_col' } },
    ];
    expect(rewriteReferences('0002_add and 0002_add_col', moves)).toBe('0005_add and 0006_add_col');
  });
});

const table = (name, columns, extra = {}) => ({
  name,
  schema: '',
  columns: Object.fromEntries(
    columns.map((c) => [c, { name: c, type: 'text', primaryKey: false, notNull: false }]),
  ),
  indexes: {},
  foreignKeys: {},
  compositePrimaryKeys: {},
  uniqueConstraints: {},
  ...extra,
});
const snap = (id, prevId, tables) => ({
  id,
  prevId,
  version: '7',
  dialect: 'postgresql',
  tables,
  enums: {},
  schemas: {},
  sequences: {},
  roles: {},
  policies: {},
  views: {},
  _meta: { columns: {}, schemas: {}, tables: {} },
});
const base = snap('s0', 'z', { 'public.a': table('a', ['id', 'name']) });

describe('rebaseSnapshot', () => {
  it('composes two members that add different tables, chaining off the combination', () => {
    const newParent = snap('s1', 's0', { ...base.tables, 'public.b': table('b', ['id']) });
    const mine = snap('s2', 's0', { ...base.tables, 'public.c': table('c', ['id']) });
    const r = rebaseSnapshot({ oldParent: base, newParent, snap: mine });
    expect(Object.keys(r.snapshot.tables).sort()).toEqual(['public.a', 'public.b', 'public.c']);
    expect(r.snapshot.id).toBe('s2');
    expect(r.snapshot.prevId).toBe('s1');
  });

  it('composes two members that each add a different column to one table', () => {
    const newParent = snap('s1', 's0', { 'public.a': table('a', ['id', 'name', 'x']) });
    const mine = snap('s2', 's0', { 'public.a': table('a', ['id', 'name', 'y']) });
    const r = rebaseSnapshot({ oldParent: base, newParent, snap: mine });
    expect(Object.keys(r.snapshot.tables['public.a'].columns)).toEqual(['id', 'name', 'x', 'y']);
  });

  it('isolates a member dropping a column an earlier member indexed, naming the table', () => {
    const indexed = table('a', ['id', 'name'], {
      indexes: { a_name_idx: { name: 'a_name_idx', columns: [{ expression: 'name' }] } },
    });
    const newParent = snap('s1', 's0', { 'public.a': indexed });
    const mine = snap('s2', 's0', { 'public.a': table('a', ['id']) });
    expect(rebaseSnapshot({ oldParent: base, newParent, snap: mine }).refusal).toBe(
      'tables:public.a is touched by this member and by an earlier member, and this member changes what was in it',
    );
  });

  it('isolates a member whose new foreign key points at a table an earlier member dropped', () => {
    const withB = snap('s0', 'z', { ...base.tables, 'public.b': table('b', ['id']) });
    const newParent = snap('s1', 's0', { ...base.tables });
    const fk = {
      c_b_fk: {
        name: 'c_b_fk',
        tableFrom: 'c',
        tableTo: 'b',
        columnsFrom: ['b_id'],
        columnsTo: ['id'],
      },
    };
    const mine = snap('s2', 's0', {
      ...withB.tables,
      'public.c': table('c', ['b_id'], { foreignKeys: fk }),
    });
    expect(rebaseSnapshot({ oldParent: withB, newParent, snap: mine }).refusal).toBe(
      'tables:public.c in this member points at tables:public.b, which an earlier member removes',
    );
  });

  it('isolates two members that create one table identically, since both migrations create it', () => {
    const newParent = snap('s1', 's0', { ...base.tables, 'public.b': table('b', ['id']) });
    const mine = snap('s2', 's0', { ...base.tables, 'public.b': table('b', ['id']) });
    expect(rebaseSnapshot({ oldParent: base, newParent, snap: mine }).refusal).toBe(
      'tables:public.b is added by this member and by an earlier member alike, and two migrations cannot both create it',
    );
  });

  it('isolates two members that add one column identically, since both migrations add it', () => {
    const newParent = snap('s1', 's0', { 'public.a': table('a', ['id', 'name', 'x']) });
    const mine = snap('s2', 's0', { 'public.a': table('a', ['id', 'name', 'x']) });
    expect(rebaseSnapshot({ oldParent: base, newParent, snap: mine }).refusal).toBe(
      'tables:public.a is added to by this member and by an earlier member alike, at columns.x, and two migrations cannot both create it',
    );
  });

  it('isolates two members that create one table differently', () => {
    const newParent = snap('s1', 's0', { ...base.tables, 'public.b': table('b', ['id']) });
    const mine = snap('s2', 's0', { ...base.tables, 'public.b': table('b', ['id', 'other']) });
    expect(rebaseSnapshot({ oldParent: base, newParent, snap: mine }).refusal).toMatch(
      /tables:public\.b is added to by this member and an earlier member/,
    );
  });
});

describe('objectDelta and referencesOf', () => {
  it('reads an added column as additive and a dropped one as not', () => {
    const grown = objectDelta(
      base,
      snap('s', 's0', { 'public.a': table('a', ['id', 'name', 'z']) }),
    );
    const shrunk = objectDelta(base, snap('s', 's0', { 'public.a': table('a', ['id']) }));
    expect(grown.get('tables:public.a').additive).toBe(true);
    expect(shrunk.get('tables:public.a').additive).toBe(false);
  });

  it('names an enum a column is typed by', () => {
    expect([...referencesOf({ c: { name: 'c', type: 'state', typeSchema: 'public' } })]).toEqual([
      'enums:public.state',
    ]);
  });
});
