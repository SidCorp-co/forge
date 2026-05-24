import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

const publishSpy = vi.fn(() => 0);
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: publishSpy },
}));

vi.mock('../ws/rooms.js', () => ({
  projectRoom: (id: string) => `project:${id}`,
}));

const { publishSessionRecoveryChanged } = await import('./recovery-publish.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('publishSessionRecoveryChanged', () => {
  it('publishes recoveryStats snapshot to the project room', async () => {
    const recoveryStats = {
      totalFailures: 2,
      byKind: { transient: 1, permission: 0, permanent: 0, timeout: 1 },
      lastFailureAt: '2026-05-23T12:00:00.000Z',
      lastFailureKind: 'timeout',
      autoRetries: 1,
    };
    selectLimit.mockResolvedValueOnce([
      { pipelineHealth: { recoveryStats, retryCount: 0, lastError: null, updatedAt: '' } },
    ]);

    await publishSessionRecoveryChanged('p1', 's1');

    expect(publishSpy).toHaveBeenCalledWith('project:p1', {
      event: 'session.recoveryChanged',
      data: { sessionId: 's1', recoveryStats },
    });
  });

  it('falls back to DEFAULT_RECOVERY_STATS when pipelineHealth is null', async () => {
    selectLimit.mockResolvedValueOnce([{ pipelineHealth: null }]);

    await publishSessionRecoveryChanged('p1', 's1');

    const call = publishSpy.mock.calls[0]?.[1] as { data: { recoveryStats: unknown } };
    expect(call.data.recoveryStats).toEqual({
      totalFailures: 0,
      byKind: { transient: 0, permission: 0, permanent: 0, timeout: 0 },
      lastFailureAt: new Date(0).toISOString(),
      lastFailureKind: 'unknown',
      autoRetries: 0,
    });
  });

  it('no-op when session row vanished', async () => {
    selectLimit.mockResolvedValueOnce([]);
    await publishSessionRecoveryChanged('p1', 's1');
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
