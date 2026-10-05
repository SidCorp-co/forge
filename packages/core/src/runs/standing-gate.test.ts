import { describe, expect, it } from 'vitest';
import { liveOf } from './standing-live.js';
import { stuckOf } from './standing-stuck.js';
import type { RunFacts, StandingContext } from './standing-types.js';

const now = new Date('2026-10-05T12:00:00Z');
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

const ctx = {
  now,
  viewer: null,
  slots: null,
  queuedGates: new Map(),
  stuckAfterMs: 3 * 60_000,
} as unknown as StandingContext;

const otherLock = (expiresAt: Date) => ({
  environment: 'production',
  runId: 'run-holder',
  subject: 'v1.2.0',
  acquiredAt: minutes(-10),
  expiresAt,
});

function release(over: Partial<Record<keyof RunFacts, unknown>> = {}): RunFacts {
  return {
    run: {
      id: 'run-waiter',
      status: 'running',
      startedAt: minutes(-20),
      updatedAt: minutes(-20),
      pauseReason: null,
      releaseVersion: '1.3.0',
    },
    issue: null,
    session: null,
    job: null,
    ledger: null,
    question: null,
    approval: null,
    master: null,
    liveJobs: 0,
    deployLocks: [],
    foreignLocks: [otherLock(minutes(5))],
    releaseAttempt: null,
    ...over,
  } as unknown as RunFacts;
}

describe('agent-run-standing waiting_gate: a deploy lock another run holds', () => {
  it('serves a release behind it as waiting on the deploy_locked gate, resuming at the lock expiry', () => {
    const d = liveOf(release(), ctx);
    expect(d.state).toBe('waiting_gate');
    expect(d.waitingOn).toEqual({
      kind: 'gate',
      gate: 'deploy_locked',
      resumesAt: minutes(5).toISOString(),
      rule: expect.stringContaining(
        'DEPLOY_ENVIRONMENT_LOCKED: pipeline run run-holder holds the production environment',
      ),
    });
  });

  it('resumes once the last lock ends, where the project locks several environments', () => {
    const later = { ...otherLock(minutes(9)), environment: 'staging' };
    const d = liveOf(release({ foreignLocks: [otherLock(minutes(5)), later] }), ctx);
    expect(d.waitingOn).toMatchObject({
      gate: 'deploy_locked',
      resumesAt: minutes(9).toISOString(),
    });
  });

  it('is no gate for the release that holds a lock of its own', () => {
    const own = { ...otherLock(minutes(5)), held: true, reclaimedFromRunId: null };
    const d = liveOf(release({ deployLocks: [own] }), ctx);
    expect(d.state).not.toBe('waiting_gate');
  });

  it('is no gate for a release past its deploy, at its verify stage', () => {
    const d = liveOf(
      release({ releaseAttempt: { stage: 'verify', verdict: null, startedAt: minutes(-1) } }),
      ctx,
    );
    expect(d.state).not.toBe('waiting_gate');
  });

  it('is no gate for a run that is not a release: only the release path takes the lock', () => {
    const f = release();
    const d = liveOf({ ...f, run: { ...f.run, releaseVersion: null } } as RunFacts, ctx);
    expect(d.state).not.toBe('waiting_gate');
  });

  it('reads stuck overdue once the lock expired and nobody reclaimed it past the threshold', () => {
    const f = release({ foreignLocks: [otherLock(minutes(-4))] });
    const reading = stuckOf(f, ctx, liveOf(f, ctx));
    expect(reading?.rule).toBe('overdue');
    expect(reading?.evidence).toMatchObject({
      table: 'deploy_locks',
      id: 'production',
      column: 'expires_at',
    });
  });

  it('is not overdue while inside the threshold after expiry', () => {
    const f = release({ foreignLocks: [otherLock(minutes(-2))] });
    expect(stuckOf(f, ctx, liveOf(f, ctx))).toBeNull();
  });
});

describe('agent-run-standing waiting_gate: the wait shape {kind, gate, resumesAt, rule}', () => {
  it('serves a retry cooldown with its deadline and nothing of the person wait shape', () => {
    const job = {
      id: 'j1',
      type: 'issue',
      status: 'queued',
      heldBy: null,
      hold: null,
      retryAfterAt: minutes(2),
      queuedAt: minutes(-1),
    };
    const d = liveOf(release({ run: { ...release().run, releaseVersion: null }, job }), ctx);
    expect(Object.keys(d.waitingOn).sort()).toEqual(['gate', 'kind', 'resumesAt', 'rule']);
    expect(d.waitingOn).toMatchObject({
      gate: 'retry_cooldown',
      resumesAt: minutes(2).toISOString(),
    });
  });

  it('serves resumesAt null for a gate with no deadline, never a guess', () => {
    const job = {
      id: 'j1',
      type: 'issue',
      status: 'queued',
      heldBy: null,
      hold: null,
      retryAfterAt: null,
      queuedAt: minutes(-1),
    };
    const queuedGates = new Map([['j1', 'runner_stale']]);
    const d = liveOf(release({ run: { ...release().run, releaseVersion: null }, job }), {
      ...ctx,
      queuedGates,
    });
    expect(d.waitingOn).toEqual({
      kind: 'gate',
      gate: 'runner_stale',
      resumesAt: null,
      rule: expect.stringContaining('runner_stale'),
    });
  });
});
