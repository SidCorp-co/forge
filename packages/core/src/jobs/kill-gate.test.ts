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

const updateSetMock = vi.fn();
const updateWhereMock = vi.fn(async (_arg: unknown) => undefined);
const selectLimitMock = vi.fn(async () => [] as Array<{ lastSeenAt: Date | string | null }>);
vi.mock('../db/client.js', () => ({
  db: {
    update: () => ({
      set: (patch: unknown) => {
        updateSetMock(patch);
        return { where: (arg: unknown) => updateWhereMock(arg) };
      },
    }),
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

const {
  requestJobKill,
  resolveKillConfirmation,
  killGraceMs,
  killEpisodeWindowMs,
  isKillEpisodeLive,
} = await import('./kill-gate.js');

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

describe('isKillEpisodeLive', () => {
  it('is false for a job that was never kill-requested', () => {
    expect(isKillEpisodeLive(ref())).toBe(false);
  });

  it('is true inside the window and false once the request has aged out', () => {
    const window = killEpisodeWindowMs();
    expect(isKillEpisodeLive(ref({ killRequestedAt: new Date(Date.now() - window + 1_000) }))).toBe(
      true,
    );
    expect(isKillEpisodeLive(ref({ killRequestedAt: new Date(Date.now() - window - 1_000) }))).toBe(
      false,
    );
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

  it('is idempotent within a live episode — skips the stamp, still re-publishes', async () => {
    await requestJobKill(ref({ killRequestedAt: new Date() }), 'session_lost');

    expect(updateWhereMock).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('re-opens the episode past the window, clearing the previous answer', async () => {
    await requestJobKill(
      ref({
        killRequestedAt: new Date(Date.now() - killEpisodeWindowMs() - 1_000),
        killConfirmedAt: new Date(Date.now() - killEpisodeWindowMs()),
        killOutcome: 'not_found',
      }),
      'stale',
    );

    expect(updateWhereMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        killRequestedAt: expect.any(Date),
        killConfirmedAt: null,
        killOutcome: null,
      }),
    );
  });

  it('reports no_device and skips the publish when the job has no deviceId', async () => {
    const result = await requestJobKill(ref({ deviceId: null }), 'dispatch_unclaimed');

    expect(result).toBe('no_device');
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe('resolveKillConfirmation', () => {
  it('is confirmed once THIS episode is answered, echoing the stored outcome', async () => {
    const result = await resolveKillConfirmation(
      ref({
        killRequestedAt: new Date(Date.now() - 1_000),
        killConfirmedAt: new Date(),
        killOutcome: 'killed',
      }),
    );

    expect(result).toEqual({ confirmed: true, outcome: 'killed' });
  });

  it('ignores an answer from an aged-out episode and falls through to the runner check', async () => {
    selectLimitMock.mockResolvedValueOnce([{ lastSeenAt: new Date() }]);

    const result = await resolveKillConfirmation(
      ref({
        killRequestedAt: new Date(Date.now() - killEpisodeWindowMs() - 1_000),
        killConfirmedAt: new Date(Date.now() - killEpisodeWindowMs()),
        killOutcome: 'not_found',
      }),
    );

    expect(result).toEqual({ confirmed: false, outcome: null });
  });

  it('ignores an answer that predates the request it supposedly answers', async () => {
    selectLimitMock.mockResolvedValueOnce([{ lastSeenAt: new Date() }]);

    const result = await resolveKillConfirmation(
      ref({
        killRequestedAt: new Date(Date.now() - 1_000),
        killConfirmedAt: new Date(Date.now() - 60_000),
        killOutcome: 'not_found',
      }),
    );

    expect(result).toEqual({ confirmed: false, outcome: null });
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
