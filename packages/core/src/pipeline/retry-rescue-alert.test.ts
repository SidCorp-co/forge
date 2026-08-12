import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => execute(...args),
    select: () => ({ from: selectFrom }),
  },
}));

const emitNotification = vi.fn();
vi.mock('../notifications/emit.js', () => ({
  emitNotification: (...args: unknown[]) => emitNotification(...args),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

const { detectRetryRescueThresholds, retryRescueResolutionKey } = await import(
  './retry-rescue-alert.js'
);

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue([]);
  selectLimit.mockReset();
});

describe('detectRetryRescueThresholds', () => {
  it('notifies once per reason/window even when the first alert was read', async () => {
    const now = new Date('2026-08-12T10:15:00.000Z');
    execute.mockResolvedValueOnce([
      { project_id: 'project-1', failure_reason: 'hooks_path', rescues: '5' },
    ]);
    selectLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([{ createdBy: 'owner-1' }]);

    const first = await detectRetryRescueThresholds(now);

    expect(first).toEqual({ detected: 1, notified: 1 });
    expect(emitNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'retry_rescue_threshold',
        resolutionKey: retryRescueResolutionKey('project-1', 'hooks_path', now),
      }),
    );

    execute.mockResolvedValueOnce([
      { project_id: 'project-1', failure_reason: 'hooks_path', rescues: 6 },
    ]);
    selectLimit.mockResolvedValueOnce([{ id: 'already-alerted' }]);
    const second = await detectRetryRescueThresholds(now);

    expect(second).toEqual({ detected: 1, notified: 0 });
    expect(emitNotification).toHaveBeenCalledTimes(1);
  });

  it('continues after a concurrent alert insert wins', async () => {
    const now = new Date('2026-08-12T10:15:00.000Z');
    execute.mockResolvedValueOnce([
      { project_id: 'project-1', failure_reason: 'hooks_path', rescues: 5 },
      { project_id: 'project-2', failure_reason: 'runner_startup', rescues: 5 },
    ]);
    selectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ createdBy: 'owner-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ createdBy: 'owner-2' }]);
    emitNotification
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }))
      .mockResolvedValueOnce({ id: 'notification-2' });

    const result = await detectRetryRescueThresholds(now);

    expect(result).toEqual({ detected: 2, notified: 1 });
    expect(emitNotification).toHaveBeenCalledTimes(2);
  });
});
