import { beforeEach, describe, expect, it, vi } from 'vitest';

const cut = vi.fn(async (_args: { projectId: string; userId: string }) => ({
  status: 'success' as const,
  output: 'cut',
}));
const returning = vi.fn(async () => [{ id: 'run-1' }]);

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({ values: () => ({ returning }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));
vi.mock('../comments/forge-author.js', () => ({ forgeAuthorId: async () => 'forge' }));
vi.mock('./release-batch-run.js', () => ({
  runScheduledReleaseCut: (args: { projectId: string; userId: string }) => cut(args),
}));
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { dispatchScheduleReleaseBatchRun } from './release-batch-dispatch.js';

const schedule = { id: 's1', projectId: 'p1', prompt: null, targetProjectSlug: null };

beforeEach(() => cut.mockClear());

describe('a release_batch schedule (ISS-1421)', () => {
  it('cuts as Forge on a tick, never as the project creator', async () => {
    await dispatchScheduleReleaseBatchRun({
      schedule,
      tick: true,
      resolvedTarget: { id: 'p1', createdBy: 'creator-1' },
    });
    expect(cut).toHaveBeenCalledWith({ projectId: 'p1', userId: 'forge' });
  });

  it('cuts as the person who pressed run now', async () => {
    await dispatchScheduleReleaseBatchRun({ schedule, actorUserId: 'person-7' });
    expect(cut).toHaveBeenCalledWith({ projectId: 'p1', userId: 'person-7' });
  });
});
