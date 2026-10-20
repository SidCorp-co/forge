import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { holdOf, readingOf } = await import('./runs-liveness.js');

const none = {
  running: 0,
  starting: 0,
  queued: 0,
  runningSessions: 0,
  startingSessions: 0,
  waitingChats: 0,
};

describe("a run's one reading (ISS-1228)", () => {
  it.each([
    [{ running: 1 }, 'running'],
    [{ runningSessions: 1 }, 'running'],
    [{ starting: 1 }, 'starting'],
    [{ startingSessions: 1 }, 'starting'],
    [{ waitingChats: 1 }, 'waiting'],
    [{ queued: 1 }, 'queued'],
    [{}, null],
  ])('reads %j as %s', (counts, reading) => {
    expect(readingOf({ ...none, ...counts })).toBe(reading);
  });

  it('reads a run whose job is sent, under a queued session that beats, as starting, never running', () => {
    expect(readingOf({ ...none, starting: 1, startingSessions: 1 })).toBe('starting');
  });

  it('reads a chat waiting on its person beside nothing running as waiting, never running', () => {
    expect(readingOf({ ...none, waitingChats: 1 })).toBe('waiting');
  });

  it('reads a run as running while anything on it runs, whatever else waits', () => {
    expect(readingOf({ ...none, runningSessions: 1, waitingChats: 1, queued: 2 })).toBe('running');
  });

  it('reads a run whose only live job core holds as held, never as nothing (round 19)', () => {
    expect(readingOf({ ...none, held: 1 })).toBe('held');
  });

  it('reads anything live ahead of a hold: a queued retry beside a held job is queued', () => {
    expect(readingOf({ ...none, held: 1, queued: 1 })).toBe('queued');
  });

  it('reads a run whose job stopped on a question by that question, only with nothing live', () => {
    expect(readingOf({ ...none, question: 'asking' })).toBe('asking');
    expect(readingOf({ ...none, question: 'answered' })).toBe('answered');
    expect(readingOf({ ...none, question: 'asking', queued: 1 })).toBe('queued');
    expect(readingOf({ ...none, question: 'asking', held: 1 })).toBe('held');
  });

  it('reads a run a box reports blocked as blocked, ahead of the job it runs', () => {
    expect(readingOf({ ...none, blocked: true, running: 1, runningSessions: 1 })).toBe('blocked');
  });
});

describe('a held job, as its run reads it (ISS-1228 round 19)', () => {
  const at = '2026-10-19T22:59:31.000Z';

  it('says a capacity hold resumes itself while its lineage has its one auto-release', () => {
    const payload = { __hold: { reason: 'all_devices_exhausted', heldAt: at, autoRelease: true } };
    expect(
      holdOf({ payload, failureReason: 'all_devices_exhausted', retryAfterAt: null, since: at }),
    ).toEqual({
      reason: 'all_devices_exhausted',
      resumesItself: true,
      recheckAt: null,
      since: at,
    });
  });

  it('says a hold whose auto-release is spent does not resume itself', () => {
    const payload = { __hold: { reason: 'all_devices_exhausted', heldAt: at, autoRelease: false } };
    expect(
      holdOf({ payload, failureReason: null, retryAfterAt: null, since: at })?.resumesItself,
    ).toBe(false);
  });

  it('says a hold on a spent retry budget never resumes itself', () => {
    expect(
      holdOf({
        payload: {},
        failureReason: 'retry_rounds_exhausted',
        retryAfterAt: null,
        since: at,
      })?.resumesItself,
    ).toBe(false);
  });

  it('answers no hold where the row names no reason', () => {
    expect(
      holdOf({ payload: null, failureReason: null, retryAfterAt: null, since: at }),
    ).toBeNull();
  });
});
