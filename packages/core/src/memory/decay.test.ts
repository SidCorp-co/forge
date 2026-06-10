import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateWhereMock = vi.fn();
const updateSetMock = vi.fn();
const deleteWhereMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    update: () => ({
      set: (s: unknown) => {
        updateSetMock(s);
        return { where: (w: unknown) => ({ returning: () => updateWhereMock(w) }) };
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

const { runMemoryDecay, DECAY_SOURCES } = await import('./decay.js');

beforeEach(() => {
  updateWhereMock.mockReset();
  updateSetMock.mockReset();
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
});
