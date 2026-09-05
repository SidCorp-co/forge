import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ISS-593 — the module invariants SQL cannot express: that a parent is a module in the same
 * project, that the hierarchy stays acyclic, and that a module always has a colour.
 *
 * The database half (the partial unique index on `is_primary`, and the additive defaults) is
 * proved against a real Postgres in `tests/integration/module-taxonomy-e2e.test.ts` — a mock
 * cannot fail on a constraint it does not have.
 */

type Row = { id: string; projectId: string; kind: 'label' | 'module'; parentId: string | null };

const rows = new Map<string, Row>();

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (cond: { __val: string }) => ({
          limit: () => Promise.resolve([rows.get(cond.__val)].filter(Boolean)),
        }),
      }),
    }),
  },
}));

// cm:guard spread the REAL drizzle-orm and wrap only `eq` — replacing the module wholesale breaks `db/schema.ts`, which builds its relations at import time and is what this file's subject imports for the `labels` table.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: Parameters<typeof actual.eq>[0], val: string) =>
      Object.assign(actual.eq(col, val), { __val: val }),
  };
});

const { ModuleHierarchyError, assertParentIsLegal, autoModuleColor } = await import(
  './module-service.js'
);

const P = 'project-1';
const OTHER = 'project-2';

function seed(id: string, over: Partial<Row> = {}): string {
  rows.set(id, { id, projectId: P, kind: 'module', parentId: null, ...over });
  return id;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ModuleHierarchyError) return err.code;
    throw err;
  }
  return 'NO_ERROR';
}

beforeEach(() => rows.clear());

describe('assertParentIsLegal', () => {
  it('accepts a module in the same project', async () => {
    const parent = seed('parent');
    await expect(assertParentIsLegal(P, parent, seed('child'))).resolves.toBeUndefined();
  });

  it('accepts a parent on create, where the child does not exist yet', async () => {
    const parent = seed('parent');
    await expect(assertParentIsLegal(P, parent, undefined)).resolves.toBeUndefined();
  });

  it('refuses a parentId naming nothing at all', async () => {
    expect(await codeOf(() => assertParentIsLegal(P, 'ghost', seed('child')))).toBe(
      'INVALID_PARENT',
    );
  });

  it('refuses a parent in another project', async () => {
    const parent = seed('parent', { projectId: OTHER });
    expect(await codeOf(() => assertParentIsLegal(P, parent, seed('child')))).toBe(
      'INVALID_PARENT',
    );
  });

  it('refuses a parent that is a plain label', async () => {
    const parent = seed('parent', { kind: 'label' });
    expect(await codeOf(() => assertParentIsLegal(P, parent, seed('child')))).toBe(
      'PARENT_NOT_MODULE',
    );
  });

  it('refuses a module as its own parent', async () => {
    const self = seed('self');
    expect(await codeOf(() => assertParentIsLegal(P, self, self))).toBe('CIRCULAR_HIERARCHY');
  });

  it('refuses a parent that is a direct child of this module', async () => {
    const top = seed('top');
    const mid = seed('mid', { parentId: top });
    expect(await codeOf(() => assertParentIsLegal(P, mid, top))).toBe('CIRCULAR_HIERARCHY');
  });

  it('refuses a parent three levels below this module', async () => {
    const top = seed('top');
    const a = seed('a', { parentId: top });
    const b = seed('b', { parentId: a });
    const c = seed('c', { parentId: b });
    expect(await codeOf(() => assertParentIsLegal(P, c, top))).toBe('CIRCULAR_HIERARCHY');
  });

  // cm:guard the FK permits a cycle, so a chain that already loops must TERMINATE here rather than spin — this test hangs the suite instead of failing it if the seen-set is removed
  it('terminates on an ancestry that already loops without reaching this module', async () => {
    const x = seed('x', { parentId: 'y' });
    seed('y', { parentId: x });
    await expect(assertParentIsLegal(P, x, seed('unrelated'))).resolves.toBeUndefined();
  });
});

describe('autoModuleColor', () => {
  it('returns a #rrggbb value the label colour regex accepts', () => {
    expect(autoModuleColor('pipeline')).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('is stable for the same name, so a re-created module keeps its colour', () => {
    expect(autoModuleColor('pipeline')).toBe(autoModuleColor('pipeline'));
  });

  it('spreads distinct names across the palette rather than answering one colour', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    expect(new Set(names.map(autoModuleColor)).size).toBeGreaterThan(1);
  });

  it('handles a name outside the BMP without producing a broken colour', () => {
    expect(autoModuleColor('module-\u{1F680}')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
