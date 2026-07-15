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
chain.limit = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
// biome-ignore lint/suspicious/noThenProperty: drizzle chains resolve via await — the mock must be thenable
chain.then = (resolve: any, reject: any) => {
  const next = queue.shift();
  if (next instanceof Error) return Promise.reject(next).then(resolve, reject);
  return Promise.resolve(next ?? []).then(resolve, reject);
};

const selectSpy = vi.fn(() => chain);
const insertValues = vi.fn(async () => undefined);
const insertSpy = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => ({
  db: { select: selectSpy, insert: insertSpy },
}));

const pauseRunMock = vi.fn(async () => ({ id: 'run-1' }) as unknown);
vi.mock('./run-pause.js', () => ({
  pauseRun: (...a: unknown[]) => pauseRunMock(...(a as [])),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { checkStageStallAndPause, STAGE_STALL_CAP, buildStageStalledReason } = await import(
  './stage-stall-guard.js'
);

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
      queue.push([{ n: STAGE_STALL_CAP }]); // done-count query
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

  it.each([{ status: 'confirmed' as const }, { status: 'clarified' as const }])(
    'does not pause below STAGE_STALL_CAP for $status',
    async ({ status }) => {
      pushRunningRun();
      queue.push([{ n: STAGE_STALL_CAP - 1 }]);

      const result = await checkStageStallAndPause({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        status,
      });

      expect(result).toEqual({ stalled: false });
      expect(pauseRunMock).not.toHaveBeenCalled();
      expect(insertValues).not.toHaveBeenCalled();
    },
  );

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
});
