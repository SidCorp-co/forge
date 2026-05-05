import { describe, expect, it, vi, beforeEach } from 'vitest';

const publish = vi.fn(() => 0);

vi.mock('../../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => publish(...args) },
}));

vi.mock('../../db/client.js', () => ({
  db: {},
}));

const { claudeCodeAdapter } = await import('./claude-code.js');
const { deviceRoom } = await import('../../ws/rooms.js');

describe('claude-code adapter', () => {
  beforeEach(() => {
    publish.mockClear();
  });

  it('publishes job.assigned to the device room and returns dispatched', async () => {
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-1',
        projectId: 'p-1',
        issueId: null,
        type: 'code',
        payload: { prompt: 'hi' },
        dispatchedAt: new Date('2026-04-26T00:00:00.000Z'),
      },
      runner: {
        id: 'r-1',
        projectId: 'p-1',
        type: 'claude-code',
        host: 'device',
        deviceId: 'd-1',
        name: 'desk',
        labels: [],
        capabilities: {},
        config: {},
        status: 'online',
        lastSeenAt: new Date(),
        lastError: null,
      },
    });
    expect(result.status).toBe('dispatched');
    expect(publish).toHaveBeenCalledTimes(1);
    const call = publish.mock.calls[0];
    expect(call?.[0]).toBe(deviceRoom('d-1'));
    expect((call?.[1] as { event: string }).event).toBe('job.assigned');
  });

  it('forwards agentSessionId in the WS payload when provided', async () => {
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-1',
        projectId: 'p-1',
        issueId: null,
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
        agentSessionId: 'sess-abc',
      },
      runner: {
        id: 'r-1',
        projectId: 'p-1',
        type: 'claude-code',
        host: 'device',
        deviceId: 'd-1',
        name: 'desk',
        labels: [],
        capabilities: {},
        config: {},
        status: 'online',
        lastSeenAt: new Date(),
        lastError: null,
      },
    });
    const call = publish.mock.calls[0];
    const data = (call?.[1] as { data: { agentSessionId?: string } }).data;
    expect(data.agentSessionId).toBe('sess-abc');
  });

  it('omits agentSessionId from the payload when not provided', async () => {
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-1',
        projectId: 'p-1',
        issueId: null,
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: {
        id: 'r-1',
        projectId: 'p-1',
        type: 'claude-code',
        host: 'device',
        deviceId: 'd-1',
        name: 'desk',
        labels: [],
        capabilities: {},
        config: {},
        status: 'online',
        lastSeenAt: new Date(),
        lastError: null,
      },
    });
    const call = publish.mock.calls[0];
    const data = (call?.[1] as { data: Record<string, unknown> }).data;
    expect('agentSessionId' in data).toBe(false);
  });

  it('returns failed when runner has no deviceId', async () => {
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-2',
        projectId: 'p-1',
        issueId: null,
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: {
        id: 'r-2',
        projectId: 'p-1',
        type: 'claude-code',
        host: 'device',
        deviceId: null,
        name: 'orphan',
        labels: [],
        capabilities: {},
        config: {},
        status: 'online',
        lastSeenAt: null,
        lastError: null,
      },
    });
    expect(result.status).toBe('failed');
    expect(publish).not.toHaveBeenCalled();
  });

  it('validateConfig accepts empty config and rejects unknown keys', () => {
    expect(claudeCodeAdapter.validateConfig({}).ok).toBe(true);
    const r = claudeCodeAdapter.validateConfig({ skillsDir: '/tmp', bogus: 1 });
    expect(r.ok).toBe(false);
  });

  it('health reports stale when lastSeenAt is too old', async () => {
    const r = await claudeCodeAdapter.health({
      runner: {
        id: 'r-3',
        projectId: 'p-1',
        type: 'claude-code',
        host: 'device',
        deviceId: 'd-1',
        name: 'old',
        labels: [],
        capabilities: {},
        config: {},
        status: 'online',
        lastSeenAt: new Date(Date.now() - 200_000),
        lastError: null,
      },
    });
    expect(r.ok).toBe(false);
  });
});
