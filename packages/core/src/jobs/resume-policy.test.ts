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

const trippedDeviceIds = vi.fn(async () => [] as string[]);
vi.mock('../runners/select.js', () => ({ getTrippedDeviceIds: trippedDeviceIds }));

vi.mock('./session-resume.js', () => ({
  findPriorSessionInGroup: vi.fn(async () => null),
  estimateGroupContextTokens: vi.fn(async () => 0),
  loadResumeBounds: vi.fn(async () => ({ maxResumeTokens: 0, maxResumeReopenCycles: 0 })),
}));

vi.mock('../observability/hold-metrics.js', () => ({ recordResumeDrop: vi.fn() }));
vi.mock('../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: vi.fn() },
}));

const { resolveResumePolicy } = await import('./resume-policy.js');
const { recordResumeDrop } = await import('../observability/hold-metrics.js');
const { findPriorSessionInGroup, estimateGroupContextTokens, loadResumeBounds } = await import(
  './session-resume.js'
);

type Job = Parameters<typeof resolveResumePolicy>[0]['job'];

/**
 * A queued retry clone, shaped the way `retry.ts` actually writes one: `deviceId` is NULL
 * (claimRunnerSlot stamps it only at dispatch) and `failureAction` is NULL (the clone copies
 * neither column). Both truths live on the PARENT rows, queued by `parentAttempt`.
 */
function retryJob(over: { target: string | null }): Job {
  return {
    id: 'job-child',
    projectId: 'p1',
    issueId: 'iss-1',
    type: 'code',
    retryOf: 'job-parent',
    deviceId: null,
    failureAction: null,
    payload: { _autoRetry: { round: 1, target: over.target, tries: 1, done: [] } },
  } as unknown as Job;
}

const NO_OVERRIDES = { sessionGroup: null, deviceIds: null } as never;

/** Queue the two rows `loadParentAttempt` reads: the parent job, then its session. */
function parentAttempt(over: {
  claudeSessionId?: string | null;
  ranOn?: string | null;
  failureAction?: string | null;
}) {
  selectQueue.push([
    { agentSessionId: 'sess-parent', failureAction: over.failureAction ?? 'retry' },
  ]);
  selectQueue.push([
    {
      claudeSessionId: over.claudeSessionId === undefined ? 'claude-abc' : over.claudeSessionId,
      deviceId: over.ranOn === undefined ? 'dev-a' : over.ranOn,
    },
  ]);
}

beforeEach(() => {
  selectQueue.length = 0;
  vi.mocked(recordResumeDrop).mockClear();
  trippedDeviceIds.mockResolvedValue([]);
  vi.mocked(findPriorSessionInGroup).mockResolvedValue(null);
  vi.mocked(estimateGroupContextTokens).mockResolvedValue(0);
  vi.mocked(loadResumeBounds).mockResolvedValue({
    maxResumeTokens: 0,
    maxResumeReopenCycles: 0,
  });
});

describe('resolveResumePolicy — retry resume window', () => {
  it('resumes the parent attempt when the rotation kept it on the parent box', async () => {
    parentAttempt({});
    const out = await resolveResumePolicy({
      job: retryJob({ target: 'dev-a' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.isRetry).toBe(true);
    expect(out.pinDeviceId).toBe('dev-a');
    expect(out.priorClaudeSessionId).toBe('claude-abc');
    expect(out.record.resumed).toBe(true);
    expect(out.record.dropReason).toBeNull();
    expect(recordResumeDrop).not.toHaveBeenCalled();
  });

  it('does not resume when the rotation moved to another box', async () => {
    parentAttempt({});
    const out = await resolveResumePolicy({
      job: retryJob({ target: 'dev-b' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.pinDeviceId).toBe('dev-b');
    expect(out.priorClaudeSessionId).toBeNull();
  });

  it.each(['failover', 'quarantine', 'terminal'])(
    'does not resume a same-box retry when the parent failure action is %s',
    async (action) => {
      parentAttempt({ failureAction: action });
      const out = await resolveResumePolicy({
        job: retryJob({ target: 'dev-a' }),
        overrides: NO_OVERRIDES,
        agentConfig: undefined,
      });
      expect(out.priorClaudeSessionId).toBeNull();
    },
  );

  it('does not resume when the parent attempt recorded no CLI session', async () => {
    parentAttempt({ claudeSessionId: null });
    const out = await resolveResumePolicy({
      job: retryJob({ target: 'dev-a' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.priorClaudeSessionId).toBeNull();
  });

  it('drops a rotation target that falls outside the stage pool, and the resume with it', async () => {
    parentAttempt({});
    const out = await resolveResumePolicy({
      job: retryJob({ target: 'dev-a' }),
      overrides: { sessionGroup: null, deviceIds: ['dev-pool'] } as never,
      agentConfig: undefined,
    });
    expect(out.pinDeviceId).toBeNull();
    expect(out.priorClaudeSessionId).toBeNull();
  });

  it('excludes the devices already done this round and skips the primary pin', async () => {
    const job = retryJob({ target: 'dev-b' });
    (job as unknown as { payload: Record<string, unknown> }).payload = {
      _autoRetry: { round: 1, target: 'dev-b', tries: 1, done: ['dev-a'] },
    };
    parentAttempt({});
    const out = await resolveResumePolicy({
      job,
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.skipPrimary).toBe(true);
    expect(out.excludeDeviceIds).toEqual(['dev-a']);
  });
});

describe('ISS-887 resolveResumePolicy — a start-from-scratch says so, and says why', () => {
  it('names `rotation` when a failover moves the retry off the parent box, and counts it once', async () => {
    parentAttempt({ ranOn: 'dev-a', failureAction: 'failover' });
    const out = await resolveResumePolicy({
      job: retryJob({ target: 'dev-b' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.record).toEqual({
      resumed: false,
      dropReason: 'rotation',
      priorClaudeSessionId: 'claude-abc',
      priorDeviceId: 'dev-a',
      pinDeviceId: 'dev-b',
      failureAction: 'failover',
    });
    expect(recordResumeDrop).toHaveBeenCalledTimes(1);
    expect(recordResumeDrop).toHaveBeenCalledWith('rotation');
  });

  it('names `failure_action`, not `rotation`, when the box was kept but the action forbids resuming', async () => {
    parentAttempt({ ranOn: 'dev-a', failureAction: 'failover' });
    const out = await resolveResumePolicy({
      job: retryJob({ target: 'dev-a' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.record.dropReason).toBe('failure_action');
    expect(recordResumeDrop).toHaveBeenCalledWith('failure_action');
  });

  it('records NOTHING when there was no prior session to continue — attempt 1 is not a loss', async () => {
    const out = await resolveResumePolicy({
      job: { id: 'j1', projectId: 'p1', issueId: 'iss-1', type: 'code', retryOf: null } as Job,
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.record).toEqual({
      resumed: false,
      dropReason: null,
      priorClaudeSessionId: null,
      priorDeviceId: null,
      pinDeviceId: null,
      failureAction: null,
    });
    expect(recordResumeDrop).not.toHaveBeenCalled();
  });

  it('records NOTHING when a retry parent held no CLI session — nothing was dropped', async () => {
    parentAttempt({ claudeSessionId: null });
    const out = await resolveResumePolicy({
      job: retryJob({ target: 'dev-b' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.record.dropReason).toBeNull();
    expect(out.record.priorClaudeSessionId).toBeNull();
    expect(recordResumeDrop).not.toHaveBeenCalled();
  });

  it('names `stage_pool` when the retry target is out of pool, outranking the rotation reason', async () => {
    parentAttempt({ ranOn: 'dev-a' });
    const out = await resolveResumePolicy({
      job: retryJob({ target: 'dev-a' }),
      overrides: { sessionGroup: null, deviceIds: ['dev-pool'] } as never,
      agentConfig: undefined,
    });
    expect(out.record.dropReason).toBe('stage_pool');
    expect(recordResumeDrop).toHaveBeenCalledWith('stage_pool');
  });
});

describe('ISS-887 resolveResumePolicy — first-dispatch drops name their own cause', () => {
  it('names `stage_pool` on a FIRST dispatch whose session-group pin is out of pool', async () => {
    vi.mocked(findPriorSessionInGroup).mockResolvedValue({
      claudeSessionId: 'cli-old',
      deviceId: 'dev-a',
    });
    const out = await resolveResumePolicy({
      job: {
        id: 'j1',
        projectId: 'p1',
        issueId: 'iss-1',
        type: 'code',
        retryOf: null,
        payload: {},
      } as Job,
      overrides: { sessionGroup: 'build', deviceIds: ['dev-pool'] } as never,
      agentConfig: undefined,
    });
    expect(out.record.dropReason).toBe('stage_pool');
    expect(out.record.priorClaudeSessionId).toBe('cli-old');
    expect(out.priorClaudeSessionId).toBeNull();
    expect(recordResumeDrop).toHaveBeenCalledWith('stage_pool');
  });

  it('names `device_tripped` when the circuit breaker excludes the session-group pin', async () => {
    vi.mocked(findPriorSessionInGroup).mockResolvedValue({
      claudeSessionId: 'cli-old',
      deviceId: 'dev-a',
    });
    trippedDeviceIds.mockResolvedValue(['dev-a']);
    const out = await resolveResumePolicy({
      job: {
        id: 'j1',
        projectId: 'p1',
        issueId: 'iss-1',
        type: 'code',
        retryOf: null,
        payload: {},
      } as Job,
      overrides: { sessionGroup: 'build', deviceIds: null } as never,
      agentConfig: undefined,
    });
    expect(out.record.dropReason).toBe('device_tripped');
    expect(recordResumeDrop).toHaveBeenCalledWith('device_tripped');
  });

  it('records NOTHING when the breaker trips a device no prior session was pinned to', async () => {
    trippedDeviceIds.mockResolvedValue(['dev-x']);
    const out = await resolveResumePolicy({
      job: {
        id: 'j1',
        projectId: 'p1',
        issueId: 'iss-1',
        type: 'code',
        retryOf: null,
        payload: {},
      } as Job,
      overrides: { sessionGroup: 'build', deviceIds: null } as never,
      agentConfig: undefined,
    });
    expect(out.record.dropReason).toBeNull();
    expect(recordResumeDrop).not.toHaveBeenCalled();
  });

  it('names the bound reason on a first dispatch that outgrew maxResumeTokens', async () => {
    vi.mocked(findPriorSessionInGroup).mockResolvedValue({
      claudeSessionId: 'cli-huge',
      deviceId: 'dev-a',
    });
    vi.mocked(loadResumeBounds).mockResolvedValue({
      maxResumeTokens: 150_000,
      maxResumeReopenCycles: 3,
    });
    vi.mocked(estimateGroupContextTokens).mockResolvedValue(363_000);
    selectQueue.push([{ reopenCount: 0 }]);
    const out = await resolveResumePolicy({
      job: {
        id: 'j1',
        projectId: 'p1',
        issueId: 'iss-1',
        type: 'code',
        retryOf: null,
        payload: {},
      } as Job,
      overrides: { sessionGroup: 'build', deviceIds: null } as never,
      agentConfig: undefined,
    });
    expect(out.record.dropReason).toBe('resume_bound_tokens');
    expect(out.pinDeviceId).toBeNull();
    expect(recordResumeDrop).toHaveBeenCalledWith('resume_bound_tokens');
  });

  it('BOUNDARY: a group exactly AT maxResumeTokens still resumes and records nothing', async () => {
    vi.mocked(findPriorSessionInGroup).mockResolvedValue({
      claudeSessionId: 'cli-edge',
      deviceId: 'dev-a',
    });
    vi.mocked(loadResumeBounds).mockResolvedValue({
      maxResumeTokens: 150_000,
      maxResumeReopenCycles: 3,
    });
    vi.mocked(estimateGroupContextTokens).mockResolvedValue(150_000);
    selectQueue.push([{ reopenCount: 3 }]);
    const out = await resolveResumePolicy({
      job: {
        id: 'j1',
        projectId: 'p1',
        issueId: 'iss-1',
        type: 'code',
        retryOf: null,
        payload: {},
      } as Job,
      overrides: { sessionGroup: 'build', deviceIds: null } as never,
      agentConfig: undefined,
    });
    expect(out.record.resumed).toBe(true);
    expect(out.record.dropReason).toBeNull();
    expect(recordResumeDrop).not.toHaveBeenCalled();
  });

  it('reports the group candidate it never considered as no loss at all on a retry', async () => {
    vi.mocked(findPriorSessionInGroup).mockResolvedValue({
      claudeSessionId: 'cli-group',
      deviceId: 'dev-pool',
    });
    parentAttempt({ ranOn: 'dev-a' });
    const out = await resolveResumePolicy({
      job: retryJob({ target: 'dev-a' }),
      overrides: { sessionGroup: 'build', deviceIds: null } as never,
      agentConfig: undefined,
    });
    expect(out.record.priorClaudeSessionId).toBe('claude-abc');
    expect(out.record.resumed).toBe(true);
    expect(recordResumeDrop).not.toHaveBeenCalled();
  });
});
