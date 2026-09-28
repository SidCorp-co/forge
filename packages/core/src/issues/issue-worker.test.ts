/**
 * ISS-1273 — the three lanes, and the arm that says none of them answered.
 *
 * `classifyIssueWorker` is pure, so every lane is exercised here without Postgres; the SQL that
 * produces its two session binds is covered by `tests/integration/pipeline-health-e2e.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { LeaseReading } from '../pipeline/session-claim.js';
import { classifyIssueWorker, unreadableWorker, type WorkerSession } from './issue-worker.js';

function claim(over: Partial<LeaseReading> = {}): LeaseReading {
  return {
    verdict: 'live',
    holder: 'iss-1273-52b95148',
    expiresAt: new Date('2026-09-27T11:00:00.000Z'),
    fanout: 1,
    stopped: false,
    silentMs: null,
    detail: 'held',
    ...over,
  };
}

function session(over: Partial<WorkerSession> = {}): WorkerSession {
  return { id: 'sess-1', status: 'running', lane: 'job', ...over };
}

describe('classifyIssueWorker', () => {
  it('names the job lane when a session carries the issue on its own metadata', () => {
    const worker = classifyIssueWorker({ sessions: [session()], claim: null });
    expect(worker).toEqual({ lane: 'job', sessionId: 'sess-1', sessionStatus: 'running' });
  });

  it('names the run-session lane when the only bind is the run issue lease', () => {
    const worker = classifyIssueWorker({
      sessions: [session({ id: 'sess-box', lane: 'run_session', status: 'queued' })],
      claim: null,
    });
    expect(worker).toEqual({
      lane: 'run_session',
      sessionId: 'sess-box',
      sessionStatus: 'queued',
    });
  });

  it('prefers the job lane where both session binds found a row', () => {
    const worker = classifyIssueWorker({
      sessions: [session({ id: 'sess-box', lane: 'run_session' }), session({ id: 'sess-job' })],
      claim: null,
    });
    expect(worker).toMatchObject({ lane: 'job', sessionId: 'sess-job' });
  });

  it('names the claim lane, with its holder, when no session row exists', () => {
    const worker = classifyIssueWorker({ sessions: [], claim: claim({ silentMs: 4000 }) });
    expect(worker).toEqual({
      lane: 'claim',
      holder: 'iss-1273-52b95148',
      verdict: 'live',
      expiresAt: '2026-09-27T11:00:00.000Z',
      silentMs: 4000,
    });
  });

  it('prefers a live session over a claim, because core wrote the session row itself', () => {
    const worker = classifyIssueWorker({ sessions: [session()], claim: claim() });
    expect(worker).toMatchObject({ lane: 'job', sessionId: 'sess-1' });
  });

  it('does not count a terminal session row as a worker', () => {
    const worker = classifyIssueWorker({
      sessions: [session({ status: 'completed' }), session({ id: 'sess-2', status: 'failed' })],
      claim: null,
    });
    expect(worker.lane).toBe('none');
  });

  // ISS-1273 — the judge found ISS-868 told 'no agent session is bound' while carrying its own
  // uuid in `metadata.issueId`, the very key the job-lane bind joins on. The sentence has to say
  // what is actually absent, which is a LIVE session.
  it('does not say no session is bound where a finished one provably is', () => {
    const worker = classifyIssueWorker({
      sessions: [session({ status: 'completed' }), session({ id: 'sess-2', status: 'failed' })],
      claim: null,
    });
    const detail = (worker as { detail: string }).detail;
    expect(detail).not.toContain('no agent session is bound');
    expect(detail).toContain('none of the 2 agent sessions bound to this issue on the job lane');
    expect(detail).toContain('(completed, failed)');
  });

  // `liveSession` tests queued-or-running, which is not the same as terminal: `idle` is the
  // column's own default and is neither. A clause calling it finished would be a second sentence
  // asserting more than the test behind it knows, which is the defect this round is repairing.
  it('does not call a bound session finished where it is idle rather than terminal', () => {
    const worker = classifyIssueWorker({
      sessions: [session({ id: 'sess-idle', status: 'idle' })],
      claim: null,
    });
    const detail = (worker as { detail: string }).detail;
    expect(detail).not.toContain('finished');
    expect(detail).toContain('is queued or running (idle)');
  });

  it('names both session lanes where a finished row sits on each', () => {
    const worker = classifyIssueWorker({
      sessions: [
        session({ status: 'completed' }),
        session({ id: 'sess-box', lane: 'run_session', status: 'failed' }),
      ],
      claim: null,
    });
    expect((worker as { detail: string }).detail).toContain('on the job and run_session lane');
    expect((worker as { detail: string }).detail).toContain('(completed, failed)');
  });

  it('answers `none` with a sentence rather than an absent field when nothing holds the issue', () => {
    const worker = classifyIssueWorker({ sessions: [], claim: null });
    expect(worker).toEqual({
      lane: 'none',
      detail:
        'no agent session is bound to this issue on either session lane, and its record carries no claim',
    });
  });

  it('names the verdict in the `none` sentence when a claim exists but is not work in progress', () => {
    const worker = classifyIssueWorker({
      sessions: [],
      claim: claim({ verdict: 'expired', detail: 'expired 12 minutes ago' }),
    });
    expect(worker).toEqual({
      lane: 'none',
      detail:
        'no agent session is bound to this issue on either session lane, and the claim by iss-1273-52b95148 reads expired: expired 12 minutes ago',
    });
  });

  // ISS-1273 — `pipeline/session-claim.ts` sets `detail` to '' for every verdict but `malformed`,
  // which is the shape the deployment actually serves: the case above passes on a detail the
  // production reader never produces. 295 of 1317 issues ended their sentence at a bare colon.
  it('does not end the sentence at a colon where the claim reading carries no detail', () => {
    const worker = classifyIssueWorker({
      sessions: [],
      claim: claim({ verdict: 'expired', detail: '' }),
    });
    expect(worker).toEqual({
      lane: 'none',
      detail:
        'no agent session is bound to this issue on either session lane, and the claim by iss-1273-52b95148 reads expired',
    });
    expect((worker as { detail: string }).detail.endsWith(':')).toBe(false);
  });

  it('carries the reason where the reading does have one, so the colon is not simply dropped', () => {
    const worker = classifyIssueWorker({
      sessions: [],
      claim: claim({ verdict: 'malformed', detail: 'holder is not a non-empty string' }),
    });
    expect((worker as { detail: string }).detail).toContain(
      'reads malformed: holder is not a non-empty string',
    );
  });

  it('a claim with a holder nobody named still produces a sentence, never a throw', () => {
    const worker = classifyIssueWorker({
      sessions: [],
      claim: claim({ verdict: 'malformed', holder: null, detail: 'no holder field' }),
    });
    expect(worker).toMatchObject({ lane: 'none' });
    expect((worker as { detail: string }).detail).toContain('an unnamed holder');
  });

  // ISS-1273 — the route serves this when the loader threw. Before it, the fallback was
  // `{ stage }` alone: the status column the caller already had, served as computed health.
  it('names a failed derivation as its own answer, not as nobody working the issue', () => {
    const worker = unreadableWorker('the loader threw');
    expect(worker.lane).toBe('unreadable');
    expect(worker.lane).not.toBe('none');
  });

  it('refuses to report a live claim carrying no holder as the claim lane', () => {
    const worker = classifyIssueWorker({ sessions: [], claim: claim({ holder: null }) });
    expect(worker.lane).toBe('none');
  });
});
