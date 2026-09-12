import { describe, expect, it } from 'vitest';
import { fillHeartbeat } from './pulse-folds.js';
import { PULSE_HEARTBEAT_DAYS, PULSE_LIVE_JOB_STATUSES } from './pulse-types.js';

const now = new Date('2026-09-12T06:00:00.000Z');

describe('the live-job set', () => {
  it('holds every status that occupies a runner slot, `held` included', () => {
    expect([...PULSE_LIVE_JOB_STATUSES]).toEqual(['queued', 'dispatched', 'running', 'held']);
  });

  it('holds no terminal status, or a finished job would keep its run alive', () => {
    for (const terminal of ['done', 'failed', 'cancelled']) {
      expect(PULSE_LIVE_JOB_STATUSES).not.toContain(terminal);
    }
  });
});

describe('fillHeartbeat', () => {
  it('returns one entry per day of the window, newest last', () => {
    const out = fillHeartbeat(new Map(), now);
    expect(out).toHaveLength(PULSE_HEARTBEAT_DAYS);
    expect(out.at(-1)?.date).toBe('2026-09-12');
    expect(out[0]?.date).toBe('2026-08-14');
  });

  it('renders a day nothing ran as zero rather than omitting it', () => {
    const out = fillHeartbeat(new Map([['2026-09-12', 4]]), now, 3);
    expect(out).toEqual([
      { date: '2026-09-10', issueRuns: 0 },
      { date: '2026-09-11', issueRuns: 0 },
      { date: '2026-09-12', issueRuns: 4 },
    ]);
  });

  it('gives a wholly silent window a flat zero series rather than an empty one', () => {
    const out = fillHeartbeat(new Map(), now, 5);
    expect(out).toHaveLength(5);
    expect(out.every((d) => d.issueRuns === 0)).toBe(true);
  });
});
