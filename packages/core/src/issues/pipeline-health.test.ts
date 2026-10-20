/**
 * ISS-164 — pipelineHealth classifier unit tests.
 *
 * The pure `classifyPipelineHealthForIssue` takes pre-fetched rows so each
 * L1..L4 branch can be exercised without touching Postgres or drizzle. The
 * SQL paths are covered separately by
 * `tests/integration/pipeline-health-e2e.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { CAPACITY_BARS, type CapacityBar } from '../jobs/capacity-fleet.js';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    DEVICE_TOKEN_PEPPER: 'test-pepper-32-chars-long-abcdefghij',
    DATABASE_URL: 'postgres://test',
    NODE_ENV: 'test',
  },
}));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(), execute: vi.fn() },
}));

const { classifyPipelineHealthForIssue } = await import('./pipeline-health.js');
type ClassifyInput = import('./pipeline-health.js').ClassifyInput;

const QUEUED_AT = new Date('2026-05-17T08:00:00.000Z');

function baseInput(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    issue: { id: 'iss-1', status: 'approved', mergedAt: null, waitingKind: null },
    sessions: [],
    jobs: [],
    runnerPool: { total: 1 },
    ...over,
  };
}

function job(
  over: Partial<{
    id: string;
    type: string;
    status: string;
    queuedAt: Date;
    runnerId: string | null;
    agentSessionId: string | null;
    pipelineRunStatus: string | null;
    stageStatus: string | null;
    retryAfterAt: Date | null;
  }> = {},
) {
  return {
    id: over.id ?? 'job-1',
    type: over.type ?? 'plan',
    status: over.status ?? 'queued',
    queuedAt: over.queuedAt ?? QUEUED_AT,
    runnerId: over.runnerId ?? null,
    agentSessionId: over.agentSessionId ?? null,
    pipelineRunStatus: over.pipelineRunStatus ?? 'running',
    stageStatus: over.stageStatus ?? null,
    retryAfterAt: over.retryAfterAt ?? null,
  };
}

describe('classifyPipelineHealthForIssue', () => {
  it('returns `{ stage }` only when no queued jobs exist', () => {
    const out = classifyPipelineHealthForIssue(baseInput());
    expect(out).toEqual({
      stage: 'approved',
      worker: {
        lane: 'none',
        detail:
          'no agent session is on record as opened over this issue on either session lane, and its record carries no claim',
      },
    });
  });

  // ISS-1273 — the shape this issue exists to refuse: `stage` alone restates the status column
  // the caller already had, and says nothing a reader can tell from a quiet system.
  it('never answers with stage as its only key', () => {
    const out = classifyPipelineHealthForIssue(baseInput());
    expect(Object.keys(out).sort()).not.toEqual(['stage']);
    expect(out.worker).toBeDefined();
  });

  it('names the run-session lane when the only bind is the run issue lease', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        sessions: [
          { id: 'sess-box', status: 'running', metadata: null, lane: 'run_session', holds: true },
        ],
      }),
    );
    expect(out.worker).toMatchObject({ lane: 'run_session', sessionId: 'sess-box' });
    expect(out.activeSession).toMatchObject({ id: 'sess-box' });
  });

  it('names the claim lane when a driver holds the issue with no session row at all', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        claim: {
          verdict: 'live',
          holder: 'iss-1273-52b95148',
          expiresAt: new Date('2026-09-27T11:00:00.000Z'),
          fanout: 1,
          stopped: false,
          silentMs: null,
          toleranceMs: null,
          detail: 'held',
        },
      }),
    );
    expect(out.worker).toMatchObject({ lane: 'claim', holder: 'iss-1273-52b95148' });
  });

  it('exposes activeSession for a running session', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        sessions: [
          {
            id: 'sess-1',
            status: 'running',
            metadata: { skill: 'forge-code', jobType: 'drive' },
            lane: 'job',
            holds: true,
          },
        ],
      }),
    );
    expect(out.activeSession).toEqual({
      id: 'sess-1',
      status: 'running',
      jobType: 'drive',
      skill: 'forge-code',
    });
  });

  it('classifies issue_busy when a sibling session is running', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        sessions: [{ id: 'sess-x', status: 'running', metadata: null, lane: 'job', holds: true }],
        jobs: [job()],
      }),
    );
    expect(out.waitingOn?.reason).toBe('issue_busy');
    expect(out.waitingOn?.details.blockingSessionId).toBe('sess-x');
  });

  // ISS-1320 — a run session opened over the issue's group that has since given the issue back
  // may be running on another issue of the group. It is on the row for the count, never as the
  // issue's worker, its active session, or the reason a queued job waits.
  it('does not read a live run session that no longer holds the issue as its worker', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        sessions: [
          {
            id: 'sess-moved-on',
            status: 'running',
            metadata: null,
            lane: 'run_session',
            holds: false,
          },
        ],
        jobs: [job()],
      }),
    );
    expect(out.worker.lane).toBe('none');
    expect(out.activeSession).toBeUndefined();
    expect(out.waitingOn?.reason).not.toBe('issue_busy');
  });

  it('classifies issue_busy when a sibling job is dispatched', () => {
    const dispatched = job({ id: 'job-dispatched', status: 'dispatched', type: 'plan' });
    const queued = job({ id: 'job-queued', type: 'review' });
    const out = classifyPipelineHealthForIssue(baseInput({ jobs: [dispatched, queued] }));
    expect(out.waitingOn?.reason).toBe('issue_busy');
    expect(out.waitingOn?.details.blockingJobId).toBe('job-dispatched');
  });

  it('reports job_held, not issue_busy, when the sibling blocking a queued job is held', () => {
    const held = job({ id: 'job-held', status: 'held', type: 'code' });
    const queued = job({ id: 'job-queued', type: 'review' });
    const out = classifyPipelineHealthForIssue(baseInput({ jobs: [held, queued] }));
    expect(out.waitingOn?.reason).toBe('job_held');
    expect(out.waitingOn?.details.heldJobId).toBe('job-held');
  });

  it("reports job_held when the held job is the issue's only job", () => {
    const held = job({ id: 'job-solo', status: 'held', type: 'code' });
    const out = classifyPipelineHealthForIssue(
      baseInput({ jobs: [{ ...held, failureReason: 'all_devices_exhausted' }] }),
    );
    expect(out.waitingOn?.reason).toBe('job_held');
    expect(out.waitingOn?.details.holdReason).toBe('all_devices_exhausted');
  });

  it('reports no reason for a pinned runner that already has work — a busy box still claims', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({ jobs: [job({ runnerId: 'rnr-1', type: 'plan' })] }),
    );
    expect(out.waitingOn).toBeUndefined();
  });

  it('reports queuedAt for queued-and-unblocked jobs', () => {
    const out = classifyPipelineHealthForIssue(baseInput({ jobs: [job()] }));
    expect(out.queuedAt).toBe(QUEUED_AT.toISOString());
    expect(out.waitingOn).toBeUndefined();
  });

  it('picks the earliest queued_at as the candidate (deterministic since)', () => {
    const older = job({ id: 'job-older', queuedAt: QUEUED_AT });
    const newer = job({ id: 'job-newer', queuedAt: new Date(QUEUED_AT.getTime() + 30_000) });
    const out = classifyPipelineHealthForIssue(
      baseInput({ jobs: [newer, older, job({ id: 'job-held', status: 'held' })] }),
    );
    expect(out.waitingOn?.since).toBe(QUEUED_AT.toISOString());
  });
});

describe('classifyPipelineHealthForIssue — the two gates that never clear themselves', () => {
  it.each(['paused', 'cancelled', 'failed', 'completed'])(
    'classifies run_not_running when the parent run is %s',
    (runStatus) => {
      const out = classifyPipelineHealthForIssue(
        baseInput({ jobs: [job({ pipelineRunStatus: runStatus })] }),
      );
      expect(out.waitingOn?.reason).toBe('run_not_running');
      expect(out.waitingOn?.details).toEqual({ runStatus, queuedJobId: 'job-1' });
    },
  );

  it('reports run_not_running ahead of every other queued gate', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        runnerPool: { total: 0 },
        jobs: [job({ pipelineRunStatus: 'paused' })],
      }),
    );
    expect(out.waitingOn?.reason).toBe('run_not_running');
  });

  it('classifies runner_stale when no runner is fresh, even with a pinned runner recorded', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job({ runnerId: 'rnr-1' })],
        runnerPool: { total: 0 },
      }),
    );
    expect(out.waitingOn?.reason).toBe('runner_stale');
    expect(out.waitingOn?.details).toEqual({ freshRunners: 0 });
  });

  // ISS-1228 r20 (rig): both runners online, one too old and one limited, read "No runner is online".
  describe('names the runner wait off the online runners, as the capacity notice does', () => {
    const fleet = (online: number, bars: Partial<Record<CapacityBar, number>>) => ({
      online,
      bars: { ...Object.fromEntries(CAPACITY_BARS.map((b) => [b, 0])), ...bars } as Record<
        CapacityBar,
        number
      >,
    });
    const waitWith = (f: ReturnType<typeof fleet>) =>
      classifyPipelineHealthForIssue(
        baseInput({ jobs: [job()], runnerPool: { total: 0, fleet: f } }),
      ).waitingOn;

    it('says runner_stale only where no runner is online', () => {
      expect(waitWith(fleet(0, {}))).toMatchObject({ reason: 'runner_stale' });
    });

    it('says runner_too_old where every online runner is out of date', () => {
      expect(waitWith(fleet(2, { too_old: 2 }))).toMatchObject({
        reason: 'runner_too_old',
        details: { online: 2 },
      });
    });

    it("carries the notice's sentence and next step for a mix of bars", () => {
      const wait = waitWith(fleet(2, { too_old: 1, limited: 1 }));
      expect(wait?.reason).toBe('runner_capacity');
      expect(wait?.details).toEqual({
        online: 2,
        bars: ['too_old', 'limited'],
        summary:
          'Both of its runners are online, but one is running a build too old to take work, and one is held back by an account limit. Steps keep waiting and resume by themselves once one can take them.',
        nextStep:
          "Open this project's Runners tab, then update the runner on an old build, and wait for the account limit to lift, or sign the limited runner in to an account with room.",
      });
    });

    it('names an account limit on every online runner as that, never as none online', () => {
      const wait = waitWith(fleet(1, { limited: 1 }));
      expect(wait?.reason).toBe('runner_capacity');
      expect(wait?.details?.summary).toBe(
        'Its one runner is online, but it is held back by an account limit. Steps keep waiting and resume by themselves once one can take them.',
      );
    });
  });

  it('reports no reason pool-wide when every runner is alive and busy', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({ jobs: [job()], runnerPool: { total: 2 } }),
    );
    expect(out.waitingOn).toBeUndefined();
  });
});

describe('waitingCause is a pass-through of issues.waiting_kind (RFC 0002 INV-5)', () => {
  it('reports the authored kind verbatim', () => {
    for (const kind of ['needs_decision', 'needs_resource'] as const) {
      const out = classifyPipelineHealthForIssue(
        baseInput({ issue: { id: 'i', status: 'waiting', mergedAt: null, waitingKind: kind } }),
      );
      expect(out.waitingCause).toEqual({ kind });
    }
  });

  it('reports NO cause when the kind was never authored, whatever else the row says', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        issue: {
          id: 'i',
          status: 'waiting',
          mergedAt: new Date('2026-08-11T00:00:00.000Z'),
          waitingKind: null,
        },
      }),
    );
    expect(out.waitingCause).toBeUndefined();
  });

  it('drops a stale kind on an issue that is no longer waiting', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        issue: { id: 'i', status: 'in_progress', mergedAt: null, waitingKind: 'needs_decision' },
      }),
    );
    expect(out.waitingCause).toBeUndefined();
  });
});

describe('ISS-853 — a paused run reaches the payload with nothing queued behind it', () => {
  const pausedRun = {
    runId: 'run-1',
    pauseReason: null,
    kind: null,
    detail: null,
    resumer: 'operator' as const,
    since: '2026-09-06T10:00:00.000Z',
  };

  it('carries pausedRun for an issue with NO jobs at all', () => {
    const out = classifyPipelineHealthForIssue(baseInput({ jobs: [], pausedRun }));
    expect(out.pausedRun).toEqual(pausedRun);
    expect(out.waitingOn).toBeUndefined();
  });

  it('carries pausedRun at every status, including the ones that show no banner today', () => {
    for (const status of ['approved', 'in_progress', 'needs_info', 'waiting', 'developed']) {
      const out = classifyPipelineHealthForIssue(
        baseInput({ issue: { id: 'iss-1', status, mergedAt: null, waitingKind: null }, pausedRun }),
      );
      expect(out.pausedRun, status).toEqual(pausedRun);
    }
  });

  it('carries pausedRun past the held-job early return, which sits above every queued arm', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [
          { ...job({ id: 'j-held', status: 'held' }), failureReason: 'retry_rounds_exhausted' },
        ],
        pausedRun,
      }),
    );
    expect(out.waitingOn?.reason).toBe('job_held');
    expect(out.pausedRun).toEqual(pausedRun);
  });

  it('carries pausedRun alongside run_not_running rather than instead of it', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job({ id: 'j-q', status: 'queued', pipelineRunStatus: 'paused' })],
        pausedRun,
      }),
    );
    expect(out.waitingOn?.reason).toBe('run_not_running');
    expect(out.pausedRun).toEqual(pausedRun);
  });

  it('omits the key entirely when no run is paused', () => {
    expect(classifyPipelineHealthForIssue(baseInput()).pausedRun).toBeUndefined();
  });
});
