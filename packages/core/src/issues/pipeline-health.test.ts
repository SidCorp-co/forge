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
  recordTickAt,
  getLastTickAt,
  resetLastTickAtForTest,
} = await import('./pipeline-health.js');
type ClassifyInput = import('./pipeline-health.js').ClassifyInput;

const QUEUED_AT = new Date('2026-05-17T08:00:00.000Z');
const TICK_AT = new Date('2026-05-17T08:01:00.000Z');

function baseInput(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    issue: { id: 'iss-1', status: 'approved' },
    sessions: [],
    jobs: [],
    deps: [],
    runningIssueIds: new Set(),
    runningIssueCount: 0,
    cap: 5,
    runnerInFlight: new Map(),
    lastTickAt: null,
    ...over,
  };
}

function job(over: Partial<{
  id: string;
  type: string;
  status: string;
  queuedAt: Date;
  runnerId: string | null;
  agentSessionId: string | null;
}> = {}) {
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

  it('classifies waiting_on_dep for a non-terminal blocks parent', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job()],
        deps: [{ fromIssueId: 'iss-blocker', kind: 'blocks', fromStatus: 'open' }],
      }),
    );
    expect(out.waitingOn?.reason).toBe('waiting_on_dep');
    expect(out.waitingOn?.details.blockerIssueIds).toEqual(['iss-blocker']);
  });

  it('ignores `blocks` parents that are released/closed', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job()],
        deps: [{ fromIssueId: 'iss-blocker', kind: 'blocks', fromStatus: 'released' }],
      }),
    );
    expect(out.waitingOn).toBeUndefined();
  });

  it('classifies waiting_on_decomp_parent ONLY for release jobs', () => {
    const plan = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job({ type: 'plan' })],
        deps: [{ fromIssueId: 'iss-parent', kind: 'decomposes', fromStatus: 'approved' }],
      }),
    );
    expect(plan.waitingOn).toBeUndefined();

    const release = classifyPipelineHealthForIssue(
      baseInput({
        jobs: [job({ type: 'release' })],
        deps: [{ fromIssueId: 'iss-parent', kind: 'decomposes', fromStatus: 'approved' }],
      }),
    );
    expect(release.waitingOn?.reason).toBe('waiting_on_decomp_parent');
    expect(release.waitingOn?.details.parentIssueId).toBe('iss-parent');
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
        runnerInFlight: new Map([
          ['rnr-1', { type: 'claude-code', cap: 1, inFlight: 1 }],
        ]),
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
        deps: [{ fromIssueId: 'iss-blocker', kind: 'blocks', fromStatus: 'open' }],
      }),
    );
    expect(out.waitingOn?.since).toBe(QUEUED_AT.toISOString());
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
