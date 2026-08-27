import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));

const selectQueue: Array<Array<Record<string, unknown>>> = [];
vi.mock('../db/client.js', () => {
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ limit: async () => selectQueue.shift() ?? [] }) }),
  }));
  return { db: { select } };
});

vi.mock('../runners/select.js', () => ({
  getTrippedDeviceIds: vi.fn(async () => [] as string[]),
}));

vi.mock('./session-resume.js', () => ({
  findPriorSessionInGroup: vi.fn(async () => null),
  estimateGroupContextTokens: vi.fn(async () => 0),
  loadResumeBounds: vi.fn(async () => ({ maxResumeTokens: 0, maxResumeReopenCycles: 0 })),
}));

vi.mock('../observability/hold-metrics.js', () => ({ recordResumeBoundFresh: vi.fn() }));
vi.mock('../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: vi.fn() },
}));

const { resolveResumePolicy } = await import('./resume-policy.js');

type Job = Parameters<typeof resolveResumePolicy>[0]['job'];

/** A retry job that just ran on `ranOn`, whose rotation targets `target`. */
function retryJob(over: {
  ranOn: string | null;
  target: string | null;
  failureAction?: string | null;
}): Job {
  return {
    id: 'job-child',
    projectId: 'p1',
    issueId: 'iss-1',
    type: 'code',
    retryOf: 'job-parent',
    deviceId: over.ranOn,
    failureAction: over.failureAction ?? 'retry',
    payload: { _autoRetry: { round: 1, target: over.target, tries: 1, done: [] } },
  } as unknown as Job;
}

const NO_OVERRIDES = { sessionGroup: null, deviceIds: null } as never;

/** Queue the two rows `findParentAttemptSession` reads: parent job, then its session. */
function parentHasSession(claudeSessionId: string) {
  selectQueue.push([{ agentSessionId: 'sess-parent' }]);
  selectQueue.push([{ claudeSessionId, deviceId: 'dev-a' }]);
}

describe('resolveResumePolicy — retry resume window', () => {
  beforeEach(() => {
    selectQueue.length = 0;
  });

  it('resumes the parent attempt when the rotation kept the same box', async () => {
    parentHasSession('claude-abc');
    const out = await resolveResumePolicy({
      job: retryJob({ ranOn: 'dev-a', target: 'dev-a' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.isRetry).toBe(true);
    expect(out.pinDeviceId).toBe('dev-a');
    expect(out.priorClaudeSessionId).toBe('claude-abc');
  });

  it('does not resume when the rotation moved to another box', async () => {
    parentHasSession('claude-abc');
    const out = await resolveResumePolicy({
      job: retryJob({ ranOn: 'dev-a', target: 'dev-b' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.pinDeviceId).toBe('dev-b');
    expect(out.priorClaudeSessionId).toBeNull();
  });

  it.each(['failover', 'quarantine', 'terminal'])(
    'does not resume a same-box retry when the failure action is %s',
    async (action) => {
      parentHasSession('claude-abc');
      const out = await resolveResumePolicy({
        job: retryJob({ ranOn: 'dev-a', target: 'dev-a', failureAction: action }),
        overrides: NO_OVERRIDES,
        agentConfig: undefined,
      });
      expect(out.priorClaudeSessionId).toBeNull();
    },
  );

  it('does not resume when the parent attempt recorded no CLI session', async () => {
    selectQueue.push([{ agentSessionId: 'sess-parent' }]);
    selectQueue.push([{ claudeSessionId: null, deviceId: 'dev-a' }]);
    const out = await resolveResumePolicy({
      job: retryJob({ ranOn: 'dev-a', target: 'dev-a' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.priorClaudeSessionId).toBeNull();
  });

  it('drops a rotation target that falls outside the stage pool, and the resume with it', async () => {
    parentHasSession('claude-abc');
    const out = await resolveResumePolicy({
      job: retryJob({ ranOn: 'dev-a', target: 'dev-a' }),
      overrides: { sessionGroup: null, deviceIds: ['dev-pool'] } as never,
      agentConfig: undefined,
    });
    expect(out.pinDeviceId).toBeNull();
    expect(out.priorClaudeSessionId).toBeNull();
  });

  it('excludes the devices already done this round and skips the primary pin', async () => {
    const job = retryJob({ ranOn: 'dev-a', target: 'dev-b' });
    (job as unknown as { payload: Record<string, unknown> }).payload = {
      _autoRetry: { round: 1, target: 'dev-b', tries: 1, done: ['dev-a'] },
    };
    const out = await resolveResumePolicy({
      job,
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.skipPrimary).toBe(true);
    expect(out.excludeDeviceIds).toEqual(['dev-a']);
  });
});
