/**
 * ISS-785 — kill-before-reap gate primitives.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ _eq: args }),
}));

vi.mock('../db/schema.js', () => ({
  jobs: 'jobs-table',
  runners: 'runners-table',
}));

const updateWhereMock = vi.fn(async (_arg: unknown) => undefined);
const selectLimitMock = vi.fn(async () => [] as Array<{ lastSeenAt: Date | string | null }>);
vi.mock('../db/client.js', () => ({
  db: {
    update: () => ({ set: () => ({ where: (arg: unknown) => updateWhereMock(arg) }) }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => selectLimitMock() }),
      }),
    }),
  },
}));

const publishMock = vi.fn();
vi.mock('../ws/rooms.js', () => ({ deviceRoom: (id: string) => `device:${id}` }));
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...a: unknown[]) => publishMock(...a) },
}));

const { requestJobKill, resolveKillConfirmation, killGraceMs } = await import('./kill-gate.js');

function ref(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'job-1',
    deviceId: 'device-1',
    runnerId: 'runner-1',
    killRequestedAt: null,
    killConfirmedAt: null,
    killOutcome: null,
    ...overrides,
  } as Parameters<typeof requestJobKill>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PIPELINE_KILL_CONFIRM_MS = undefined;
  selectLimitMock.mockResolvedValue([]);
});

describe('killGraceMs', () => {
  it('defaults to 90s', () => {
    expect(killGraceMs()).toBe(90_000);
  });

  it('honours a valid env override at/above the floor', () => {
    process.env.PIPELINE_KILL_CONFIRM_MS = '45000';
    expect(killGraceMs()).toBe(45_000);
  });

  it('falls back to the default below the floor', () => {
    process.env.PIPELINE_KILL_CONFIRM_MS = '1000';
    expect(killGraceMs()).toBe(90_000);
  });
});

describe('requestJobKill', () => {
  it('stamps kill_requested_at and publishes job.cancel when a device is bound', async () => {
    const result = await requestJobKill(ref(), 'session_lost');

    expect(result).toBe('requested');
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith('device:device-1', {
      event: 'job.cancel',
      data: { jobId: 'job-1', reason: 'session_lost' },
    });
  });

  it('is idempotent — skips the stamp when kill_requested_at is already set', async () => {
    await requestJobKill(ref({ killRequestedAt: new Date() }), 'session_lost');

    expect(updateWhereMock).not.toHaveBeenCalled();
  });

  it('reports no_device and skips the publish when the job has no deviceId', async () => {
    const result = await requestJobKill(ref({ deviceId: null }), 'dispatch_unclaimed');

    expect(result).toBe('no_device');
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe('resolveKillConfirmation', () => {
  it('is confirmed once killConfirmedAt is set, echoing the stored outcome', async () => {
    const result = await resolveKillConfirmation(
      ref({ killConfirmedAt: new Date(), killOutcome: 'killed' }),
    );

    expect(result).toEqual({ confirmed: true, outcome: 'killed' });
  });

  it('is unconfirmed when the owning runner has no runnerId to check', async () => {
    const result = await resolveKillConfirmation(ref({ runnerId: null }));

    expect(result).toEqual({ confirmed: false, outcome: null });
  });

  it('is unconfirmed while the owning runner is fresh (online, silent about the kill)', async () => {
    selectLimitMock.mockResolvedValueOnce([{ lastSeenAt: new Date() }]);

    const result = await resolveKillConfirmation(ref());

    expect(result).toEqual({ confirmed: false, outcome: null });
  });

  it('confirms via confirmation-by-absence once the runner heartbeat goes stale', async () => {
    selectLimitMock.mockResolvedValueOnce([{ lastSeenAt: new Date(Date.now() - 60_000) }]);

    const result = await resolveKillConfirmation(ref());

    expect(result).toEqual({ confirmed: true, outcome: 'runner_gone' });
  });

  it('confirms via confirmation-by-absence when the runner has never pinged', async () => {
    selectLimitMock.mockResolvedValueOnce([{ lastSeenAt: null }]);

    const result = await resolveKillConfirmation(ref());

    expect(result).toEqual({ confirmed: true, outcome: 'runner_gone' });
  });
});
