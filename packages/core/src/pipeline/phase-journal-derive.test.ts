import { describe, expect, it } from 'vitest';
import {
  type DerivableJob,
  deriveStagedPhase,
  deriveStagedPhases,
} from './phase-journal-derive.js';

const T0 = new Date('2026-08-01T10:00:00Z');
const T1 = new Date('2026-08-01T10:05:00Z');

function job(over: Partial<DerivableJob> = {}): DerivableJob {
  return {
    id: 'job-1',
    projectId: 'proj-1',
    issueId: 'issue-1',
    pipelineRunId: 'run-1',
    type: 'code',
    status: 'done',
    dispatchedAt: T0,
    finishedAt: T1,
    agentSessionId: 'sess-1',
    ...over,
  };
}

describe('deriveStagedPhase', () => {
  it('prefers the session start over dispatch, matching the view it must agree with', () => {
    const sessionStart = new Date('2026-08-01T10:02:00Z');
    const row = deriveStagedPhase(job({ sessionStartedAt: sessionStart }), 1);

    expect(row?.startedAt).toEqual(sessionStart);
  });

  it('falls back to dispatch when the job never got a session', () => {
    expect(
      deriveStagedPhase(job({ agentSessionId: null, sessionStartedAt: null }), 1)?.startedAt,
    ).toEqual(T0);
  });

  it('records a cancelled job as abandoned, not failed', () => {
    expect(deriveStagedPhase(job({ status: 'cancelled' }), 1)?.outcome).toBe('abandoned');
    expect(deriveStagedPhase(job({ status: 'failed' }), 1)?.outcome).toBe('failed');
    expect(deriveStagedPhase(job({ status: 'done' }), 1)?.outcome).toBe('ok');
  });

  it('produces nothing for a job still in flight', () => {
    expect(deriveStagedPhase(job({ status: 'running', finishedAt: null }), 1)).toBeNull();
    expect(deriveStagedPhase(job({ status: 'queued', finishedAt: null }), 1)).toBeNull();
  });

  it('produces nothing when there is no run to attach the phase to', () => {
    expect(deriveStagedPhase(job({ pipelineRunId: null }), 1)).toBeNull();
  });

  it('produces nothing when neither start timestamp exists, rather than inventing one', () => {
    expect(deriveStagedPhase(job({ dispatchedAt: null, sessionStartedAt: null }), 1)).toBeNull();
  });

  it('marks the row system-derived, which is what keeps it out of the verdict rule', () => {
    expect(deriveStagedPhase(job(), 1)?.source).toBe('system');
  });
});

describe('deriveStagedPhases', () => {
  // cm:guard a reopen sends `code` round a second time on the SAME run; without per-(run,phase) numbering both rows claim attempt 1 and the unique index rejects the second, silently losing the retry from every metric
  it('numbers a repeated phase on one run instead of colliding', () => {
    const rows = deriveStagedPhases([
      job({ id: 'a', type: 'code' }),
      job({ id: 'b', type: 'review' }),
      job({ id: 'c', type: 'code' }),
    ]);

    expect(rows.map((r) => [r.jobId, r.phase, r.attempt])).toEqual([
      ['a', 'code', 1],
      ['b', 'review', 1],
      ['c', 'code', 2],
    ]);
  });

  it('numbers each run independently', () => {
    const rows = deriveStagedPhases([
      job({ id: 'a', pipelineRunId: 'run-1', type: 'code' }),
      job({ id: 'b', pipelineRunId: 'run-2', type: 'code' }),
    ]);

    expect(rows.map((r) => r.attempt)).toEqual([1, 1]);
  });

  it('does not spend an attempt number on a job it skipped', () => {
    const rows = deriveStagedPhases([
      job({ id: 'a', type: 'code', status: 'running', finishedAt: null }),
      job({ id: 'b', type: 'code' }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempt).toBe(1);
  });
});
