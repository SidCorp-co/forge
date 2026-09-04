/**
 * ISS-164 — pipelineHealth classifier unit tests.
 *
 * The pure `classifyPipelineHealthForIssue` takes pre-fetched rows so each
 * L1..L4 branch can be exercised without touching Postgres or drizzle. The
 * SQL paths are covered separately by
 * `tests/integration/pipeline-health-e2e.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

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

const { classifyPipelineHealthForIssue, recordTickAt, getLastTickAt, resetLastTickAtForTest } =
  await import('./pipeline-health.js');
type ClassifyInput = import('./pipeline-health.js').ClassifyInput;

const QUEUED_AT = new Date('2026-05-17T08:00:00.000Z');
const TICK_AT = new Date('2026-05-17T08:01:00.000Z');

function baseInput(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    issue: { id: 'iss-1', status: 'approved', mergedAt: null, waitingKind: null },
    sessions: [],
    jobs: [],
    deps: [],
    runningIssueIds: new Set(),
    runningIssueCount: 0,
    cap: 5,
    runnerInFlight: new Map(),
    runnerPool: { total: 1, withCapacity: 1 },
    lastTickAt: null,
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
    expect(out).toEqual({ stage: 'approved' });
  });

  it('includes lastTickAt when set', () => {
    const out = classifyPipelineHealthForIssue(baseInput({ lastTickAt: TICK_AT }));
    expect(out.lastTickAt).toBe(TICK_AT.toISOString());
  });

  it('exposes activeSession for a running session', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        sessions: [
          {
            id: 'sess-1',
            status: 'running',
            metadata: { skill: 'forge-code' },
          },
        ],
      }),
    );
    expect(out.activeSession).toEqual({
      id: 'sess-1',
      status: 'running',
      skill: 'forge-code',
    });
  });

  it('classifies issue_busy when a sibling session is running', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        sessions: [{ id: 'sess-x', status: 'running', metadata: null }],
        jobs: [job()],
      }),
    );
    expect(out.waitingOn?.reason).toBe('issue_busy');
    expect(out.waitingOn?.details.blockingSessionId).toBe('sess-x');
  });

  it('classifies issue_busy when a sibling job is dispatched', () => {
    const dispatched = job({ id: 'job-dispatched', status: 'dispatched', type: 'plan' });
    const queued = job({ id: 'job-queued', type: 'review' });
    const out = classifyPipelineHealthForIssue(baseInput({ jobs: [dispatched, queued] }));
    expect(out.waitingOn?.reason).toBe('issue_busy');
    expect(out.waitingOn?.details.blockingJobId).toBe('job-dispatched');
  });

  // cm:guard `job_held` must OUTRANK issue_busy for a held sibling (RFC 0002) — both are true, but only job_held names the machine condition and tells the reader no action is needed; reporting issue_busy instead sends them looking for an active run that does not exist
  it('reports job_held, not issue_busy, when the sibling blocking a queued job is held', () => {
    const held = job({ id: 'job-held', status: 'held', type: 'code' });
    const queued = job({ id: 'job-queued', type: 'review' });
    const out = classifyPipelineHealthForIssue(baseInput({ jobs: [held, queued] }));
    expect(out.waitingOn?.reason).toBe('job_held');
    expect(out.waitingOn?.details.heldJobId).toBe('job-held');
  });

  // cm:guard a held job with NO queued sibling is the common case and the one the old code reported as nothing at all — keep this test even though it looks like a duplicate of the one above; they exercise opposite sides of the `queuedJobs.length === 0` return
  it("reports job_held when the held job is the issue's only job", () => {
    const held = job({ id: 'job-solo', status: 'held', type: 'code' });
    const out = classifyPipelineHealthForIssue(
      baseInput({ jobs: [{ ...held, failureReason: 'all_devices_exhausted' }] }),
    );
    expect(out.waitingOn?.reason).toBe('job_held');
    expect(out.waitingOn?.details.holdReason).toBe('all_devices_exhausted');
  });

  it('classifies waiting_on_dep for an unmerged blocks parent', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job()],
        deps: [
          { fromIssueId: 'iss-blocker', kind: 'blocks', fromStatus: 'open', fromMergedAt: null },
        ],
      }),
    );
    expect(out.waitingOn?.reason).toBe('waiting_on_dep');
    expect(out.waitingOn?.details.blockerIssueIds).toEqual(['iss-blocker']);
    expect(out.waitingOn?.details.closedUnmergedBlockerIssueIds).toBeUndefined();
  });

  it('ignores `blocks` parents whose merged_at is stamped', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job()],
        deps: [
          {
            fromIssueId: 'iss-blocker',
            kind: 'blocks',
            fromStatus: 'released',
            fromMergedAt: QUEUED_AT,
          },
        ],
      }),
    );
    expect(out.waitingOn).toBeUndefined();
  });

  it('flags a closed-but-unmerged blocker under a stampable base (gate parity, ISS-639)', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job()],
        deps: [
          { fromIssueId: 'iss-blocker', kind: 'blocks', fromStatus: 'closed', fromMergedAt: null },
        ],
      }),
    );
    expect(out.waitingOn?.reason).toBe('waiting_on_dep');
    expect(out.waitingOn?.details.closedUnmergedBlockerIssueIds).toEqual(['iss-blocker']);
  });

  it('classifies project_full when running count >= cap', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        cap: 1,
        runningIssueIds: new Set(['iss-other']),
        runningIssueCount: 1,
        jobs: [job()],
      }),
    );
    expect(out.waitingOn?.reason).toBe('project_full');
    expect(out.waitingOn?.details.cap).toBe(1);
    expect(out.waitingOn?.details.running).toEqual(['iss-other']);
  });

  it('does NOT classify project_full when the candidate issue is in the running set', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        cap: 1,
        runningIssueIds: new Set(['iss-1']),
        runningIssueCount: 1,
        jobs: [job()],
      }),
    );
    expect(out.waitingOn).toBeUndefined();
  });

  it('classifies runner_full when the candidate runner is saturated', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        cap: 5,
        jobs: [job({ runnerId: 'rnr-1', type: 'plan' })],
        runnerInFlight: new Map([['rnr-1', { type: 'claude-code', cap: 1, inFlight: 1 }]]),
      }),
    );
    expect(out.waitingOn?.reason).toBe('runner_full');
    expect(out.waitingOn?.details).toEqual({ runnerId: 'rnr-1', cap: 1, inFlight: 1 });
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
      baseInput({
        jobs: [newer, older],
        deps: [
          { fromIssueId: 'iss-blocker', kind: 'blocks', fromStatus: 'open', fromMergedAt: null },
        ],
      }),
    );
    expect(out.waitingOn?.since).toBe(QUEUED_AT.toISOString());
  });
});

describe('classifyPipelineHealthForIssue — dependency satisfaction parity', () => {
  it('keeps a merged blocker at reopen in waiting_on_dep', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job()],
        deps: [
          {
            fromIssueId: 'iss-blocker',
            kind: 'blocks',
            fromStatus: 'reopen',
            fromMergedAt: QUEUED_AT,
          },
        ],
      }),
    );
    expect(out.waitingOn?.reason).toBe('waiting_on_dep');
    expect(out.waitingOn?.details.blockerIssueIds).toEqual(['iss-blocker']);
  });

});

describe('classifyPipelineHealthForIssue — the two gates that never clear themselves', () => {
  // cm:guard these four are the regression suite for the two blind spots — a paused parent run and an empty runner pool both reported NO waitingOn at all, which is indistinguishable from a healthy issue awaiting its turn; that silence is what let ISS-576/ISS-652 sit paused for 3 days
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
        cap: 1,
        runningIssueIds: new Set(['iss-other']),
        runningIssueCount: 1,
        runnerPool: { total: 0, withCapacity: 0 },
        deps: [
          { fromIssueId: 'iss-blocker', kind: 'blocks', fromStatus: 'open', fromMergedAt: null },
        ],
        jobs: [job({ pipelineRunStatus: 'paused' })],
      }),
    );
    expect(out.waitingOn?.reason).toBe('run_not_running');
  });

  it('classifies runner_stale when no runner is fresh, even with a pinned runner recorded', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job({ runnerId: 'rnr-1' })],
        runnerInFlight: new Map([['rnr-1', { type: 'claude-code', cap: 1, inFlight: 1 }]]),
        runnerPool: { total: 0, withCapacity: 0 },
      }),
    );
    expect(out.waitingOn?.reason).toBe('runner_stale');
    expect(out.waitingOn?.details).toEqual({ freshRunners: 0 });
  });

  it('classifies runner_full pool-wide for an unpinned candidate when every runner is busy', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({ jobs: [job()], runnerPool: { total: 2, withCapacity: 0 } }),
    );
    expect(out.waitingOn?.reason).toBe('runner_full');
    expect(out.waitingOn?.details).toEqual({ freshRunners: 2, runnersWithCapacity: 0 });
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

  // cm:guard the five-way derivation this replaced inferred `merged_parked` from exactly this row shape (waiting + a merged_at) — a re-introduced inference is what put an override button on the wrong park on ISS-163
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

describe('lastTickAt heartbeat', () => {
  it('records and retrieves per-project tick timestamps', () => {
    resetLastTickAtForTest();
    expect(getLastTickAt('p-1')).toBeNull();
    const at = new Date('2026-05-17T09:00:00.000Z');
    recordTickAt('p-1', at);
    expect(getLastTickAt('p-1')).toEqual(at);
    expect(getLastTickAt('p-other')).toBeNull();
  });

  it('reset clears all entries', () => {
    recordTickAt('p-1');
    recordTickAt('p-2');
    resetLastTickAtForTest();
    expect(getLastTickAt('p-1')).toBeNull();
    expect(getLastTickAt('p-2')).toBeNull();
  });
});
