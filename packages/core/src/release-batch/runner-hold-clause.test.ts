// ISS-276 / FB-87: the account printed "resets 2:30am (Asia/Ho_Chi_Minh)" (19:30Z) and answered at
// 16:42Z. A release held by a limited runner names its next try, says an answered turn clears it
// sooner, and names a printed reset only where the account printed one, as its claim. Each time reads
// as the sentence around it does (ISS-279, from ISS-276's second judge), never as a raw ISO stamp.

import { describe, expect, it } from 'vitest';
import type { RunnerHold } from '../runners/index.js';
import { runnerHoldClause } from './blocker-sentences.js';

const limited: RunnerHold = {
  deviceName: 'sid-xeon-1-dev',
  reason: 'rate-limited',
  detail: '2026-10-06T16:23:00.000Z',
  lastSeenSeconds: 4,
  reporting: true,
};

describe('the release blocker for a limited runner', () => {
  it('names the next try and says a turn the account answers clears it sooner', () => {
    const clause = runnerHoldClause(limited);
    expect(clause).toContain('is held until its next try at 16:23 UTC on 2026-10-06.');
    expect(clause).toContain('A turn the account answers clears it sooner.');
  });

  it('names the printed reset as the account claim, never as when work resumes', () => {
    const clause = runnerHoldClause({ ...limited, printedReset: '2026-10-06T19:30Z' });
    expect(clause).toContain(
      'The account printed a reset at 19:30 UTC on 2026-10-06: its claim, not when work resumes.',
    );
    expect(clause).not.toMatch(/until 19:30/);
  });

  it('speaks of no printed reset where the account printed none', () => {
    const clause = runnerHoldClause(limited);
    expect(clause).not.toMatch(/printed/);
    expect(clause).toBe(
      '`sid-xeon-1-dev` was refused by its account and is held until its next try at ' +
        '16:23 UTC on 2026-10-06. A turn the account answers clears it sooner. Wait for the next ' +
        'try, or bring another box up. It is up and reporting, last seen 4s ago.',
    );
  });
});

describe('a time in a runner hold', () => {
  it('reads as an hour and a day, never as a raw ISO stamp, on every hold that names one', () => {
    const quarantined = runnerHoldClause({
      ...limited,
      reason: 'quarantined',
      detail: '2026-10-06T08:05:59.000Z',
    });
    expect(quarantined).toContain(
      'is quarantined until 08:06 UTC on 2026-10-06 after repeated failures.',
    );
    for (const clause of [
      runnerHoldClause({ ...limited, printedReset: '2026-10-06T19:30Z' }),
      quarantined,
    ]) {
      expect(clause).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d/);
    }
  });

  // ISS-279's judge, fixed in ISS-278: cut to the minute, a next try at 16:23:59 read "16:23" and the
  // hold outlasted the time it showed; rounded up, the shown time is never before the hold ends
  it('rounds a time up to the minute, so the hold never outlasts the time it shows', () => {
    const at = (detail: string) => runnerHoldClause({ ...limited, detail });
    expect(at('2026-10-06T16:23:59.000Z')).toContain('next try at 16:24 UTC on 2026-10-06.');
    expect(at('2026-10-06T16:23:00.001Z')).toContain('next try at 16:24 UTC on 2026-10-06.');
    expect(at('2026-10-06T16:23:00.000Z')).toContain('next try at 16:23 UTC on 2026-10-06.');
    expect(at('2026-10-06T23:59:30.000Z')).toContain('next try at 00:00 UTC on 2026-10-07.');
  });

  it('keeps a reading it cannot parse as it was written, rather than inventing a time', () => {
    expect(runnerHoldClause({ ...limited, detail: 'soon' })).toContain('next try at soon.');
  });
});
