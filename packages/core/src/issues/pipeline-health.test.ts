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

const {
  classifyPipelineHealthForIssue,
  classifyWaitingCause,
  recordTickAt,
  getLastTickAt,
  resetLastTickAtForTest,
} = await import('./pipeline-health.js');
type ClassifyInput = import('./pipeline-health.js').ClassifyInput;
type PipelineHealthLatestRun = import('./pipeline-health.js').PipelineHealthLatestRun;

const QUEUED_AT = new Date('2026-05-17T08:00:00.000Z');
const TICK_AT = new Date('2026-05-17T08:01:00.000Z');

function baseInput(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    issue: { id: 'iss-1', status: 'approved', mergedAt: null },
    sessions: [],
    jobs: [],
    deps: [],
    decompChildren: [],
    runningIssueIds: new Set(),
    runningIssueCount: 0,
    cap: 5,
    baseStampable: true,
    runnerInFlight: new Map(),
    lastTickAt: null,
    latestRun: null,
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
  }> = {},
) {
  return {
    id: over.id ?? 'job-1',
    type: over.type ?? 'plan',
    status: over.status ?? 'queued',
    queuedAt: over.queuedAt ?? QUEUED_AT,
    runnerId: over.runnerId ?? null,
    agentSessionId: over.agentSessionId ?? null,
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

  it('honors the closed bypass for an unstampable base (manual merge projects)', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        baseStampable: false,
        jobs: [job()],
        deps: [
          { fromIssueId: 'iss-blocker', kind: 'blocks', fromStatus: 'closed', fromMergedAt: null },
        ],
      }),
    );
    expect(out.waitingOn).toBeUndefined();
  });

  it('classifies waiting_on_decomp_children for a parent forward job with unmerged children', () => {
    // Non-forward job types are not gated on decompose children.
    const triage = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job({ type: 'triage' })],
        decompChildren: [{ childIssueId: 'iss-child', status: 'in_progress', mergedAt: null }],
      }),
    );
    expect(triage.waitingOn).toBeUndefined();

    const code = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job({ type: 'code' })],
        decompChildren: [{ childIssueId: 'iss-child', status: 'in_progress', mergedAt: null }],
      }),
    );
    expect(code.waitingOn?.reason).toBe('waiting_on_decomp_children');
    expect(code.waitingOn?.details.childIssueIds).toEqual(['iss-child']);

    // A merged child satisfies the gate.
    const satisfied = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job({ type: 'code' })],
        decompChildren: [{ childIssueId: 'iss-child', status: 'released', mergedAt: QUEUED_AT }],
      }),
    );
    expect(satisfied.waitingOn).toBeUndefined();
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

function run(over: Partial<PipelineHealthLatestRun> = {}): PipelineHealthLatestRun {
  return {
    id: over.id ?? 'run-1',
    status: over.status ?? 'paused',
    pauseReason: over.pauseReason ?? null,
  };
}

describe('classifyWaitingCause (ISS-828)', () => {
  it('reopen_cap: paused run with a `reopen_cap:` pause reason', () => {
    expect(
      classifyWaitingCause({
        mergedAt: null,
        decompChildCount: 0,
        latestRun: run({ pauseReason: 'reopen_cap:developed' }),
      }),
    ).toBe('reopen_cap');
  });

  it('decompose_parent: outgoing decompose edges exist', () => {
    expect(classifyWaitingCause({ mergedAt: null, decompChildCount: 2, latestRun: null })).toBe(
      'decompose_parent',
    );
  });

  it('merged_parked: mergedAt is stamped (stranded / BLOCKED-FIXTURE fold)', () => {
    expect(
      classifyWaitingCause({
        mergedAt: new Date('2026-08-11T00:00:00.000Z'),
        decompChildCount: 0,
        latestRun: null,
      }),
    ).toBe('merged_parked');
  });

  it('retry_exhausted: the run is terminal (finalize-failure closed it)', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(
        classifyWaitingCause({ mergedAt: null, decompChildCount: 0, latestRun: run({ status }) }),
      ).toBe('retry_exhausted');
    }
  });

  it('plan_approval: default — no run, or a plain running/paused run', () => {
    expect(classifyWaitingCause({ mergedAt: null, decompChildCount: 0, latestRun: null })).toBe(
      'plan_approval',
    );
    expect(
      classifyWaitingCause({
        mergedAt: null,
        decompChildCount: 0,
        latestRun: run({ status: 'running' }),
      }),
    ).toBe('plan_approval');
    // A paused run with an unrecognized/absent reason is not `reopen_cap` —
    // missing_skill/stage_stalled never transition the issue to `waiting` in
    // the first place (see the `WaitingCause` doc comment), so this is the
    // safe generic fallback for anything else.
    expect(
      classifyWaitingCause({
        mergedAt: null,
        decompChildCount: 0,
        latestRun: run({ pauseReason: null }),
      }),
    ).toBe('plan_approval');
  });

  it('precedence: a paused reopen_cap run wins over decompChildren/merged/terminal', () => {
    expect(
      classifyWaitingCause({
        mergedAt: new Date('2026-08-11T00:00:00.000Z'),
        decompChildCount: 3,
        latestRun: run({ pauseReason: 'reopen_cap:developed' }),
      }),
    ).toBe('reopen_cap');
  });

  // cm:why this assertion was inverted on 2026-08-13. It previously demanded `decompose_parent`, which is what put the plan-approval copy and a live `Approve` button on ISS-812 — an epic merged 2026-08-12T05:38 whose code was already on main and deployed. The test locked the defect in, so fixing the classifier meant fixing the test that ratified it.
  it('precedence: merged_parked wins over decompose_parent — a merged epic is not awaiting approval to START coding', () => {
    expect(
      classifyWaitingCause({
        mergedAt: new Date('2026-08-11T00:00:00.000Z'),
        decompChildCount: 1,
        latestRun: run({ status: 'failed' }),
      }),
    ).toBe('merged_parked');
  });

  it('decompose_parent still wins over a terminal run while the parent is UNmerged', () => {
    expect(
      classifyWaitingCause({
        mergedAt: null,
        decompChildCount: 1,
        latestRun: run({ status: 'failed' }),
      }),
    ).toBe('decompose_parent');
  });

  it('precedence: merged_parked wins over a terminal run', () => {
    expect(
      classifyWaitingCause({
        mergedAt: new Date('2026-08-11T00:00:00.000Z'),
        decompChildCount: 0,
        latestRun: run({ status: 'failed' }),
      }),
    ).toBe('merged_parked');
  });
});

describe('classifyPipelineHealthForIssue — waitingCause wiring', () => {
  it('attaches waitingCause only when issue.status is `waiting`', () => {
    const notWaiting = classifyPipelineHealthForIssue(
      baseInput({ issue: { id: 'i', status: 'approved', mergedAt: null } }),
    );
    expect(notWaiting.waitingCause).toBeUndefined();

    const waiting = classifyPipelineHealthForIssue(
      baseInput({ issue: { id: 'i', status: 'waiting', mergedAt: null } }),
    );
    expect(waiting.waitingCause).toEqual({ kind: 'plan_approval' });
  });

  it('reflects the reopen-cap park end to end', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        issue: { id: 'i', status: 'waiting', mergedAt: null },
        latestRun: run({ pauseReason: 'reopen_cap:developed' }),
      }),
    );
    expect(out.waitingCause).toEqual({ kind: 'reopen_cap' });
  });

  it('reflects a decompose-parent park even with no active run', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        issue: { id: 'i', status: 'waiting', mergedAt: null },
        decompChildren: [{ childIssueId: 'child-1', status: 'draft', mergedAt: null }],
      }),
    );
    expect(out.waitingCause).toEqual({ kind: 'decompose_parent' });
  });

  it('reflects a merged-but-parked (stranded / BLOCKED-FIXTURE) park', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        issue: { id: 'i', status: 'waiting', mergedAt: new Date('2026-08-11T00:00:00.000Z') },
      }),
    );
    expect(out.waitingCause).toEqual({ kind: 'merged_parked' });
  });

  it('reflects a retry-exhausted park (closed run, no queued jobs)', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        issue: { id: 'i', status: 'waiting', mergedAt: null },
        latestRun: run({ status: 'failed', pauseReason: null }),
      }),
    );
    expect(out.waitingCause).toEqual({ kind: 'retry_exhausted' });
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
