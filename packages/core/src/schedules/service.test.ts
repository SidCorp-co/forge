import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const updateWhere = vi.fn(async (_condition: unknown) => undefined);
const updateSet = vi.fn((_payload: unknown) => ({ where: updateWhere }));
vi.mock('../db/client.js', () => ({
  db: {
    update: vi.fn(() => ({ set: updateSet })),
  },
}));

const { writeBackScheduleLastStatus } = await import('./service.js');

describe('writeBackScheduleLastStatus', () => {
  beforeEach(() => {
    updateSet.mockClear();
    updateWhere.mockClear();
  });

  it('writes lastStatus=success for a completed schedule.run session', async () => {
    await writeBackScheduleLastStatus(
      { source: 'schedule.run', scheduleId: 'sched-1' },
      'sess-1',
      'completed',
    );
    expect(updateSet).toHaveBeenCalledWith({ lastStatus: 'success' });
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  it('writes lastStatus=failed for a failed schedule.run session', async () => {
    await writeBackScheduleLastStatus(
      { source: 'schedule.run', scheduleId: 'sched-1' },
      'sess-1',
      'failed',
    );
    expect(updateSet).toHaveBeenCalledWith({ lastStatus: 'failed' });
  });

  it('is a no-op for a non-schedule (plain chat) session', async () => {
    await writeBackScheduleLastStatus({ source: 'chat' }, 'sess-1', 'completed');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('is a no-op when metadata is null', async () => {
    await writeBackScheduleLastStatus(null, 'sess-1', 'completed');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('is a no-op when scheduleId is missing/non-string', async () => {
    await writeBackScheduleLastStatus({ source: 'schedule.run' }, 'sess-1', 'completed');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('never throws when the update itself throws (best-effort)', async () => {
    updateWhere.mockRejectedValueOnce(new Error('db down'));
    await expect(
      writeBackScheduleLastStatus(
        { source: 'schedule.run', scheduleId: 'sched-1' },
        'sess-1',
        'failed',
      ),
    ).resolves.toBeUndefined();
  });
});
