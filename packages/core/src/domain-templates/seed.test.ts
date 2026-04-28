import { describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const insertValues = vi.fn(() => Promise.resolve());
const updateWhere = vi.fn(() => Promise.resolve());
const updateSet = vi.fn(() => ({ where: updateWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
  },
}));

const { seedDomainTemplates } = await import('./seed.js');
const { builtinTemplates } = await import('./seeds/index.js');
const { db } = await import('../db/client.js');

describe('seedDomainTemplates', () => {
  it('inserts every builtin when none exist', async () => {
    selectLimit.mockResolvedValue([]);
    const result = await seedDomainTemplates(db);
    expect(result.inserted).toBe(builtinTemplates.length);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
  });

  it('marks unchanged when contentHash matches', async () => {
    // First call: pretend each row exists with a matching hash. We compute the
    // expected hash the same way the seeder does.
    const { createHash } = await import('node:crypto');
    selectLimit.mockReset();
    for (const t of builtinTemplates) {
      const hash = createHash('sha256').update(JSON.stringify(t.manifest)).digest('hex');
      selectLimit.mockResolvedValueOnce([{ id: 'fake-id', contentHash: hash }]);
    }
    const result = await seedDomainTemplates(db);
    expect(result.unchanged).toBe(builtinTemplates.length);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);
  });

  it('updates when contentHash differs', async () => {
    selectLimit.mockReset();
    for (const _t of builtinTemplates) {
      selectLimit.mockResolvedValueOnce([{ id: 'fake-id', contentHash: 'stale' }]);
    }
    const result = await seedDomainTemplates(db);
    expect(result.updated).toBe(builtinTemplates.length);
  });
});
