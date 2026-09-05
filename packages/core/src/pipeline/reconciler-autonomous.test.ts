import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyStatusTransitionMock,
  autonomousWedgeQueue,
  capMock,
  jobsQueue,
  recordRescueMock,
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

describe('autonomous driver wedge reset (ISS-890)', () => {
  function seedIdle(): void {
    stuckQueue.push([]);
    staleCountQueue.push([{ count: 0 }]);
  }

  it('rolls a driver wedge at in_progress back to the entry status', async () => {
    seedIdle();
    autonomousWedgeQueue.push([
      {
        id: 'iss-a1',
        project_id: 'proj-a',
        status: 'in_progress',
        reopen_count: 2,
        created_by: 'owner-a',
      },
    ]);

    const result = await runReconcilerOnce();

    expect(result.autonomousReset).toBe(1);
    expect(applyStatusTransitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'iss-a1', status: 'in_progress', reopenCount: 2 }),
      'open',
      expect.objectContaining({ id: 'owner-a', ownerId: 'owner-a' }),
      expect.objectContaining({ reason: 'reconciler_autonomous_wedge_reset', skip: true }),
    );
    expect(sentryAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'pipeline.reconciler.autonomous_wedge_reset',
        data: expect.objectContaining({ from: 'in_progress' }),
      }),
    );
  });

  it('does not roll back, and does not charge a rescue, when the run has spent its cap', async () => {
    seedIdle();
    autonomousWedgeQueue.push([
      {
        id: 'iss-a1',
        project_id: 'proj-a',
        status: 'in_progress',
        reopen_count: 2,
        created_by: 'owner-a',
      },
    ]);
    capMock.mockResolvedValue({ capped: true, runId: 'run-a1' });

    const result = await runReconcilerOnce();

    expect(result.autonomousReset).toBe(0);
    expect(applyStatusTransitionMock).not.toHaveBeenCalled();
    expect(recordRescueMock).not.toHaveBeenCalled();
  });

  it('charges the rescue only after the rollback lands, never on a throwing transition', async () => {
    seedIdle();
    autonomousWedgeQueue.push([
      {
        id: 'iss-a1',
        project_id: 'proj-a',
        status: 'in_progress',
        reopen_count: 2,
        created_by: 'owner-a',
      },
    ]);
    applyStatusTransitionMock.mockRejectedValueOnce(new Error('STALE_TRANSITION'));

    const result = await runReconcilerOnce();

    expect(result.autonomousReset).toBe(0);
    expect(recordRescueMock).not.toHaveBeenCalled();
  });

  it('charges the run exactly one rescue on a successful rollback', async () => {
    seedIdle();
    autonomousWedgeQueue.push([
      {
        id: 'iss-a1',
        project_id: 'proj-a',
        status: 'in_progress',
        reopen_count: 2,
        created_by: 'owner-a',
      },
    ]);

    const result = await runReconcilerOnce();

    expect(result.autonomousReset).toBe(1);
    expect(recordRescueMock).toHaveBeenCalledWith('run-a1');
  });

});

describe('the rescue cap on the open path (ISS-890 extra fix)', () => {
  function seedAutonomousStuck(): void {
    stuckQueue.push([
      {
        id: 'iss-o1',
        project_id: 'proj-o',
        status: 'open',
        created_by: 'owner-o',
        reopen_count: 1,
      },
    ]);
    staleCountQueue.push([{ count: 0 }]);
    autonomousWedgeQueue.push([]);
  }

  it('asks the cap before re-enqueueing, carrying the issue’s real reopen count', async () => {
    seedAutonomousStuck();

    const result = await runReconcilerOnce();

    expect(result.rescued).toBe(1);
    expect(capMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: 'iss-o1', status: 'open', reopenCount: 1 }),
    );
  });

  it('refuses to re-enqueue once the run has spent its rescues', async () => {
    seedAutonomousStuck();
    capMock.mockResolvedValue({ capped: true, runId: 'run-o1' });

    const result = await runReconcilerOnce();

    expect(reEnqueueMock).not.toHaveBeenCalled();
    expect(recordRescueMock).not.toHaveBeenCalled();
    expect(result.rescued).toBe(0);
  });

  it('charges the run only once a job actually appeared', async () => {
    seedAutonomousStuck();
    capMock.mockResolvedValue({ capped: false, runId: 'run-o1' });

    const result = await runReconcilerOnce();

    expect(result.rescued).toBe(1);
    expect(recordRescueMock).toHaveBeenCalledWith('run-o1');
  });

  it('charges nothing when the re-enqueue produced no job', async () => {
    seedAutonomousStuck();
    jobsQueue.push([]);

    const result = await runReconcilerOnce();

    expect(recordRescueMock).not.toHaveBeenCalled();
    expect(result.rescued).toBe(0);
  });

  it('charges nothing when the project has no open run to charge', async () => {
    seedAutonomousStuck();
    capMock.mockResolvedValue({ capped: false, runId: null });

    const result = await runReconcilerOnce();

    expect(result.rescued).toBe(1);
    expect(recordRescueMock).not.toHaveBeenCalled();
  });

});
