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
  estimateIssueContextTokens: vi.fn(async () => 0),
  loadResumeBounds: vi.fn(async () => ({ maxResumeTokens: 0, maxResumeReopenCycles: 0 })),
}));

vi.mock('../observability/hold-metrics.js', () => ({ recordResumeDrop: vi.fn() }));
vi.mock('../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: vi.fn() },
}));

const { resolveResumePolicy, finalizeResumeForDevice } = await import('./resume-policy.js');
const { recordResumeDrop } = await import('../observability/hold-metrics.js');
const { estimateIssueContextTokens, loadResumeBounds } = await import('./session-resume.js');

type Job = Parameters<typeof resolveResumePolicy>[0]['job'];

/**
 * The dispatcher's real sequence: propose a policy, then settle it against the device selection
 * actually returned. `selected` defaults to the proposed pin — the selector honoured it — so a
 * test that says nothing about selection is asserting the honoured-pin path on purpose.
 */
async function resolve(args: Parameters<typeof resolveResumePolicy>[0], selected?: string | null) {
  const proposed = await resolveResumePolicy(args);
  return finalizeResumeForDevice(
    proposed,
    selected === undefined ? proposed.pinDeviceId : selected,
  );
}

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

const NO_OVERRIDES = { deviceIds: null } as never;

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
  vi.mocked(estimateIssueContextTokens).mockResolvedValue(0);
  vi.mocked(loadResumeBounds).mockResolvedValue({
    maxResumeTokens: 0,
    maxResumeReopenCycles: 0,
  });
});

describe('resolveResumePolicy — retry resume window', () => {
  it('resumes the parent attempt when the rotation kept it on the parent box', async () => {
    parentAttempt({});
    const out = await resolve({
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
    const out = await resolve({
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
      const out = await resolve({
        job: retryJob({ target: 'dev-a' }),
        overrides: NO_OVERRIDES,
        agentConfig: undefined,
      });
      expect(out.priorClaudeSessionId).toBeNull();
    },
  );

  it('does not resume when the parent attempt recorded no CLI session', async () => {
    parentAttempt({ claudeSessionId: null });
    const out = await resolve({
      job: retryJob({ target: 'dev-a' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.priorClaudeSessionId).toBeNull();
  });

  it('drops a rotation target that falls outside the stage pool, and the resume with it', async () => {
    parentAttempt({});
    const out = await resolve({
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
    const out = await resolve({
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
    const out = await resolve({
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
    const out = await resolve({
      job: retryJob({ target: 'dev-a' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });
    expect(out.record.dropReason).toBe('failure_action');
    expect(recordResumeDrop).toHaveBeenCalledWith('failure_action');
  });

  it('records NOTHING when there was no prior session to continue — attempt 1 is not a loss', async () => {
    const out = await resolve({
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
    const out = await resolve({
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
    const out = await resolve({
      job: retryJob({ target: 'dev-a' }),
      overrides: { sessionGroup: null, deviceIds: ['dev-pool'] } as never,
      agentConfig: undefined,
    });
    expect(out.record.dropReason).toBe('stage_pool');
    expect(recordResumeDrop).toHaveBeenCalledWith('stage_pool');
  });
});

// cm:guard a FIRST dispatch is not a loss and must record nothing. The (issue, sessionGroup) lookup that gave attempt 1 something to continue left with `pipelineConfig.sessionGroups` in ISS-897, so there is no offer here to drop — and `ResumeDropReason` must not regrow a member that names a loss nothing on this path can suffer.
describe('resolveResumePolicy — a first dispatch has nothing to drop', () => {
  const firstDispatch = {
    id: 'j1',
    projectId: 'p1',
    issueId: 'iss-1',
    type: 'code',
    retryOf: null,
    payload: {},
  } as Job;

  it('records NOTHING even when the breaker trips every device', async () => {
    trippedDeviceIds.mockResolvedValue(['dev-a', 'dev-x']);

    const out = await resolve({
      job: firstDispatch,
      overrides: { deviceIds: null } as never,
      agentConfig: undefined,
    });

    expect(out.record.dropReason).toBeNull();
    expect(out.record.priorClaudeSessionId).toBeNull();
    expect(out.record.resumed).toBe(false);
    expect(recordResumeDrop).not.toHaveBeenCalled();
  });

  it('records NOTHING even under a bound that a retry would have tripped', async () => {
    vi.mocked(loadResumeBounds).mockResolvedValue({
      maxResumeTokens: 150_000,
      maxResumeReopenCycles: 3,
    });
    vi.mocked(estimateIssueContextTokens).mockResolvedValue(363_000);

    const out = await resolve({
      job: firstDispatch,
      overrides: { deviceIds: ['dev-pool'] } as never,
      agentConfig: undefined,
    });

    expect(out.record.dropReason).toBeNull();
    expect(recordResumeDrop).not.toHaveBeenCalled();
  });
});

// cm:guard the bounds apply to the RETRY path and must keep applying there — it is the one path that still has a transcript to continue, so a bound that stopped being read would let an attempt resume past the peak that already forced a compaction.
describe('resolveResumePolicy — the bounds a retry is judged against', () => {
  it('names the token bound when the issue outgrew maxResumeTokens', async () => {
    vi.mocked(loadResumeBounds).mockResolvedValue({
      maxResumeTokens: 150_000,
      maxResumeReopenCycles: 3,
    });
    vi.mocked(estimateIssueContextTokens).mockResolvedValue(363_000);
    parentAttempt({ ranOn: 'dev-a' });
    selectQueue.push([{ reopenCount: 0 }]);

    const out = await resolve({
      job: retryJob({ target: 'dev-a' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });

    expect(out.record.dropReason).toBe('resume_bound_tokens');
    expect(out.pinDeviceId).toBeNull();
    expect(recordResumeDrop).toHaveBeenCalledWith('resume_bound_tokens');
  });

  it('names the reopen bound when the token bound holds but the cycles do not', async () => {
    vi.mocked(loadResumeBounds).mockResolvedValue({
      maxResumeTokens: 150_000,
      maxResumeReopenCycles: 3,
    });
    vi.mocked(estimateIssueContextTokens).mockResolvedValue(1_000);
    parentAttempt({ ranOn: 'dev-a' });
    selectQueue.push([{ reopenCount: 4 }]);

    const out = await resolve({
      job: retryJob({ target: 'dev-a' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });

    expect(out.record.dropReason).toBe('resume_bound_reopen_cycles');
  });

  it('BOUNDARY: exactly AT both bounds still resumes and records nothing', async () => {
    vi.mocked(loadResumeBounds).mockResolvedValue({
      maxResumeTokens: 150_000,
      maxResumeReopenCycles: 3,
    });
    vi.mocked(estimateIssueContextTokens).mockResolvedValue(150_000);
    parentAttempt({ ranOn: 'dev-a' });
    selectQueue.push([{ reopenCount: 3 }]);

    const out = await resolve({
      job: retryJob({ target: 'dev-a' }),
      overrides: NO_OVERRIDES,
      agentConfig: undefined,
    });

    expect(out.record.resumed).toBe(true);
    expect(out.record.dropReason).toBeNull();
    expect(recordResumeDrop).not.toHaveBeenCalled();
  });
});

describe('ISS-887 finalizeResumeForDevice — a pin the selector did not honour', () => {
  it('drops the resume as `pin_stale` when selection landed on a different box', async () => {
    parentAttempt({ ranOn: 'dev-a' });
    const out = await resolve(
      { job: retryJob({ target: 'dev-a' }), overrides: NO_OVERRIDES, agentConfig: undefined },
      'dev-b',
    );
    expect(out.priorClaudeSessionId).toBeNull();
    expect(out.record.resumed).toBe(false);
    expect(out.record.dropReason).toBe('pin_stale');
    expect(recordResumeDrop).toHaveBeenCalledTimes(1);
    expect(recordResumeDrop).toHaveBeenCalledWith('pin_stale');
  });

  it('still reports the session it was offered, so the loss is readable', async () => {
    parentAttempt({ ranOn: 'dev-a' });
    const out = await resolve(
      { job: retryJob({ target: 'dev-a' }), overrides: NO_OVERRIDES, agentConfig: undefined },
      'dev-b',
    );
    expect(out.record.priorClaudeSessionId).toBe('claude-abc');
    expect(out.record.priorDeviceId).toBe('dev-a');
  });

  it('keeps the resume when selection honoured the pin', async () => {
    parentAttempt({ ranOn: 'dev-a' });
    const out = await resolve(
      { job: retryJob({ target: 'dev-a' }), overrides: NO_OVERRIDES, agentConfig: undefined },
      'dev-a',
    );
    expect(out.priorClaudeSessionId).toBe('claude-abc');
    expect(out.record.dropReason).toBeNull();
    expect(recordResumeDrop).not.toHaveBeenCalled();
  });

  it('does not relabel an EARLIER drop as `pin_stale` — the first reason is the true one', async () => {
    parentAttempt({ ranOn: 'dev-a', failureAction: 'failover' });
    const out = await resolve(
      { job: retryJob({ target: 'dev-a' }), overrides: NO_OVERRIDES, agentConfig: undefined },
      'dev-b',
    );
    expect(out.record.dropReason).toBe('failure_action');
    expect(recordResumeDrop).toHaveBeenCalledTimes(1);
    expect(recordResumeDrop).toHaveBeenCalledWith('failure_action');
  });

  it('counts nothing when there was no prior session, however the selection landed', async () => {
    parentAttempt({ claudeSessionId: null });
    const out = await resolve(
      { job: retryJob({ target: 'dev-a' }), overrides: NO_OVERRIDES, agentConfig: undefined },
      'dev-b',
    );
    expect(out.record.dropReason).toBeNull();
    expect(out.record.priorClaudeSessionId).toBeNull();
    expect(recordResumeDrop).not.toHaveBeenCalled();
  });
});

// cm:guard `reachable` demands PROOF — both ids non-null AND equal — and these call the pure function directly BECAUSE no policy resolver reaches it any more: on the retry path a null pin is already dropped as `rotation`, and a first dispatch is offered nothing. That makes this the only place the null-pin arm is exercised at all, and deleting it leaves the arm untested the day a caller constructs a policy by hand.
describe('finalizeResumeForDevice — an offer with no pin is not a reachable session', () => {
  const offered = (pinDeviceId: string | null) =>
    ({
      priorClaudeSessionId: 'cli-old',
      pinDeviceId,
      excludeDeviceIds: [],
      skipPrimary: false,
      isRetry: false,
      record: {
        resumed: true,
        dropReason: null,
        priorClaudeSessionId: 'cli-old',
        priorDeviceId: null,
        pinDeviceId,
        failureAction: null,
      },
    }) as Parameters<typeof finalizeResumeForDevice>[0];

  it('drops an offer carried on a null pin, however the selection landed', () => {
    const out = finalizeResumeForDevice(offered(null), 'dev-anywhere');

    expect(out.priorClaudeSessionId).toBeNull();
    expect(out.record.dropReason).toBe('pin_stale');
    expect(recordResumeDrop).toHaveBeenCalledWith('pin_stale');
  });

  it('drops it when NEITHER side names a box — two unknowns are not a match', () => {
    const out = finalizeResumeForDevice(offered(null), null);

    expect(out.priorClaudeSessionId).toBeNull();
    expect(out.record.dropReason).toBe('pin_stale');
  });

  it('keeps it when the pin and the selection are the same box', () => {
    const out = finalizeResumeForDevice(offered('dev-a'), 'dev-a');

    expect(out.priorClaudeSessionId).toBe('cli-old');
    expect(out.record.dropReason).toBeNull();
    expect(recordResumeDrop).not.toHaveBeenCalled();
  });
});
