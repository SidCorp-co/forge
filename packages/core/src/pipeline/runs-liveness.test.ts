import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { readingOf } = await import('./runs-liveness.js');

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
});
