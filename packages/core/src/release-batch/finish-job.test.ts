import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { FINISH_UNTAKEN_MS, owedWakeUp, readFinishRecord, isInFlight } = await import(
  './finish-job.js'
);

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function record(over: Record<string, unknown> = {}) {
  return {
    requestId: 'r-1',
    state: 'accepted',
    commit: null,
    requestedBy: { type: 'user', id: 'u-1' },
    acceptedAt: iso(-1_000),
    updatedAt: iso(-1_000),
    version: 1,
    owner: null,
    leaseUntil: null,
    workerStarts: 0,
    closed: null,
    failed: null,
    refusal: null,
    finishedAt: null,
    ...over,
  };
}

describe('readFinishRecord', () => {
  it('reads nothing off a run that never took a finish', () => {
    expect(readFinishRecord({ source: 'release-batch' })).toBeNull();
    expect(readFinishRecord(null)).toBeNull();
  });

  it('reads a record whole, refusal included', () => {
    const refusal = {
      code: 'RELEASE_NOT_VERIFIED',
      reason: 'the live build is unchanged',
      live: 'abc1234',
    };
    expect(readFinishRecord({ finish: record({ state: 'failed', refusal }) })).toMatchObject({
      requestId: 'r-1',
      state: 'failed',
      refusal,
    });
  });

  it('refuses to guess a state it does not know into one it does', () => {
    expect(readFinishRecord({ finish: record({ state: 'done' }) })).toBeNull();
    expect(readFinishRecord({ finish: record({ version: '1' }) })).toBeNull();
    expect(readFinishRecord({ finish: record({ requestedBy: { type: 'user' } }) })).toBeNull();
  });
});

describe('isInFlight', () => {
  it('holds for the three working states and no other', () => {
    for (const state of ['accepted', 'verifying', 'closing']) {
      expect(isInFlight(readFinishRecord({ finish: record({ state }) }))).toBe(true);
    }
    for (const state of ['finished', 'failed']) {
      expect(isInFlight(readFinishRecord({ finish: record({ state }) }))).toBe(false);
    }
    expect(isInFlight(null)).toBe(false);
  });
});

describe('owedWakeUp — which attempts the sweep wakes', () => {
  const read = (over: Record<string, unknown>) => {
    const r = readFinishRecord({ finish: record(over) });
    if (!r) throw new Error('fixture did not parse');
    return r;
  };

  it('leaves an attempt alone while its owner keeps the lease', () => {
    const live = read({ state: 'verifying', owner: 'w-1', leaseUntil: iso(30_000) });
    expect(owedWakeUp(live, 'running', NOW)).toBe(false);
  });

  it('wakes an attempt whose owner stopped renewing', () => {
    const dead = read({ state: 'closing', owner: 'w-1', leaseUntil: iso(-1) });
    expect(owedWakeUp(dead, 'running', NOW)).toBe(true);
  });

  it('wakes an accepted attempt nobody took, only once it has waited past the untaken bound', () => {
    expect(owedWakeUp(read({ updatedAt: iso(-FINISH_UNTAKEN_MS + 1_000) }), 'running', NOW)).toBe(
      false,
    );
    expect(owedWakeUp(read({ updatedAt: iso(-FINISH_UNTAKEN_MS - 1) }), 'running', NOW)).toBe(true);
  });

  it('wakes a finished attempt whose run is still open, and no finished one whose run closed', () => {
    const finished = read({ state: 'finished', closed: ['i-1'], failed: [] });
    expect(owedWakeUp(finished, 'running', NOW)).toBe(true);
    expect(owedWakeUp(finished, 'completed', NOW)).toBe(false);
  });

  it('never wakes a failed attempt: a new finish is the caller’s to ask for', () => {
    expect(owedWakeUp(read({ state: 'failed' }), 'running', NOW)).toBe(false);
  });
});
