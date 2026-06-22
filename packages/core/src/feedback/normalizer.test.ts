import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HooksBus } from '../pipeline/hooks.js';

// ── DB mock ──────────────────────────────────────────────────────────────────
// Supports .select().from().where().limit() pattern used by both
// the feedbackReports query and the memoryCandidates lookup.

const selectMock = vi.fn<[], Promise<unknown[]>>();
const updateSetMock = vi.fn<[unknown], Promise<void>>();

const dbMock = {
  select: (_cols?: unknown) => ({
    from: (_table: unknown) => ({
      where: (_cond: unknown) => ({
        limit: (_n: unknown) => selectMock(),
      }),
    }),
  }),
  update: (_table: unknown) => ({
    set: (s: unknown) => ({
      where: (_cond: unknown) => updateSetMock(s),
    }),
  }),
};

vi.mock('../db/client.js', () => ({ db: dbMock }));

vi.mock('../db/schema.js', () => ({
  feedbackReports: { jobId: 'job_id', candidateId: 'candidate_id', id: 'id' },
  memoryCandidates: {
    id: 'id',
    projectId: 'project_id',
    signalType: 'signal_type',
    signalKey: 'signal_key',
  },
}));

const upsertMock = vi.fn<[string, unknown], Promise<void>>();
vi.mock('../memory/candidates-accrual.js', () => ({ upsertCandidate: upsertMock }));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../config/env.js', () => ({
  env: { FEEDBACK_MAX_PER_JOB: 5 },
}));

// drizzle operators — passthrough so they don't throw.
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
  isNull: (col: unknown) => ({ isNull: col }),
}));

// ── helpers ───────────────────────────────────────────────────────────────────

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    id: 'report-1',
    projectId: 'proj-1',
    issueId: 'issue-1',
    runId: 'run-1',
    jobId: 'job-1',
    stage: 'code',
    kind: 'friction',
    severity: 'medium',
    target: 'skill',
    targetRef: 'forge-code',
    summary: 'Confusing skill step',
    detail: null,
    suggestion: null,
    candidateId: null,
    signalKey: 'self_report:skill:forge-code:friction',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    skillName: null,
    skillVersion: null,
    ...overrides,
  };
}

const CANDIDATE_ROW = { id: 'cand-1' };

// ── module under test ─────────────────────────────────────────────────────────

const {
  registerFeedbackNormalizer,
  resetFeedbackNormalizerForTest,
} = await import('./normalizer.js');

beforeEach(() => {
  vi.resetAllMocks();
  resetFeedbackNormalizerForTest();
  updateSetMock.mockResolvedValue(undefined);
  upsertMock.mockResolvedValue(undefined);
});

// Helper: register + emit + flush microtasks.
async function emitAndFlush(
  bus: HooksBus,
  event: 'jobCompleted' | 'jobFailed',
  payload: Record<string, unknown>,
) {
  registerFeedbackNormalizer(bus);
  await bus.emit(event as 'jobCompleted', payload as Parameters<typeof bus.emit>[1]);
  await new Promise((r) => setTimeout(r, 0));
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('jobCompleted — one report → one candidate', () => {
  it('upserts candidate with signal_type=agent_self_report and back-sets candidate_id', async () => {
    selectMock
      .mockResolvedValueOnce([makeReport()])  // feedbackReports query
      .mockResolvedValueOnce([CANDIDATE_ROW]); // memoryCandidates lookup

    const bus = new HooksBus();
    await emitAndFlush(bus, 'jobCompleted', {
      jobId: 'job-1',
      projectId: 'proj-1',
      issueId: 'issue-1',
      type: 'code',
    });

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const [projectId, candidate] = upsertMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(projectId).toBe('proj-1');
    expect(candidate['signalType']).toBe('agent_self_report');
    expect(candidate['signalKey']).toBe('self_report:skill:forge-code:friction');
    expect((candidate['evidence'] as Record<string, unknown>)['outcome']).toBe('completed');

    expect(updateSetMock).toHaveBeenCalledTimes(1);
    const updateArg = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateArg['candidateId']).toBe('cand-1');
  });
});

describe('jobCompleted — no reports', () => {
  it('does nothing when the job has no unprocessed feedback reports', async () => {
    selectMock.mockResolvedValueOnce([]);

    const bus = new HooksBus();
    await emitAndFlush(bus, 'jobCompleted', {
      jobId: 'job-2',
      projectId: 'proj-1',
      issueId: 'issue-1',
      type: 'code',
    });

    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });
});

describe('jobFailed — outcome recorded as failed', () => {
  it('sets outcome=failed and includes failureKind in evidence', async () => {
    selectMock
      .mockResolvedValueOnce([makeReport()])
      .mockResolvedValueOnce([CANDIDATE_ROW]);

    const bus = new HooksBus();
    await emitAndFlush(bus, 'jobFailed', {
      jobId: 'job-1',
      projectId: 'proj-1',
      issueId: 'issue-1',
      type: 'code',
      failureKind: 'infra',
      failureReason: 'timeout',
    });

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const [, candidate] = upsertMock.mock.calls[0] as [string, Record<string, unknown>];
    const evidence = candidate['evidence'] as Record<string, unknown>;
    expect(evidence['outcome']).toBe('failed');
    expect(evidence['failureKind']).toBe('infra');
  });
});

describe('multi-witness dedup', () => {
  it('two reports with same signalKey from different jobs both call upsertCandidate', async () => {
    const bus = new HooksBus();
    registerFeedbackNormalizer(bus);

    // First job
    selectMock
      .mockResolvedValueOnce([makeReport({ id: 'r-1', runId: 'run-1' })])
      .mockResolvedValueOnce([CANDIDATE_ROW]);
    await bus.emit('jobCompleted', {
      jobId: 'job-1',
      projectId: 'proj-1',
      issueId: 'issue-1',
      type: 'code',
    });
    await new Promise((r) => setTimeout(r, 0));

    // Second job — same signalKey, different run
    selectMock
      .mockResolvedValueOnce([makeReport({ id: 'r-2', runId: 'run-2', jobId: 'job-2' })])
      .mockResolvedValueOnce([CANDIDATE_ROW]);
    await bus.emit('jobCompleted', {
      jobId: 'job-2',
      projectId: 'proj-1',
      issueId: 'issue-1',
      type: 'code',
    });
    await new Promise((r) => setTimeout(r, 0));

    // upsertCandidate called twice; accrual dedup is inside upsertCandidate itself.
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock.mock.calls[0]?.[1]).toMatchObject({
      signalKey: 'self_report:skill:forge-code:friction',
    });
    expect(upsertMock.mock.calls[1]?.[1]).toMatchObject({
      signalKey: 'self_report:skill:forge-code:friction',
    });
  });
});

describe('decoupled — fold does not block hook emission', () => {
  it('hook emit returns before fold DB queries run', async () => {
    const order: string[] = [];

    selectMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('fold-db-called');
      return [];
    });

    const bus = new HooksBus();
    registerFeedbackNormalizer(bus);
    await bus.emit('jobCompleted', {
      jobId: 'job-1',
      projectId: 'proj-1',
      issueId: 'issue-1',
      type: 'code',
    });
    order.push('emit-returned');
    // The fold is queued as a microtask but its async DB call hasn't run yet.
    expect(order).toEqual(['emit-returned']);
    // Let the microtask + async IO complete.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toContain('fold-db-called');
  });
});

describe('skips jobs without an issueId', () => {
  it('does not fold for PM/interactive jobs (null issueId)', async () => {
    const bus = new HooksBus();
    await emitAndFlush(bus, 'jobCompleted', {
      jobId: 'job-pm',
      projectId: 'proj-1',
      issueId: null,
      type: 'pm',
    });
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
