// ISS-276 / FB-87: the account printed "resets 2:30am (Asia/Ho_Chi_Minh)" (19:30Z) and answered at
// 16:42Z. A release held by a limited runner names its next try, says an answered turn clears it
// sooner, and names a printed reset only where the account printed one, as its claim.

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
    expect(clause).toContain('is held until its next try at 2026-10-06T16:23:00.000Z.');
    expect(clause).toContain('A turn the account answers clears it sooner.');
  });

  it('names the printed reset as the account claim, never as when work resumes', () => {
    const clause = runnerHoldClause({ ...limited, printedReset: '2026-10-06T19:30Z' });
    expect(clause).toContain(
      'The account printed a reset at 2026-10-06T19:30Z: its claim, not when work resumes.',
    );
    expect(clause).not.toMatch(/until 2026-10-06T19:30/);
  });

  it('speaks of no printed reset where the account printed none', () => {
    const clause = runnerHoldClause(limited);
    expect(clause).not.toMatch(/printed/);
    expect(clause).toBe(
      '`sid-xeon-1-dev` was refused by its account and is held until its next try at ' +
        '2026-10-06T16:23:00.000Z. A turn the account answers clears it sooner. Wait for the next ' +
        'try, or bring another box up. It is up and reporting, last seen 4s ago.',
    );
  });
});
