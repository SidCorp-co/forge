import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateWhereMock = vi.fn();
const updateSetMock = vi.fn();
const updateWhereArgMock = vi.fn();
const deleteWhereMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    update: () => ({
      set: (s: unknown) => {
        updateSetMock(s);
        return {
          where: (w: unknown) => {
            updateWhereArgMock(w);
            return { returning: () => updateWhereMock(w) };
          },
        };
      },
    }),
    delete: () => ({
      where: (w: unknown) => ({ returning: () => deleteWhereMock(w) }),
    }),
  },
}));

vi.mock('../queue/boss.js', () => ({ boss: {} }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runMemoryDecay, DECAY_SOURCES, STALE_UNCONFIRMED_DAYS } = await import('./decay.js');

/** Mirrors `collectSqlFragments` from dispatch-gates.test.ts — flattens a
 *  drizzle `sql`/`and(...)` tree down to its raw string literals so a WHERE
 *  clause built entirely in-DB (no fetch-then-filter) is still inspectable. */
function collectSqlFragments(sqlArg: unknown): string {
  const fragments: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      fragments.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node && typeof node === 'object') {
      const value = (node as { value?: unknown }).value;
      if (typeof value === 'string') fragments.push(value);
      else if (Array.isArray(value)) visit(value);
      const chunks = (node as { queryChunks?: unknown }).queryChunks;
      if (chunks) visit(chunks);
    }
  };
  visit(sqlArg);
  return fragments.join(' ');
}

beforeEach(() => {
  updateWhereMock.mockReset();
  updateSetMock.mockReset();
  updateWhereArgMock.mockReset();
  deleteWhereMock.mockReset();
  updateWhereMock.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
  deleteWhereMock.mockResolvedValue([{ id: 'c' }]);
});

describe('runMemoryDecay', () => {
  it('archives stale rows and purges long-archived rows, reporting counts', async () => {
    const result = await runMemoryDecay();
    expect(result.archived).toBe(2);
    expect(result.purged).toBe(1);
    expect(updateSetMock).toHaveBeenCalledTimes(1);
    expect(deleteWhereMock).toHaveBeenCalledTimes(1);
  });

  it('decays only agent-curated sources — lifecycle mirrors are exempt', () => {
    expect(DECAY_SOURCES).toEqual(['note', 'knowledge']);
    expect(DECAY_SOURCES).not.toContain('issue');
    expect(DECAY_SOURCES).not.toContain('decision');
    expect(DECAY_SOURCES).not.toContain('policy');
  });

  it('archive predicate includes a staleSince branch checked against last_verified_at', async () => {
    await runMemoryDecay();
    const whereArg = updateWhereArgMock.mock.calls[0]?.[0];
    const flat = collectSqlFragments(whereArg);
    expect(flat).toContain('staleSince');
    expect(flat).toContain('IS NOT NULL');
  });

  it('STALE_UNCONFIRMED_DAYS grace period is 14 days', () => {
    expect(STALE_UNCONFIRMED_DAYS).toBe(14);
  });
});
