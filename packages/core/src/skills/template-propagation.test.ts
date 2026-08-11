import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { sweepTemplateBumps, sweepTemplateDrift } = await import('./template-propagation.js');

function stubCopies(rows: unknown[]) {
  selectMock.mockReturnValue({ from: () => ({ where: () => Promise.resolve(rows) }) });
}

const BUMP = {
  globalSkillId: 'g1',
  name: 'forge-code',
  oldVersion: 6,
  newVersion: 7,
};

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
});

describe('sweepTemplateDrift', () => {
  it('counts project copies left behind by the bump', async () => {
    stubCopies([
      { skillId: 's1', projectId: 'p1' },
      { skillId: 's2', projectId: 'p2' },
    ]);
    await expect(sweepTemplateDrift(BUMP)).resolves.toEqual({ behind: 2 });
  });

  it('reports zero when every copy is current', async () => {
    stubCopies([]);
    await expect(sweepTemplateDrift(BUMP)).resolves.toEqual({ behind: 0 });
  });

  // cm:why the whole point of the ISS-605 rewrite — a stale un-consumed rebase draft used to mute every later bump for that skill; no write, no mute
  it('never writes an issue', async () => {
    stubCopies([{ skillId: 's1', projectId: 'p1' }]);
    await sweepTemplateDrift(BUMP);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('sweepTemplateBumps', () => {
  it('swallows a failing bump so the seed/boot path survives', async () => {
    selectMock.mockReturnValueOnce({
      from: () => ({ where: () => Promise.reject(new Error('db down')) }),
    });
    stubCopies([{ skillId: 's9', projectId: 'p9' }]);
    const results = await sweepTemplateBumps([BUMP, { ...BUMP, name: 'forge-test' }]);
    expect(results).toEqual([{ behind: 1 }]);
  });
});
