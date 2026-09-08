import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  jobsQueue,
  reEnqueueMock,
  resetHarness,
  sentryAddBreadcrumb,
  staleCountQueue,
  stuckQueue,
} from './reconciler-test-harness.js';

const wakeMastersForProject = vi.fn(async () => ({ boxes: 1, delivered: 1 }));

vi.mock('../ws/master-wake.js', () => ({
  wakeMastersForProject: (...a: unknown[]) => wakeMastersForProject(...(a as [])),
}));

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
  it('does not count a rescue when no box is bound to serve the project', async () => {
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
    wakeMastersForProject.mockResolvedValueOnce({ boxes: 0, delivered: 0 });

    const result = await runReconcilerOnce();

    expect(wakeMastersForProject).toHaveBeenCalledTimes(1);
    expect(
      result.rescued,
      'a project no box is bound to serve keeps being reported, never counted as repaired — the difference between latency and work nobody is doing (ISS-933)',
    ).toBe(0);
    expect(sentryAddBreadcrumb).not.toHaveBeenCalledWith(
      expect.objectContaining({ category: 'pipeline.reconciler.enqueued_missing' }),
    );
  });
});

describe('reconciler', () => {
  it('wakes a box for each stuck issue and emits a Sentry breadcrumb', async () => {
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
    expect(wakeMastersForProject).toHaveBeenCalledTimes(2);
    expect(wakeMastersForProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', issueId: 'iss-1', status: 'confirmed' }),
    );
    expect(sentryAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'pipeline.reconciler.enqueued_missing' }),
    );
  });

  it('wakes the project boxes even when it has no owner to attribute', async () => {
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

    expect(wakeMastersForProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-2',
        issueId: 'iss-3',
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

  it('does not throw when the wake throws — continues with the next row', async () => {
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
    wakeMastersForProject.mockRejectedValueOnce(new Error('boom'));

    const result = await runReconcilerOnce();

    expect(result.rescued).toBe(1);
    expect(wakeMastersForProject).toHaveBeenCalledTimes(2);
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
