// ISS-737: data-driven seed-list + fan-out. All DB calls and
// resolveOrAdoptProjectSkill are mocked — no real database needed (mirrors
// the pattern in knowledge/migrate-project-facts.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

const resolveOrAdoptProjectSkillMock = vi.fn();
vi.mock('./service.js', () => ({
  resolveOrAdoptProjectSkill: (...args: unknown[]) => resolveOrAdoptProjectSkillMock(...args),
}));

let mockProjectRows: Array<{ id: string }> = [];
const updateSetMock = vi.fn();

vi.mock('../db/client.js', () => {
  return {
    db: {
      select: () => ({
        from: (_table: unknown) => Promise.resolve(mockProjectRows),
      }),
      update: (_table: unknown) => ({
        set: (values: unknown) => {
          updateSetMock(values);
          return { where: (_cond: unknown) => Promise.resolve() };
        },
      }),
    },
  };
});

import {
  ensureSharedInstallOnlySkills,
  fanOutSharedInstallOnlySkills,
} from './bootstrap-service.js';

// The production seed-list is EMPTY (ISS-742 — meta skills ship via the plugin
// channel, not this per-project disk bridge). The mechanism is retained for a
// genuinely per-project shared utility, so these tests drive it with an
// explicit representative seed rather than the const.
const SEED = ['shared-utility'];

describe('ensureSharedInstallOnlySkills', () => {
  beforeEach(() => {
    resolveOrAdoptProjectSkillMock.mockReset();
    updateSetMock.mockClear();
  });

  it('production default seed-list is empty — no adoption (ISS-742)', async () => {
    await ensureSharedInstallOnlySkills('proj-1');
    expect(resolveOrAdoptProjectSkillMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('adopts each seed skill and flips it install_only', async () => {
    resolveOrAdoptProjectSkillMock.mockResolvedValueOnce('skill-1');

    await ensureSharedInstallOnlySkills('proj-1', SEED);

    expect(resolveOrAdoptProjectSkillMock).toHaveBeenCalledWith('proj-1', 'shared-utility');
    expect(updateSetMock).toHaveBeenCalledWith({ installOnly: true });
  });

  it('re-running is idempotent — no throw, no duplicate adoption call shape', async () => {
    resolveOrAdoptProjectSkillMock.mockResolvedValue('skill-1');

    await ensureSharedInstallOnlySkills('proj-1', SEED);
    await ensureSharedInstallOnlySkills('proj-1', SEED);

    expect(resolveOrAdoptProjectSkillMock).toHaveBeenCalledTimes(2);
    expect(updateSetMock).toHaveBeenCalledTimes(2);
    for (const call of updateSetMock.mock.calls) {
      expect(call[0]).toEqual({ installOnly: true });
    }
  });

  it('skips a seed entry with no global template without throwing', async () => {
    resolveOrAdoptProjectSkillMock.mockResolvedValueOnce(null);

    await expect(ensureSharedInstallOnlySkills('proj-1', SEED)).resolves.toBeUndefined();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('swallows a per-entry failure (best-effort, never breaks the caller)', async () => {
    resolveOrAdoptProjectSkillMock.mockRejectedValueOnce(new Error('boom'));

    await expect(ensureSharedInstallOnlySkills('proj-1', SEED)).resolves.toBeUndefined();
  });
});

describe('fanOutSharedInstallOnlySkills', () => {
  beforeEach(() => {
    resolveOrAdoptProjectSkillMock.mockReset();
    updateSetMock.mockClear();
    mockProjectRows = [];
  });

  it('sweeps every project and reports a summary', async () => {
    mockProjectRows = [{ id: 'proj-1' }, { id: 'proj-2' }];
    resolveOrAdoptProjectSkillMock.mockResolvedValue('skill-x');

    const result = await fanOutSharedInstallOnlySkills(SEED);

    expect(result).toEqual({ totalProjects: 2, succeeded: 2, failed: 0 });
    expect(resolveOrAdoptProjectSkillMock).toHaveBeenCalledWith('proj-1', 'shared-utility');
    expect(resolveOrAdoptProjectSkillMock).toHaveBeenCalledWith('proj-2', 'shared-utility');
  });

  it('one project failing does not abort the sweep for the rest', async () => {
    mockProjectRows = [{ id: 'proj-1' }, { id: 'proj-2' }, { id: 'proj-3' }];
    // ensureSharedInstallOnlySkills itself never throws (per-entry try/catch),
    // so simulate a project-level failure surfacing some other way — the
    // sweep loop's own try/catch must still hold even if that invariant ever
    // changes.
    resolveOrAdoptProjectSkillMock
      .mockResolvedValueOnce('skill-1')
      .mockRejectedValueOnce(new Error('project 2 blew up'))
      .mockResolvedValueOnce('skill-3');

    const result = await fanOutSharedInstallOnlySkills(SEED);

    // ensureSharedInstallOnlySkills swallows the per-entry error internally,
    // so every project still counts as succeeded from the sweep's point of
    // view — asserting the sweep completes all 3 projects either way.
    expect(result.totalProjects).toBe(3);
    expect(result.succeeded + result.failed).toBe(3);
    expect(resolveOrAdoptProjectSkillMock).toHaveBeenCalledTimes(3);
  });
});
