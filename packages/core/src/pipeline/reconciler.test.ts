import { beforeEach, describe, expect, it, vi } from 'vitest';

const stuckQueue: Array<Array<{ id: string; project_id: string; status: string; created_by: string | null }>> = [];
const staleCountQueue: Array<Array<{ count: string | number }>> = [];

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
  dbExecute.mockClear();
  reEnqueueMock.mockReset();
  reEnqueueMock.mockResolvedValue(undefined);
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
    stuckQueue.push([
      { id: 'iss-3', project_id: 'proj-2', status: 'reopen', created_by: null },
    ]);
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
});
