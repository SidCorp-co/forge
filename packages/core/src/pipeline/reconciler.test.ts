import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyStatusTransitionMock,
  jobsQueue,
  reEnqueueMock,
  resetHarness,
  sentryAddBreadcrumb,
  staleCountQueue,
  stuckQueue,
} from './reconciler-test-harness.js';

vi.mock('../db/client.js', async () => {
  const h = await import('./reconciler-test-harness.js');
  return { db: { execute: h.dbExecute } };
});
vi.mock('./orchestrator.js', async () => {
  const h = await import('./reconciler-test-harness.js');
  return { reEnqueueForIssue: (...a: unknown[]) => h.reEnqueueMock(...(a as [])) };
});
vi.mock('./autonomous-rescue-cap.js', async () => {
  const h = await import('./reconciler-test-harness.js');
  return {
    checkAutonomousRescueCap: (...a: unknown[]) => h.capMock(...(a as [])),
    recordAutonomousRescue: (...a: unknown[]) => h.recordRescueMock(...(a as [])),
  };
});
vi.mock('../issues/apply-transition.js', async () => {
  const h = await import('./reconciler-test-harness.js');
  return { applyStatusTransition: (...a: unknown[]) => h.applyStatusTransitionMock(...(a as [])) };
});
vi.mock('../observability/sentry.js', async () => {
  const h = await import('./reconciler-test-harness.js');
  return { Sentry: { addBreadcrumb: h.sentryAddBreadcrumb }, isSentryEnabled: () => true };
});
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runReconcilerOnce } = await import('./reconciler.js');

beforeEach(resetHarness);

describe('rescue accounting', () => {
  // cm:guard L0.7 — `rescued` used to count the ATTEMPT. `considerEnqueue` has a dozen paths that enqueue nothing (a disabled stage, a human gate, a race, a missing skill), and an issue parked on any of them is re-read every 60s forever: the counter and the warning breadcrumb both fired every minute for a loop that did nothing, which is how it stayed invisible.
  it('does not count a rescue when the re-enqueue produced no job', async () => {
    stuckQueue.push([
      {
        id: 'iss-1',
        project_id: 'proj-1',
        status: 'confirmed',
        created_by: 'o',
        reopen_count: 0,
      },
    ]);
    jobsQueue.push([]);
    staleCountQueue.push([{ count: 0 }]);

    const result = await runReconcilerOnce();

    expect(reEnqueueMock).toHaveBeenCalledTimes(1);
    expect(result.rescued).toBe(0);
    expect(sentryAddBreadcrumb).not.toHaveBeenCalledWith(
      expect.objectContaining({ category: 'pipeline.reconciler.enqueued_missing' }),
    );
  });
});

describe('reconciler', () => {
  it('re-enqueues each stuck issue and emits a Sentry breadcrumb', async () => {
    stuckQueue.push([
      {
        id: 'iss-1',
        project_id: 'proj-1',
        status: 'confirmed',
        created_by: 'owner-1',
        reopen_count: 0,
      },
      {
        id: 'iss-2',
        project_id: 'proj-1',
        status: 'approved',
        created_by: 'owner-1',
        reopen_count: 0,
      },
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
      {
        id: 'iss-3',
        project_id: 'proj-2',
        status: 'reopen',
        created_by: null,
        reopen_count: 0,
      },
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
      {
        id: 'iss-4',
        project_id: 'proj-3',
        status: 'confirmed',
        created_by: 'o',
        reopen_count: 0,
      },
      {
        id: 'iss-5',
        project_id: 'proj-3',
        status: 'confirmed',
        created_by: 'o',
        reopen_count: 0,
      },
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

