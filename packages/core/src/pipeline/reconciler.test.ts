import { beforeEach, describe, expect, it, vi } from 'vitest';

const stuckQueue: Array<
  Array<{ id: string; project_id: string; status: string; created_by: string | null }>
> = [];
const staleCountQueue: Array<Array<{ count: string | number }>> = [];
const wedgeQueue: Array<
  Array<{
    id: string;
    project_id: string;
    status: string;
    reopen_count: number;
    created_by: string | null;
    job_type: string;
  }>
> = [];

const dbExecute = vi.fn(async (q: unknown) => {
  const chunks = (q as { queryChunks?: unknown[] }).queryChunks ?? [];
  // StringChunk.value is string[]; concatenate all template fragments.
  let firstSql = '';
  for (const c of chunks) {
    if (typeof c === 'object' && c !== null && 'value' in c) {
      const v = (c as { value?: unknown }).value;
      if (Array.isArray(v)) {
        firstSql += v.filter((p): p is string => typeof p === 'string').join(' ');
      } else if (typeof v === 'string') {
        firstSql += v;
      }
    }
  }
  // The in-flight wedge query also selects FROM issues, so route it FIRST off
  // its distinctive pipeline_runs / LATERAL join before the generic check.
  if (/pipeline_runs/i.test(firstSql) || /lateral/i.test(firstSql)) {
    return wedgeQueue.shift() ?? [];
  }
  if (/from\s+issues/i.test(firstSql)) {
    return stuckQueue.shift() ?? [];
  }
  if (/from\s+pipeline_outbox/i.test(firstSql)) {
    return staleCountQueue.shift() ?? [{ count: 0 }];
  }
  return [];
});

vi.mock('../db/client.js', () => ({
  db: { execute: dbExecute },
}));

const reEnqueueMock = vi.fn(async () => undefined);
vi.mock('./orchestrator.js', () => ({
  reEnqueueForIssue: (...a: unknown[]) => reEnqueueMock(...(a as [])),
}));

const applyStatusTransitionMock = vi.fn(async () => undefined);
vi.mock('../issues/apply-transition.js', () => ({
  applyStatusTransition: (...a: unknown[]) => applyStatusTransitionMock(...(a as [])),
}));

const sentryAddBreadcrumb = vi.fn();
vi.mock('../observability/sentry.js', () => ({
  Sentry: { addBreadcrumb: sentryAddBreadcrumb },
  isSentryEnabled: () => true,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runReconcilerOnce } = await import('./reconciler.js');

beforeEach(() => {
  stuckQueue.length = 0;
  staleCountQueue.length = 0;
  wedgeQueue.length = 0;
  dbExecute.mockClear();
  reEnqueueMock.mockReset();
  reEnqueueMock.mockResolvedValue(undefined);
  applyStatusTransitionMock.mockReset();
  applyStatusTransitionMock.mockResolvedValue(undefined);
  sentryAddBreadcrumb.mockClear();
});

describe('reconciler', () => {
  it('re-enqueues each stuck issue and emits a Sentry breadcrumb', async () => {
    stuckQueue.push([
      { id: 'iss-1', project_id: 'proj-1', status: 'confirmed', created_by: 'owner-1' },
      { id: 'iss-2', project_id: 'proj-1', status: 'approved', created_by: 'owner-1' },
    ]);
    staleCountQueue.push([{ count: 0 }]);

    const result = await runReconcilerOnce();

    expect(result.rescued).toBe(2);
    expect(reEnqueueMock).toHaveBeenCalledTimes(2);
    expect(reEnqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: 'iss-1',
        status: 'confirmed',
        actor: expect.objectContaining({ type: 'device', id: 'owner-1' }),
        reason: expect.objectContaining({ reconciler: true }),
      }),
    );
    expect(sentryAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'pipeline.reconciler.enqueued_missing' }),
    );
  });

  it('falls back to the <reconciler> sentinel id when project has no owner', async () => {
    stuckQueue.push([{ id: 'iss-3', project_id: 'proj-2', status: 'reopen', created_by: null }]);
    staleCountQueue.push([{ count: 0 }]);

    await runReconcilerOnce();

    expect(reEnqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ type: 'device', id: '<reconciler>' }),
      }),
    );
  });

  it('logs a stale-outbox breadcrumb when unprocessed rows are older than 5min', async () => {
    stuckQueue.push([]);
    staleCountQueue.push([{ count: '17' }]);

    const result = await runReconcilerOnce();

    expect(result.stale).toBe(17);
    expect(sentryAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'pipeline.outbox.stale_unprocessed',
        data: expect.objectContaining({ staleCount: 17 }),
      }),
    );
  });

  it('does not throw when reEnqueueForIssue throws — continues with the next row', async () => {
    stuckQueue.push([
      { id: 'iss-4', project_id: 'proj-3', status: 'confirmed', created_by: 'o' },
      { id: 'iss-5', project_id: 'proj-3', status: 'confirmed', created_by: 'o' },
    ]);
    staleCountQueue.push([{ count: 0 }]);
    reEnqueueMock.mockRejectedValueOnce(new Error('boom'));

    const result = await runReconcilerOnce();

    // First call failed → not rescued. Second call succeeded → rescued: 1.
    expect(result.rescued).toBe(1);
    expect(reEnqueueMock).toHaveBeenCalledTimes(2);
  });

  it('returns zero rescues when no issues are stuck', async () => {
    stuckQueue.push([]);
    staleCountQueue.push([{ count: 0 }]);

    const result = await runReconcilerOnce();

    expect(result.rescued).toBe(0);
    expect(result.stale).toBe(0);
    expect(reEnqueueMock).not.toHaveBeenCalled();
  });

  describe('in-flight wedge reset (ISS-598)', () => {
    it('rolls a code wedge (in_progress, latest job done) back to approved', async () => {
      stuckQueue.push([]);
      staleCountQueue.push([{ count: 0 }]);
      wedgeQueue.push([
        {
          id: 'iss-w1',
          project_id: 'proj-w',
          status: 'in_progress',
          reopen_count: 0,
          created_by: 'owner-w',
          job_type: 'code',
        },
      ]);

      const result = await runReconcilerOnce();

      expect(result.reset).toBe(1);
      expect(applyStatusTransitionMock).toHaveBeenCalledTimes(1);
      expect(applyStatusTransitionMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'iss-w1', status: 'in_progress', reopenCount: 0 }),
        'approved',
        expect.objectContaining({ id: 'owner-w', ownerId: 'owner-w' }),
        expect.objectContaining({ reason: 'reconciler_inflight_wedge_reset' }),
      );
      expect(sentryAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'pipeline.reconciler.inflight_wedge_reset',
          data: expect.objectContaining({ from: 'in_progress', to: 'approved', jobType: 'code' }),
        }),
      );
    });

    it('rolls a fix wedge back to reopen (its own trigger status)', async () => {
      stuckQueue.push([]);
      staleCountQueue.push([{ count: 0 }]);
      wedgeQueue.push([
        {
          id: 'iss-w2',
          project_id: 'proj-w',
          status: 'in_progress',
          reopen_count: 2,
          created_by: 'owner-w',
          job_type: 'fix',
        },
      ]);

      const result = await runReconcilerOnce();

      expect(result.reset).toBe(1);
      expect(applyStatusTransitionMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'iss-w2' }),
        'reopen',
        expect.anything(),
        expect.anything(),
      );
    });

    it('skips a row whose latest job type does not own the current in-flight status', async () => {
      stuckQueue.push([]);
      staleCountQueue.push([{ count: 0 }]);
      // job_type review has no workingStatus → must never be reset even if the
      // query somehow returned it.
      wedgeQueue.push([
        {
          id: 'iss-w3',
          project_id: 'proj-w',
          status: 'in_progress',
          reopen_count: 0,
          created_by: 'owner-w',
          job_type: 'review',
        },
      ]);

      const result = await runReconcilerOnce();

      expect(result.reset).toBe(0);
      expect(applyStatusTransitionMock).not.toHaveBeenCalled();
    });

    it('does not throw when a reset races a real transition — continues to the next row', async () => {
      stuckQueue.push([]);
      staleCountQueue.push([{ count: 0 }]);
      wedgeQueue.push([
        {
          id: 'iss-w4',
          project_id: 'proj-w',
          status: 'in_progress',
          reopen_count: 0,
          created_by: 'o',
          job_type: 'code',
        },
        {
          id: 'iss-w5',
          project_id: 'proj-w',
          status: 'in_progress',
          reopen_count: 0,
          created_by: 'o',
          job_type: 'code',
        },
      ]);
      applyStatusTransitionMock.mockRejectedValueOnce(
        new Error('STALE_TRANSITION: issue status changed concurrently'),
      );

      const result = await runReconcilerOnce();

      expect(result.reset).toBe(1);
      expect(applyStatusTransitionMock).toHaveBeenCalledTimes(2);
    });
  });
});
