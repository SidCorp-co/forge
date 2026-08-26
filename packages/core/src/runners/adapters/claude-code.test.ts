import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchInput } from '../types.js';

const publish = vi.fn((..._args: unknown[]) => 1);

vi.mock('../../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => publish(...args) },
}));

const selectLimit = vi.fn(async () => [] as Array<{ issSeq: number }>);
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => selectLimit() }) }),
    }),
  },
}));

const { claudeCodeAdapter } = await import('./claude-code.js');
const { deviceRoom } = await import('../../ws/rooms.js');
const { classifyBoxFault } = await import('../attribute-failure.js');

type Runner = DispatchInput['runner'];

function runner(over: Partial<Runner> = {}): Runner {
  return {
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
    limitReason: null,
    rateLimitedUntil: null,
    limitDetail: null,
    quarantinedUntil: null,
    quarantineReason: null,
    ...over,
  };
}

describe('claude-code adapter', () => {
  beforeEach(() => {
    publish.mockClear();
    publish.mockReturnValue(1);
  });

  // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/dispatch.rs — without `issueKey` the runner declines to salvage a failed job's working copy at all (it cannot tell this job's checkout from a stale one), so dropping this field disables L1 with nothing going red.
  it('forwards issueKey so a failed job can have its working copy salvaged', async () => {
    selectLimit.mockResolvedValueOnce([{ issSeq: 862 }]);
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-9',
        projectId: 'p-1',
        issueId: 'i-1',
        attempts: 3,
        type: 'code',
        payload: {},
        dispatchedAt: new Date('2026-04-26T00:00:00.000Z'),
      },
      runner: runner(),
    });
    const data = (publish.mock.calls[0]?.[1] as { data: Record<string, unknown> }).data;
    expect(data.issueKey).toBe('ISS-862');
    expect(data.attempts).toBe(3);
  });

  it('omits issueKey rather than failing the dispatch when the lookup throws', async () => {
    selectLimit.mockRejectedValueOnce(new Error('db down'));
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-10',
        projectId: 'p-1',
        issueId: 'i-1',
        attempts: 1,
        type: 'code',
        payload: {},
        dispatchedAt: new Date('2026-04-26T00:00:00.000Z'),
      },
      runner: runner(),
    });
    expect(result.status).toBe('dispatched');
    const data = (publish.mock.calls[0]?.[1] as { data: Record<string, unknown> }).data;
    expect(data.issueKey).toBeUndefined();
  });

  it('publishes job.assigned to the device room and returns dispatched', async () => {
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-1',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        type: 'code',
        payload: { prompt: 'hi' },
        dispatchedAt: new Date('2026-04-26T00:00:00.000Z'),
      },
      runner: runner(),
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
        attempts: 1,
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
        agentSessionId: 'sess-abc',
      },
      runner: runner(),
    });
    const call = publish.mock.calls[0];
    const data = (call?.[1] as { data: { agentSessionId?: string } }).data;
    expect(data.agentSessionId).toBe('sess-abc');
  });

  it('forwards systemPrompt in the WS payload when provided', async () => {
    const sp = '## Pipeline Rules\n- Status LAST.';
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-sp',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        type: 'code',
        payload: {},
        promptString: '/forge-code iss-1',
        systemPrompt: sp,
        dispatchedAt: new Date(),
      },
      runner: runner(),
    });
    const data = (publish.mock.calls[0]?.[1] as { data: { systemPrompt?: string } }).data;
    expect(data.systemPrompt).toBe(sp);
  });

  it('publishes systemPrompt as null when not provided', async () => {
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-no-sp',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: runner(),
    });
    const data = (publish.mock.calls[0]?.[1] as { data: { systemPrompt?: unknown } }).data;
    expect(data.systemPrompt).toBeNull();
  });

  it('omits agentSessionId from the payload when not provided', async () => {
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-1',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: runner(),
    });
    const call = publish.mock.calls[0];
    const data = (call?.[1] as { data: Record<string, unknown> }).data;
    expect('agentSessionId' in data).toBe(false);
  });

  // cm:why the frame is the only delivery — the runner has no catch-up fetch — so reporting `dispatched` for 0 subscribers spends a runner slot on a job that can only die at the ack reaper, and since ISS-862 counts those toward quarantine it would set aside every runner on a project during a core-side WS fault
  it('reports failed, not dispatched, when the frame reached no open socket', async () => {
    publish.mockReturnValueOnce(0);
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-undelivered',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: runner(),
    });
    expect(result.status).toBe('failed');
    expect(result.errorReason).toContain('0 subscribers');
  });

  // cm:guard this string must stay unrecognisable to `classifyBoxFault` (attribute-failure.ts) — an undelivered dispatch is as likely to be core's websocket as the box's, so it must NOT extend a quarantine streak; the moment it reads `dispatch_unclaimed` or starts `preflight_failed:` this whole fix inverts into the fleet-wide quarantine it exists to prevent
  it('names the undelivered dispatch in words quarantine does not count', async () => {
    publish.mockReturnValueOnce(0);
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-undelivered-2',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: runner(),
    });
    expect(classifyBoxFault(result.errorReason ?? null)).toBeNull();
  });

  it('returns failed when runner has no deviceId', async () => {
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-2',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: runner({ id: 'r-2', deviceId: null, name: 'orphan', lastSeenAt: null }),
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
      runner: runner({ id: 'r-3', name: 'old', lastSeenAt: new Date(Date.now() - 200_000) }),
    });
    expect(r.ok).toBe(false);
  });
});
