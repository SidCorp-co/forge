/**
 * ISS-789 — the `stale_trigger` arm of the pipelineHealth classifier.
 *
 * Split from `pipeline-health.test.ts` because this one arm carries the most
 * false-positive cases of any of them: every exemption below is a legitimate
 * job the gate it mirrors would otherwise terminally discard.
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

vi.mock('../db/client.js', () => ({ db: { select: vi.fn(), execute: vi.fn() } }));

const { classifyPipelineHealthForIssue } = await import('./pipeline-health.js');
type ClassifyInput = import('./pipeline-health.js').ClassifyInput;

const QUEUED_AT = new Date('2026-05-17T08:00:00.000Z');

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
    stageStatus: string | null;
    retryAfterAt: Date | null;
  }> = {},
) {
  return {
    id: over.id ?? 'job-1',
    type: over.type ?? 'plan',
    status: over.status ?? 'queued',
    queuedAt: QUEUED_AT,
    runnerId: null,
    agentSessionId: null,
    pipelineRunStatus: 'running',
    stageStatus: over.stageStatus ?? null,
    retryAfterAt: over.retryAfterAt ?? null,
  };
}

// cm:edge lockstep -> packages/core/src/jobs/dispatch-gates.ts — every case here mirrors an outcome of `predicates.staleTrigger`; the gate deciding differently from this classifier is the idle-and-actionable lie the file's guard names
describe('stale_trigger — the gate whose job answers a trigger the issue has left (ISS-789)', () => {
  it('reports it when the queued job declares a trigger the issue is no longer at', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        issue: { id: 'iss-1', status: 'testing', mergedAt: null, waitingKind: null },
        jobs: [job({ type: 'fix', stageStatus: 'reopen' })],
      }),
    );
    expect(out.waitingOn?.reason).toBe('stale_trigger');
    expect(out.waitingOn?.details).toMatchObject({
      declaredTrigger: 'reopen',
      liveStatus: 'testing',
    });
  });

  it('stays silent when the declared trigger IS the live status', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        issue: { id: 'iss-1', status: 'reopen', mergedAt: null, waitingKind: null },
        jobs: [job({ type: 'fix', stageStatus: 'reopen' })],
      }),
    );
    expect(out.waitingOn).toBeUndefined();
  });

  // cm:guard this case is the one that matters — a code/fix retry legitimately finds `in_progress`, the status its own predecessor set via forge_step_start, and calling that stale would report (and, in the gate, discard) every recovery attempt
  it('accepts the job type own in-flight working status', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        issue: { id: 'iss-1', status: 'in_progress', mergedAt: null, waitingKind: null },
        jobs: [job({ type: 'code', stageStatus: 'approved' })],
      }),
    );
    expect(out.waitingOn).toBeUndefined();
  });

  // cm:guard the allowance is keyed on the job TYPE, and this is the case that proves it — `POST /run-pipeline-step` re-fires a stage WITHOUT bouncing the status, so it stamps the issue's live status; a trigger-keyed allowance sees ('developed','in_progress'), matches nothing, and discards the retry of a stage a human deliberately re-fired
  it('accepts the working status for a stage re-fired off its own trigger', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        issue: { id: 'iss-1', status: 'in_progress', mergedAt: null, waitingKind: null },
        jobs: [job({ type: 'code', stageStatus: 'developed' })],
      }),
    );
    expect(out.waitingOn).toBeUndefined();
  });

  // cm:guard `drive` must be exempt by TYPE — the autonomous driver is stamped `stageStatus:'open'` and then moves the issue anywhere it likes, so treating it like a staged step reports (and in the gate discards) the retry of a session that owns the issue's whole walk, and `dispatchAutonomous` enqueues at the entry status only, so nothing re-creates it
  it('never reports the autonomous drive job, whatever the issue status is', () => {
    for (const status of ['in_progress', 'waiting', 'developed', 'closed'] as const) {
      const out = classifyPipelineHealthForIssue(
        baseInput({
          issue: { id: 'iss-1', status, mergedAt: null, waitingKind: null },
          jobs: [job({ type: 'drive', stageStatus: 'open' })],
        }),
      );
      expect(out.waitingOn?.reason).not.toBe('stale_trigger');
    }
  });

  // cm:guard the CASE resolves `retry_cooldown` in an EARLIER arm, so a cooldown-gated job is never discarded however stale it is — reporting stale_trigger here would promise the reader a discard on the next sweep that the sweep will refuse for up to the whole cooldown
  it('yields to an unexpired retry cooldown, matching the CASE arm order', () => {
    const now = new Date('2026-05-17T08:00:30.000Z');
    const out = classifyPipelineHealthForIssue(
      baseInput({
        now,
        issue: { id: 'iss-1', status: 'testing', mergedAt: null, waitingKind: null },
        jobs: [
          job({
            type: 'fix',
            stageStatus: 'reopen',
            retryAfterAt: new Date('2026-05-17T08:01:00.000Z'),
          }),
        ],
      }),
    );
    // cm:guard yields TO the cooldown reason, never to silence — reporting nothing is the idle-and-actionable render this file's sibling guard forbids, and it is what `main` did for every cooldown-gated job
    expect(out.waitingOn?.reason).toBe('retry_cooldown');
  });

  // cm:guard the cooldown arm's POSITION is what these three pin, and nothing else did — before them the arm could be moved below issue_busy or blocked_by and no test would notice, while the stale arm right below has ordering assertions at both levels
  it('reports the cooldown ahead of issue_busy, matching the CASE arm order', () => {
    const now = new Date('2026-05-17T08:00:30.000Z');
    const out = classifyPipelineHealthForIssue(
      baseInput({
        now,
        issue: { id: 'iss-1', status: 'approved', mergedAt: null, waitingKind: null },
        jobs: [
          job({ id: 'job-live', type: 'code', status: 'running' }),
          job({
            id: 'job-next',
            type: 'plan',
            stageStatus: 'clarified',
            retryAfterAt: new Date('2026-05-17T08:01:00.000Z'),
          }),
        ],
      }),
    );
    expect(out.waitingOn?.reason).toBe('retry_cooldown');
  });

  it('reports the cooldown ahead of blocked_by, matching the CASE arm order', () => {
    const now = new Date('2026-05-17T08:00:30.000Z');
    const out = classifyPipelineHealthForIssue(
      baseInput({
        now,
        deps: [
          {
            fromIssueId: 'iss-blocker',
            kind: 'blocks',
            fromStatus: 'approved',
            fromMergedAt: null,
          },
        ],
        jobs: [
          job({
            type: 'plan',
            stageStatus: 'clarified',
            retryAfterAt: new Date('2026-05-17T08:01:00.000Z'),
          }),
        ],
      }),
    );
    expect(out.waitingOn?.reason).toBe('retry_cooldown');
  });

  it('names the job and the deadline so the wait is not a mystery', () => {
    const now = new Date('2026-05-17T08:00:30.000Z');
    const retryAfterAt = new Date('2026-05-17T08:01:00.000Z');
    const out = classifyPipelineHealthForIssue(
      baseInput({
        now,
        jobs: [job({ id: 'job-cool', type: 'plan', stageStatus: 'clarified', retryAfterAt })],
      }),
    );
    expect(out.waitingOn).toMatchObject({
      reason: 'retry_cooldown',
      details: {
        queuedJobId: 'job-cool',
        queuedJobType: 'plan',
        retryAfterAt: retryAfterAt.toISOString(),
      },
    });
  });

  it('reports it again once the cooldown has expired', () => {
    const now = new Date('2026-05-17T08:02:00.000Z');
    const out = classifyPipelineHealthForIssue(
      baseInput({
        now,
        issue: { id: 'iss-1', status: 'testing', mergedAt: null, waitingKind: null },
        jobs: [
          job({
            type: 'fix',
            stageStatus: 'reopen',
            retryAfterAt: new Date('2026-05-17T08:01:00.000Z'),
          }),
        ],
      }),
    );
    expect(out.waitingOn?.reason).toBe('stale_trigger');
  });

  it('stays silent for a job that declared no trigger at all', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        issue: { id: 'iss-1', status: 'testing', mergedAt: null, waitingKind: null },
        jobs: [job({ type: 'pm', stageStatus: null })],
      }),
    );
    expect(out.waitingOn).toBeUndefined();
  });

  it('yields to issue_busy, so a sibling step mid-flight is never reported as staleness', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({
        issue: { id: 'iss-1', status: 'in_progress', mergedAt: null, waitingKind: null },
        jobs: [
          job({ id: 'job-live', type: 'code', status: 'running', stageStatus: 'approved' }),
          job({ id: 'job-next', type: 'review', stageStatus: 'developed' }),
        ],
      }),
    );
    expect(out.waitingOn?.reason).toBe('issue_busy');
  });
});
