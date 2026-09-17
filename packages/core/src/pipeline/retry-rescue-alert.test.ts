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
  // ISS-1063 — `notified` counts DELIVERIES, not emissions. This type declares a pending
  // duration, so the first sighting writes a record nobody is told about and reports 0;
  // what makes the alarm audible is the next pass re-emitting the same identity.
  it('reports who was told, and re-emits a pending record so it can promote', async () => {
    const now = new Date('2026-08-12T10:15:00.000Z');
    execute.mockResolvedValueOnce([
      { project_id: 'project-1', failure_reason: 'hooks_path', rescues: '5' },
    ]);
    selectLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([{ createdBy: 'owner-1' }]);
    emitNotification.mockResolvedValueOnce({ id: 'notification-1', delivered: 0 });

    const first = await detectRetryRescueThresholds(now);

    expect(first).toEqual({ detected: 1, notified: 0 });
    expect(emitNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'retry_rescue_threshold',
        resolutionKey: retryRescueResolutionKey('project-1', 'hooks_path', now),
      }),
    );

    // The next pass sees the same pending record and emits again: that emission IS its
    // second evaluation. Skipping on existence alone left it pending until it went stale,
    // so the alarm could never fire at all.
    execute.mockResolvedValueOnce([
      { project_id: 'project-1', failure_reason: 'hooks_path', rescues: 6 },
    ]);
    selectLimit
      .mockResolvedValueOnce([{ id: 'already-alerted', resolvedAt: null }])
      .mockResolvedValueOnce([{ createdBy: 'owner-1' }]);
    emitNotification.mockResolvedValueOnce({ id: 'notification-1', delivered: 1 });
    const second = await detectRetryRescueThresholds(now);

    expect(second).toEqual({ detected: 1, notified: 1 });
    expect(emitNotification).toHaveBeenCalledTimes(2);

    // And once the window's alarm is RESOLVED, the same window says nothing more: emitting
    // past a resolution would write a second record for one window rather than reopening it.
    execute.mockResolvedValueOnce([
      { project_id: 'project-1', failure_reason: 'hooks_path', rescues: 7 },
    ]);
    selectLimit.mockResolvedValueOnce([{ id: 'already-alerted', resolvedAt: new Date() }]);
    const third = await detectRetryRescueThresholds(now);

    expect(third).toEqual({ detected: 1, notified: 0 });
    expect(emitNotification).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce({ id: 'notification-2', delivered: 1 });

    const result = await detectRetryRescueThresholds(now);

    expect(result).toEqual({ detected: 2, notified: 1 });
    expect(emitNotification).toHaveBeenCalledTimes(2);
  });
});
