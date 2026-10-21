// The steward's cost guard (REQ-48): a run is priced a gateway turn per gateway act and one runner
// job for all its runner acts, against the UTC day's budget, and a run that does not fit is refused
// whole rather than run in part.

import { STEWARD_DAILY_BUDGET } from '@forge/contracts/steward';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../project-config/index.js', () => ({ readProjectDocument: async () => null }));
vi.mock('./runs-store.js', () => ({
  spentSince: async () => ({ gatewayTurns: 0, runnerJobs: 0 }),
  markStarted: async () => undefined,
}));

const { costOf, fits, slotsFor, utcDayStart } = await import('./policy.js');

describe('the steward cost guard', () => {
  it('prices a gateway turn per gateway act and one job for all runner acts', () => {
    expect(costOf(['intake_check', 'breakdown_check'])).toEqual({ gatewayTurns: 2, runnerJobs: 0 });
    expect(costOf(['triage_draft', 'release_followthrough'])).toEqual({
      gatewayTurns: 0,
      runnerJobs: 1,
    });
    expect(costOf(['note', 'triage_draft'])).toEqual({ gatewayTurns: 1, runnerJobs: 1 });
    expect(costOf([])).toEqual({ gatewayTurns: 0, runnerJobs: 0 });
  });

  it('fits a run up to the budget exactly, and not one turn or job past it', () => {
    const budget = STEWARD_DAILY_BUDGET;
    const one = { gatewayTurns: 1, runnerJobs: 0 };
    expect(fits(budget, { gatewayTurns: 199, runnerJobs: 0 }, one)).toBe(true);
    expect(fits(budget, { gatewayTurns: 200, runnerJobs: 0 }, one)).toBe(false);
    const job = { gatewayTurns: 0, runnerJobs: 1 };
    expect(fits(budget, { gatewayTurns: 0, runnerJobs: 9 }, job)).toBe(true);
    expect(fits(budget, { gatewayTurns: 0, runnerJobs: 10 }, job)).toBe(false);
    expect(fits({ gatewayTurns: 0, runnerJobs: 0 }, { gatewayTurns: 0, runnerJobs: 0 }, one)).toBe(
      false,
    );
  });

  it('takes up runs at once by the budget: a slot per 25 daily turns, at least 1 and at most 8', () => {
    expect(slotsFor(STEWARD_DAILY_BUDGET)).toBe(8);
    expect(slotsFor({ gatewayTurns: 50, runnerJobs: 10 })).toBe(2);
    expect(slotsFor({ gatewayTurns: 24, runnerJobs: 10 })).toBe(1);
    expect(slotsFor({ gatewayTurns: 0, runnerJobs: 0 })).toBe(1);
    expect(slotsFor({ gatewayTurns: 10_000, runnerJobs: 10 })).toBe(8);
  });

  it("counts the day from UTC midnight, whatever the box's zone", () => {
    expect(utcDayStart(new Date('2026-10-21T23:59:59.999Z')).toISOString()).toBe(
      '2026-10-21T00:00:00.000Z',
    );
    expect(utcDayStart(new Date('2026-10-22T00:00:00.000Z')).toISOString()).toBe(
      '2026-10-22T00:00:00.000Z',
    );
  });
});
