import { describe, expect, it } from 'vitest';
import { jobStatuses } from '../db/schema.js';
import {
  LIVE_JOB_STATUSES,
  OCCUPYING_JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  UNHELD_LIVE_JOB_STATUSES,
} from './status-sets.js';

/**
 * ISS-998 held "a status added to `jobStatuses` must be classified" with a
 * `Record<JobStatus, boolean>` in `pipeline/runs-rollup.ts`, which ISS-1106
 * removed as a second answer to "a job is live". It is held here instead.
 */
describe('the job status answers against the vocabulary they are drawn from', () => {
  it('puts every job status on exactly one side of "is this job over"', () => {
    expect([...LIVE_JOB_STATUSES, ...TERMINAL_JOB_STATUSES].sort()).toEqual(
      [...jobStatuses].sort(),
    );
    expect(LIVE_JOB_STATUSES.filter((s) => TERMINAL_JOB_STATUSES.includes(s))).toEqual([]);
  });

  it('holds the unheld-live answer to exactly the live statuses that are not parked', () => {
    expect([...UNHELD_LIVE_JOB_STATUSES]).toEqual(LIVE_JOB_STATUSES.filter((s) => s !== 'held'));
  });

  it('holds the occupying answer inside the unheld-live one', () => {
    expect(OCCUPYING_JOB_STATUSES.every((s) => UNHELD_LIVE_JOB_STATUSES.includes(s))).toBe(true);
  });

  it('keeps `held` live and out of the count of work a runner is moving', () => {
    expect(LIVE_JOB_STATUSES).toContain('held');
    expect(UNHELD_LIVE_JOB_STATUSES).not.toContain('held');
  });
});
