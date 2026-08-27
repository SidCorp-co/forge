import { beforeEach, describe, expect, it, vi } from 'vitest';

// Chainable mock that consumes one queued resolution (or rejects on an Error
// sentinel) per db.select() terminal — mirrors skill-mapping.test.ts /
// forge-step-start.test.ts. Deliberately does NOT mock skill-mapping.js /
// registry.js: resolveJobTypeForStatus must stay real so this test proves
// stage-genericity against the actual SSOT, not a stubbed mapping.
const queue: unknown[] = [];
// biome-ignore lint/suspicious/noExplicitAny: chainable mock proxy
const chain: any = {};
chain.from = () => chain;
chain.innerJoin = () => chain;
chain.where = () => chain;
chain.orderBy = () => chain;
chain.limit = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) => {
  const next = queue.shift();
  if (next instanceof Error) return Promise.reject(next).then(resolve, reject);
  return Promise.resolve(next ?? []).then(resolve, reject);
};

const selectSpy = vi.fn(() => chain);
const insertValues = vi.fn(async (_values?: unknown) => undefined);
const insertSpy = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => ({
  db: { select: selectSpy, insert: insertSpy },
}));

const pauseRunMock = vi.fn(async () => ({ id: 'run-1' }) as unknown);
// cm:edge contract -> packages/core/src/pipeline/run-pause.ts — a partial mock of that module must stub EVERY export this file's subject reaches; `pauseReasonFor` returning undefined silently produced `{stalled:false}` on four tests that assert a pause
vi.mock('./run-pause.js', () => ({
  pauseRun: (...a: unknown[]) => pauseRunMock(...(a as [])),
  pauseReasonFor: (kind: string, detail: string) => `${kind}:${detail}`,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  checkStageStallAndPause,
  STAGE_STALL_CAP,
  buildStageStalledReason,
  buildStageStalledCommentBody,
} = await import('./stage-stall-guard.js');

const PROJECT_ID = 'proj-1';
const ISSUE_ID = 'issue-1';
const RUN_ID = 'run-1';

function pushRunningRun(): void {
  queue.push([{ id: RUN_ID, status: 'running', currentStep: null, metadata: null }]);
}

beforeEach(() => {
  queue.length = 0;
  selectSpy.mockClear();
  insertSpy.mockClear();
  insertValues.mockClear();
  pauseRunMock.mockReset();
  pauseRunMock.mockResolvedValue({ id: RUN_ID });
});

describe('checkStageStallAndPause (ISS-631 — stage-genericity regression guard)', () => {
  it.each([
    { status: 'confirmed' as const, jobType: 'clarify' },
    { status: 'clarified' as const, jobType: 'plan' },
  ])(
    'pauses the run at STAGE_STALL_CAP done jobs for $status -> $jobType',
    async ({ status, jobType }) => {
      pushRunningRun();
      queue.push(Array.from({ length: STAGE_STALL_CAP }, () => ({ type: jobType })));
      queue.push([{ createdBy: 'owner-1' }]); // postStageStalledComment lookup

      const result = await checkStageStallAndPause({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        status,
      });

      expect(result).toEqual({ stalled: true });
      expect(pauseRunMock).toHaveBeenCalledTimes(1);
      expect(pauseRunMock).toHaveBeenCalledWith({
        runId: RUN_ID,
        pauseReason: buildStageStalledReason(status),
      });
      expect(insertValues).toHaveBeenCalledTimes(1);
      const commentArgs = insertValues.mock.calls[0]?.[0] as {
        issueId: string;
        authorId: string;
        body: string;
      };
      expect(commentArgs.issueId).toBe(ISSUE_ID);
      expect(commentArgs.authorId).toBe('owner-1');
      expect(commentArgs.body).toContain(`forge-${jobType}`);
    },
  );

  it.each([
    { status: 'confirmed' as const, jobType: 'clarify' },
    { status: 'clarified' as const, jobType: 'plan' },
  ])('does not pause below STAGE_STALL_CAP for $status', async ({ status, jobType }) => {
    pushRunningRun();
    queue.push(Array.from({ length: STAGE_STALL_CAP - 1 }, () => ({ type: jobType })));

    const result = await checkStageStallAndPause({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status,
    });

    expect(result).toEqual({ stalled: false });
    expect(pauseRunMock).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  // cm:why the ISS-801 wedge — `reopen` maps to `fix`, so a lifetime count made every issue that took >= 3 review->fix rounds impossible to reopen; a `test` job at the tail proves the stage advanced
  it('does not pause a reopened issue whose run already completed many fix rounds', async () => {
    pushRunningRun();
    queue.push([{ type: 'test' }, { type: 'review' }, { type: 'fix' }]);

    const result = await checkStageStallAndPause({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'reopen',
    });

    expect(result).toEqual({ stalled: false });
    expect(pauseRunMock).not.toHaveBeenCalled();
  });

  it('still pauses a genuine no-op loop on reopen (3 consecutive fix jobs, nothing between)', async () => {
    pushRunningRun();
    queue.push([{ type: 'fix' }, { type: 'fix' }, { type: 'fix' }]);
    queue.push([{ createdBy: 'owner-1' }]);

    const result = await checkStageStallAndPause({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'reopen',
    });

    expect(result).toEqual({ stalled: true });
    expect(pauseRunMock).toHaveBeenCalledWith({
      runId: RUN_ID,
      pauseReason: buildStageStalledReason('reopen'),
    });
  });

  it('returns stalled:false for a human-gated status without querying the db', async () => {
    const result = await checkStageStallAndPause({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'needs_info',
    });

    expect(result).toEqual({ stalled: false });
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('stays stalled (idempotent, no duplicate comment) when the run is already paused with a stage_stalled reason', async () => {
    queue.push([]); // no running run
    queue.push([{ metadata: { pauseReason: 'stage_stalled:confirmed' } }]); // paused-run lookup

    const result = await checkStageStallAndPause({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'confirmed',
    });

    expect(result).toEqual({ stalled: true });
    expect(pauseRunMock).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('returns stalled:false when no running run and the paused reason is unrelated', async () => {
    queue.push([]); // no running run
    queue.push([{ metadata: { pauseReason: 'missing_skill:confirmed' } }]);

    const result = await checkStageStallAndPause({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'confirmed',
    });

    expect(result).toEqual({ stalled: false });
  });

  it('fails open (stalled:false) when the db lookup rejects', async () => {
    queue.push(new Error('connection reset'));

    const result = await checkStageStallAndPause({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'confirmed',
    });

    expect(result).toEqual({ stalled: false });
  });

  it('names a device-specific unverified reason (not the generic no-device one) when the stalled jobs carry a deviceId', async () => {
    pushRunningRun();
    queue.push(
      Array.from({ length: STAGE_STALL_CAP }, () => ({
        type: 'clarify',
        deviceId: 'device-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      })),
    );
    queue.push([{ createdBy: 'owner-1' }]); // postStageStalledComment lookup

    const result = await checkStageStallAndPause({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'confirmed',
    });

    expect(result).toEqual({ stalled: true });
    const commentArgs = insertValues.mock.calls[0]?.[0] as { body: string };
    expect(commentArgs.body).toContain('Could not verify a cause');
    expect(commentArgs.body).toContain(
      'not a registered effective skill for the executing device(s)',
    );
    expect(commentArgs.body).not.toContain('no executing device is recorded');
  });
});

describe('buildStageStalledCommentBody (pure — ISS-822 cause-verification variants)', () => {
  const base = { stage: 'confirmed' as const, jobType: 'clarify', doneCount: 3 };
  const noState = {
    merged: 'no' as const,
    implementationRan: 'no' as const,
    stageProducedComment: 'no' as const,
  };

  it('names the skill with device+status evidence only when confirmed', () => {
    const body = buildStageStalledCommentBody({
      ...base,
      verification: {
        kind: 'confirmed',
        skillLabel: 'forge-clarify',
        evidence: [{ deviceId: 'dev-1', status: 'missing' }],
      },
      state: noState,
    });

    expect(body).toContain('Cause (verified):');
    expect(body).toContain('forge-clarify');
    expect(body).toContain('device `dev-1`: `missing`');
    expect(body).not.toContain('Most likely cause');
    expect(body).toContain('**Current state:**');
    expect(body).toContain('**Exits:**');
    expect(body).toContain('Resume the run');
    expect(body).toContain('close this issue');
  });

  it('lists causes unranked with no most-likely header when the skill sync is ruled out', () => {
    const body = buildStageStalledCommentBody({
      ...base,
      verification: { kind: 'ruled_out', skillLabel: 'forge-clarify', checkedDeviceCount: 2 },
      state: noState,
    });

    expect(body).toContain('ruled out');
    expect(body).toContain('unranked');
    expect(body).not.toContain('Most likely cause');
    expect(body).not.toContain('Cause (verified)');
    expect(body).toContain('**Current state:**');
    expect(body).toContain('**Exits:**');
  });

  it('says it could not verify, with the reason, when the check cannot run', () => {
    const reason = 'no executing device is recorded on the stalled jobs';
    const body = buildStageStalledCommentBody({
      ...base,
      verification: { kind: 'unverified', skillLabel: 'forge-clarify', reason },
      state: noState,
    });

    expect(body).toContain('Could not verify a cause');
    expect(body).toContain(reason);
    expect(body).toContain('unranked');
    expect(body).not.toContain('Most likely cause');
    expect(body).toContain('**Current state:**');
    expect(body).toContain('**Exits:**');
  });

  it('always carries the current-state summary regardless of verification kind', () => {
    const body = buildStageStalledCommentBody({
      ...base,
      verification: { kind: 'unverified', skillLabel: 'forge-clarify', reason: 'x' },
      state: { merged: 'yes', implementationRan: 'yes', stageProducedComment: 'unknown' },
    });

    expect(body).toContain('Merge recorded (`merged_at`): yes');
    expect(body).toContain('Implementation ran (a `code`/`fix` job completed): yes');
    expect(body).toContain('Stage produced a comment since this stall began: unknown');
  });
});
