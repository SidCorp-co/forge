/**
 * ISS-888 item 4 — the seam-test axis, second of the two seams the record names.
 *
 * Lives apart from `dispatcher.test.ts` deliberately: that file is at its frozen
 * size budget, and a seam assertion is a different kind of test from the
 * dispatch-envelope cases next door. It shares their mock harness because the
 * joint is only observable through the real caller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));

vi.mock('../db/client.js', () => {
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ limit: async () => [] as Record<string, unknown>[] }) }),
  }));
  const update = vi.fn();
  const execute = vi.fn(async () => [{ count: '0' }]);
  return {
    db: { select, update, execute },
  };
});

vi.mock('../runners/select.js', () => ({
  selectRunnerForJob: vi.fn(),
  defaultRunnerCapabilities: vi.fn((_t: string, p?: Record<string, unknown>) => p ?? {}),
  getTrippedDeviceIds: vi.fn(async () => [] as string[]),
}));

vi.mock('../runners/registry.js', () => ({
  getRunnerAdapter: vi.fn(),
}));

vi.mock('../pipeline/resolve-step-runner.js', () => ({
  resolveRunnerChainForJob: vi.fn(() => []),
}));

vi.mock('../queue/boss.js', () => ({
  boss: {
    createQueue: vi.fn(async () => {}),
    work: vi.fn(async () => 'worker-id-1'),
    offWork: vi.fn(async () => {}),
    send: vi.fn(async () => 'msg-1'),
    schedule: vi.fn(async () => {}),
  },
}));

vi.mock('../ws/server.js', () => ({
  roomManager: {
    publish: vi.fn(() => 0),
  },
}));

vi.mock('./agent-session-link.js', () => ({
  ensureAgentSessionForJob: vi.fn(async () => 'sess-test'),
}));

vi.mock('./prompt-snapshot.js', () => ({
  persistPromptSnapshot: vi.fn(async () => {}),
}));

vi.mock('./dispatch-gates.js', () => ({
  runnerSupportsJobType: vi.fn(() => true),
  assertDispatchable: vi.fn(async () => ({ ok: true })),
  resolveProjectCap: vi.fn(async () => 1),
  claimRunnerSlot: vi.fn(async () => 'claimed'),
}));

vi.mock('../observability/sentry.js', () => ({
  Sentry: { addBreadcrumb: vi.fn() },
  isSentryEnabled: () => false,
}));
vi.mock('../observability/hold-metrics.js', () => ({
  recordRunnerDeathDetection: vi.fn(),
  recordDispatchBarrierSkip: vi.fn(),
  recordResumeDrop: vi.fn(),
}));

vi.mock('../integrations/postman/resolver.js', () => ({
  applyPostmanMcpServers: vi.fn(
    async (_projectId: string, current: Record<string, unknown> | null) => current,
  ),
}));
vi.mock('../integrations/epodsystem/resolver.js', () => ({
  applyEpodsystemMcpServers: vi.fn(
    async (_projectId: string, current: Record<string, unknown> | null) => current,
  ),
}));
vi.mock('../integrations/sentry/resolver.js', () => ({
  applySentryMcpServers: vi.fn(
    async (_projectId: string, current: Record<string, unknown> | null) => current,
  ),
}));

vi.mock('./session-resume.js', () => ({
  findPriorSessionInGroup: vi.fn(async () => null),
  loadResumeBounds: vi.fn(async () => ({ maxResumeTokens: 150_000, maxResumeReopenCycles: 3 })),
  estimateGroupContextTokens: vi.fn(async () => 0),
}));

const { db } = await import('../db/client.js');
const { handleDispatch } = await import('./dispatcher.js');
const { selectRunnerForJob } = await import('../runners/select.js');
const { getRunnerAdapter } = await import('../runners/registry.js');
const { findPriorSessionInGroup, estimateGroupContextTokens } = await import('./session-resume.js');
const { recordResumeDrop } = await import('../observability/hold-metrics.js');
const { ensureAgentSessionForJob } = await import('./agent-session-link.js');

type Row = Record<string, unknown>;

function mockSelectOnce(rows: Row[]): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
  (db as any).select.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({ limit: async () => rows }),
    }),
  }));
}

function mockUpdateReturn(rows: Row[]): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
  (db as any).update.mockImplementationOnce(() => ({
    set: () => ({
      where: () => ({ returning: async () => rows }),
    }),
  }));
}

function mockRunnerDispatch(opts: { deviceId?: string } = {}): ReturnType<typeof vi.fn> {
  (selectRunnerForJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    id: 'r1',
    type: 'claude-code',
    deviceId: opts.deviceId ?? 'd1',
  });
  const dispatchSpy = vi.fn(async (..._args: unknown[]) => ({ status: 'dispatched' }));
  (getRunnerAdapter as ReturnType<typeof vi.fn>).mockReturnValueOnce({ dispatch: dispatchSpy });
  return dispatchSpy;
}

const agentConfigWithGroup = {
  pipelineConfig: {
    sessionGroups: { build: ['approved'] },
    states: { approved: { sessionGroup: 'build' } },
  },
};

describe('ISS-888 seam — resume policy <-> device selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    (db as any).update.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * ISS-888 item 4, seam 2 of 2 — `resume-policy` <-> device selection.
   *
   * Both halves are covered on their own: `resume-policy.test.ts` pins
   * `finalizeResumeForDevice` across every drop reason, and `select.test.ts`
   * pins the picker falling through a pin it cannot honour. Neither can see the
   * coupling, which is an ORDER: the resume is provisional until a device is
   * known, so the finalize must sit between selection and the session row that
   * records the answer. Move it either way and both suites stay green while a
   * dispatch claims a continuation it never had.
   *
   * This asserts the joint at its three observable exits — the counter, the
   * durable record, and what the runner is actually told.
   */
  it('ISS-888: selection falling through a stale pin drops the resume everywhere it is recorded', async () => {
    mockSelectOnce([
      {
        id: 'j-seam',
        status: 'queued',
        projectId: 'p1',
        issueId: 'iss-1',
        type: 'code',
        payload: { stageStatus: 'approved' },
      },
    ]);
    mockSelectOnce([{ agentConfig: agentConfigWithGroup }]);
    mockSelectOnce([{ agentConfig: null }]);
    mockSelectOnce([{ agentConfig: agentConfigWithGroup }]);
    (findPriorSessionInGroup as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      claudeSessionId: 'cli-old',
      deviceId: 'd-old',
    });
    (estimateGroupContextTokens as ReturnType<typeof vi.fn>).mockResolvedValueOnce(50_000);
    mockSelectOnce([{ reopenCount: 0 }]);
    const dispatchSpy = mockRunnerDispatch({ deviceId: 'd-other' });
    mockUpdateReturn([{ id: 'j-seam' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    expect(await handleDispatch({ jobId: 'j-seam' })).toBe('dispatched');

    expect(recordResumeDrop).toHaveBeenCalledWith('pin_stale');

    const sessionArgs = (ensureAgentSessionForJob as ReturnType<typeof vi.fn>).mock.lastCall;
    expect(sessionArgs?.[1]).toMatchObject({
      resume: { resumed: false, dropReason: 'pin_stale', priorClaudeSessionId: 'cli-old' },
    });

    // cm:guard the runner payload is the half a record-only assertion cannot see: `agent_sessions` could say `resumed:false` while `claudeSessionId` still rode out to the box, and the runner would `--resume` onto a file that is not there — losing the whole attempt while the row claims the loss was already handled.
    const dispatched = dispatchSpy.mock.lastCall?.[0] as
      | { job: { payload: Record<string, unknown> } }
      | undefined;
    expect(dispatched).toBeDefined();
    expect(dispatched?.job.payload).not.toHaveProperty('claudeSessionId');
  });
});
