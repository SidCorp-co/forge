import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ISS-593 — the primary-module invariants the write resolver owns. Both refusals happen HERE,
 * before any transaction opens, so a rejected set writes nothing at all; the database's partial
 * unique index is the backstop for a writer that bypasses this path, and is proved against a
 * real Postgres in `tests/integration/module-taxonomy-e2e.test.ts`.
 */

type Row = { id: string; name: string; kind: 'label' | 'module' };

let projectRows: Row[] = [];
let selected: string[] = [];

vi.mock('../db/client.js', () => ({
  db: {
    select: (cols: Record<string, unknown>) => {
      selected = Object.keys(cols);
      return {
        from: () => ({ where: () => ({ limit: () => Promise.resolve(projectRows) }) }),
      };
    },
  },
}));

const { LabelResolutionError, PrimaryModuleError, resolveLabelIdsForWrite } = await import(
  './label-service.js'
);

const MODULE_A = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'pipeline',
  kind: 'module',
} as const;
const MODULE_B = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'issues',
  kind: 'module',
} as const;
const PLAIN = { id: '33333333-3333-4333-8333-333333333333', name: 'bug', kind: 'label' } as const;

beforeEach(() => {
  projectRows = [{ ...MODULE_A }, { ...MODULE_B }, { ...PLAIN }];
  selected = [];
});

describe('resolveLabelIdsForWrite — the pre-existing string form', () => {
  it('attaches a label named by string with isPrimary false', async () => {
    expect(await resolveLabelIdsForWrite('p', ['bug'])).toEqual([
      { labelId: PLAIN.id, isPrimary: false },
    ]);
  });

  it('attaches a label named by uuid with isPrimary false', async () => {
    expect(await resolveLabelIdsForWrite('p', [PLAIN.id])).toEqual([
      { labelId: PLAIN.id, isPrimary: false },
    ]);
  });

  it('still throws LabelResolutionError naming an unknown value', async () => {
    await expect(resolveLabelIdsForWrite('p', ['ghost'])).rejects.toBeInstanceOf(
      LabelResolutionError,
    );
  });

  it('resolves an empty set to an empty set rather than querying', async () => {
    expect(await resolveLabelIdsForWrite('p', [])).toEqual([]);
  });
});

describe('resolveLabelIdsForWrite — the primary module', () => {
  it('marks a module primary when the object form asks for it', async () => {
    expect(
      await resolveLabelIdsForWrite('p', ['bug', { labelId: 'pipeline', isPrimary: true }]),
    ).toEqual([
      { labelId: PLAIN.id, isPrimary: false },
      { labelId: MODULE_A.id, isPrimary: true },
    ]);
  });

  it('accepts a module by uuid in the object form', async () => {
    expect(await resolveLabelIdsForWrite('p', [{ labelId: MODULE_A.id, isPrimary: true }])).toEqual(
      [{ labelId: MODULE_A.id, isPrimary: true }],
    );
  });

  it('treats the object form without isPrimary as a plain attach', async () => {
    expect(await resolveLabelIdsForWrite('p', [{ labelId: 'pipeline' }])).toEqual([
      { labelId: MODULE_A.id, isPrimary: false },
    ]);
  });

  it('refuses a plain label marked primary, with PRIMARY_NOT_MODULE', async () => {
    const err = await resolveLabelIdsForWrite('p', [{ labelId: 'bug', isPrimary: true }]).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(PrimaryModuleError);
    expect((err as InstanceType<typeof PrimaryModuleError>).code).toBe('PRIMARY_NOT_MODULE');
  });

  it('refuses two primaries in one set, with MULTIPLE_PRIMARY', async () => {
    const err = await resolveLabelIdsForWrite('p', [
      { labelId: 'pipeline', isPrimary: true },
      { labelId: 'issues', isPrimary: true },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(PrimaryModuleError);
    expect((err as InstanceType<typeof PrimaryModuleError>).code).toBe('MULTIPLE_PRIMARY');
  });

  // cm:guard the count is checked BEFORE the lookup, so a set with two primaries is refused even when neither value resolves — otherwise the caller gets INVALID_LABELS and fixes the wrong half
  it('refuses two primaries before reporting either as unknown', async () => {
    projectRows = [];
    const err = await resolveLabelIdsForWrite('p', [
      { labelId: 'ghost-a', isPrimary: true },
      { labelId: 'ghost-b', isPrimary: true },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(PrimaryModuleError);
  });

  it('reads `kind` out of the database — the refusal cannot be decided without it', async () => {
    await resolveLabelIdsForWrite('p', ['bug']);
    expect(selected).toContain('kind');
  });

  it('collapses a label named twice, once by name and once by uuid, into one row', async () => {
    expect(
      await resolveLabelIdsForWrite('p', ['pipeline', { labelId: MODULE_A.id, isPrimary: true }]),
    ).toEqual([{ labelId: MODULE_A.id, isPrimary: true }]);
  });
});
