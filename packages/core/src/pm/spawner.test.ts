import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
  },
}));

const enqueueMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../jobs/enqueue.js', () => ({
  enqueuePmJob: (...args: unknown[]) => enqueueMock(...(args as [string])),
}));

// ISS-101 — pipeline_runs lookups stubbed so the test's db mock doesn't have
// to model the extra SELECT/INSERT against `pipeline_runs`.
vi.mock('../pipeline/runs.js', () => ({
  openIssueRun: vi.fn().mockResolvedValue({ id: 'run-1', startedAt: new Date() }),
  openOneShotRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
  closeRun: vi.fn().mockResolvedValue(undefined),
  closeRunIfOneShot: vi.fn().mockResolvedValue(undefined),
  closeOpenRunForIssue: vi.fn().mockResolvedValue(undefined),
  setCurrentStep: vi.fn().mockResolvedValue(undefined),
  setCurrentStepForOpenIssueRun: vi.fn().mockResolvedValue(undefined),
}));

const { spawnPmSession } = await import('./spawner.js');

type Row = Record<string, unknown>;

// Each call to db.select(...) creates a new chain. The spawner makes up to
// three sequential select calls (config, decision count, owner lookup), so
// queue an implementation per call and return the rows that call expects.
function queueSelect(rows: Row[]): void {
  selectMock.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        limit: async () => rows,
        // For the count() select there's no `.limit()` — the where() result
        // is awaited directly. Fall through to thenable shape below.
        then: undefined,
      }),
    }),
  }));
}

// Variant where `.where()` is awaited directly (no `.limit()`) — used by the
// rate-limit count query.
function queueSelectScalar(rows: Row[]): void {
  selectMock.mockImplementationOnce(() => ({
    from: () => ({
      where: async () => rows,
    }),
  }));
}

function mockInsertReturning(row: { id: string } | null): void {
  insertMock.mockImplementationOnce(() => ({
    values: () => ({
      returning: async () => (row ? [row] : []),
    }),
  }));
}

function mockInsertThrows(err: unknown): void {
  insertMock.mockImplementationOnce(() => ({
    values: () => ({
      returning: async () => {
        throw err;
      },
    }),
  }));
}

const baseConfig = {
  projectId: 'proj-1',
  enabled: true,
  cadenceCron: null,
  eventTriggers: {
    jobFailed: true,
    pipelineStalled: true,
    needsInfo: true,
    queuePressure: true,
    graphChanged: true,
  },
  customInstructions: null,
  modelOverride: null,
  maxRunsPerHour: 6,
};

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  enqueueMock.mockClear();
});

describe('spawnPmSession', () => {
  it('returns disabled when pm_config row is missing', async () => {
    queueSelect([]); // pm_config lookup
    const result = await spawnPmSession({ projectId: 'proj-1', cause: 'tick' });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
    expect(insertMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('returns disabled when enabled=false', async () => {
    queueSelect([{ ...baseConfig, enabled: false }]);
    const result = await spawnPmSession({ projectId: 'proj-1', cause: 'tick' });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
  });

  it('returns trigger-masked when matching event_triggers key is false', async () => {
    queueSelect([
      { ...baseConfig, eventTriggers: { ...baseConfig.eventTriggers, jobFailed: false } },
    ]);
    const result = await spawnPmSession({ projectId: 'proj-1', cause: 'job-failed' });
    expect(result).toEqual({ ok: false, reason: 'trigger-masked' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('operator cause bypasses the trigger mask', async () => {
    queueSelect([
      { ...baseConfig, eventTriggers: { ...baseConfig.eventTriggers, jobFailed: false } },
    ]); // pm_config
    queueSelect([{ ownerId: 'user-1' }]); // project owner
    mockInsertReturning({ id: 'pm-job-1' });
    const result = await spawnPmSession({ projectId: 'proj-1', cause: 'operator' });
    expect(result).toEqual({ ok: true, jobId: 'pm-job-1' });
  });

  it('returns rate-limited when decisions >= maxRunsPerHour for non-operator causes', async () => {
    queueSelect([baseConfig]); // pm_config
    queueSelectScalar([{ count: 6 }]); // decision count
    const result = await spawnPmSession({ projectId: 'proj-1', cause: 'tick' });
    expect(result).toEqual({ ok: false, reason: 'rate-limited' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('operator cause bypasses rate limit', async () => {
    queueSelect([baseConfig]); // pm_config — no decision count select since operator skips it
    queueSelect([{ ownerId: 'user-1' }]); // project owner
    mockInsertReturning({ id: 'pm-job-2' });
    const result = await spawnPmSession({
      projectId: 'proj-1',
      cause: 'operator',
      actorUserId: 'user-1',
    });
    expect(result).toEqual({ ok: true, jobId: 'pm-job-2' });
  });

  it('returns already-active on Postgres unique violation', async () => {
    queueSelect([baseConfig]); // pm_config
    queueSelectScalar([{ count: 0 }]); // decision count
    queueSelect([{ ownerId: 'user-1' }]); // owner
    mockInsertThrows({ code: '23505', message: 'duplicate key' });
    const result = await spawnPmSession({ projectId: 'proj-1', cause: 'tick' });
    expect(result).toEqual({ ok: false, reason: 'already-active' });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('rethrows non-unique-violation insert errors', async () => {
    queueSelect([baseConfig]);
    queueSelectScalar([{ count: 0 }]);
    queueSelect([{ ownerId: 'user-1' }]);
    mockInsertThrows(new Error('connection refused'));
    await expect(
      spawnPmSession({ projectId: 'proj-1', cause: 'tick' }),
    ).rejects.toThrow('connection refused');
  });

  it('happy path: inserts a pm job and enqueues on the PM queue', async () => {
    queueSelect([baseConfig]);
    queueSelectScalar([{ count: 0 }]);
    queueSelect([{ ownerId: 'user-1' }]);
    mockInsertReturning({ id: 'pm-job-3' });
    const result = await spawnPmSession({
      projectId: 'proj-1',
      cause: 'queue-pressure',
      eventRef: { queued: 7 },
    });
    expect(result).toEqual({ ok: true, jobId: 'pm-job-3' });
    expect(enqueueMock).toHaveBeenCalledWith('pm-job-3');
  });

  it('uses actorUserId without a project lookup when provided', async () => {
    queueSelect([baseConfig]);
    queueSelectScalar([{ count: 0 }]);
    // No project owner lookup expected — operator-reply provides actor.
    mockInsertReturning({ id: 'pm-job-4' });
    const result = await spawnPmSession({
      projectId: 'proj-1',
      cause: 'operator-reply',
      actorUserId: 'actor-1',
    });
    expect(result).toEqual({ ok: true, jobId: 'pm-job-4' });
  });
});
