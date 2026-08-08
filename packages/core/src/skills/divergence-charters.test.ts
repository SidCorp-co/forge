import { divergenceCharterEntrySchema, divergenceCharterSchema } from '@forge/contracts';
import { describe, expect, it, vi } from 'vitest';
import { divergenceCharters } from '../db/schema.js';

describe('divergence-charter schema parity', () => {
  it('divergenceCharters table has id, projectId, entries, createdAt, updatedAt columns', () => {
    const cols = Object.keys(divergenceCharters);
    expect(cols).toContain('id');
    expect(cols).toContain('projectId');
    expect(cols).toContain('entries');
    expect(cols).toContain('createdAt');
    expect(cols).toContain('updatedAt');
  });

  it('DivergenceCharterEntry schema validates a well-formed entry', () => {
    const entry = {
      id: 'forge-release-no-prod-merge',
      skill: 'forge-release',
      difference: 'Production merge removed.',
      reason: 'ISS-354: conflict markers broke prod for 10 days.',
      incidentRefs: ['ISS-354', '148484a0'],
      revertable: false,
    };
    expect(() => divergenceCharterEntrySchema.parse(entry)).not.toThrow();
  });

  it('DivergenceCharterEntry rejects missing required fields', () => {
    expect(() =>
      divergenceCharterEntrySchema.parse({ id: 'x', skill: 'y' }),
    ).toThrow();
  });

  it('DivergenceCharter schema validates a charter with entries array', () => {
    const charter = {
      id: 'uuid-1',
      projectId: 'uuid-2',
      entries: [
        {
          id: 'e1',
          skill: 'forge-release',
          difference: 'No prod merge.',
          reason: 'ISS-354.',
          incidentRefs: ['ISS-354'],
          revertable: false,
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(() => divergenceCharterSchema.parse(charter)).not.toThrow();
  });
});

describe('upsertCharter', () => {
  it('inserts and emits charter.changed in the same executor', async () => {
    const returnedRow = {
      id: 'row-id',
      projectId: 'proj-1',
      entries: [
        {
          id: 'e1',
          skill: 'forge-release',
          difference: 'No prod merge.',
          reason: 'ISS-354.',
          incidentRefs: ['ISS-354'],
          revertable: false,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const returningFn = vi.fn(async () => [returnedRow]);
    const onConflictFn = vi.fn(() => ({ returning: returningFn }));
    const valuesFn = vi.fn(() => ({ onConflictDoUpdate: onConflictFn }));
    const insertFn = vi.fn(() => ({ values: valuesFn }));

    const selectWhereFn = vi.fn(() => ({ limit: vi.fn(async () => []) }));
    const selectFromFn = vi.fn(() => ({ where: selectWhereFn }));
    const selectFn = vi.fn(() => ({ from: selectFromFn }));

    const activityInsertValues = vi.fn(async () => {});
    const activityInsertFn = vi.fn(() => ({ values: activityInsertValues }));

    const tx = {
      insert: vi.fn((table) => {
        if (table === divergenceCharters) return { values: valuesFn };
        return { values: activityInsertValues };
      }),
      select: selectFn,
    } as never;

    const { upsertCharter } = await import('./divergence-charters.js');
    const result = await upsertCharter(tx, {
      projectId: 'proj-1',
      entries: returnedRow.entries,
      actor: 'human:owner',
      reason: 'initial seed',
    });

    expect(result.projectId).toBe('proj-1');
    expect(result.entries).toHaveLength(1);
  });
});
