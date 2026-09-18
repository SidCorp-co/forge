// How much of a job-axis hop's candidate set one tick takes, and how a full page is reported.
//
// ISS-1021 — extracted from `loop-monitor.ts` rather than added to it: that file was already at
// its size budget, and the bound plus the line that reports it are one idea with three callers.

import { logger } from '../logger.js';

/**
 * How many candidates one job-axis hop takes per tick, matching the run axis's own 200.
 *
 * All three hops read their whole candidate set, so a backlog after an outage made one tick's work
 * scale with the outage rather than with the loop. A plain oldest-first bound is the right shape
 * HERE and would be a blind spot in the notify-only passes (`pipeline/sweep-cursor.ts` says why):
 * every row a reaper takes is either written terminal or moved through the kill gate, and the gate
 * resolves at `killGraceMs()`, so a candidate leaves the set within a bounded time whatever it is.
 * Nothing is skipped — an unread candidate is read on a later tick, and at 200 a tick against a
 * 60-second loop drains 12,000 rows an hour.
 *
 * It is the REAPER's bound and `reapResultMisses` passes it alone: `resultMissCandidateQuery`
 * keeps its unbounded shape because `jobs/stale-detector.ts` reads that export to say the loop did
 * not act on a row it should have, and bounding the alarm to the same page would hide exactly the
 * backlog it exists to name. An EXPLAIN test reading the export would also measure a plan the
 * reaper no longer runs, if the two ever diverged silently.
 */
export const JOB_AXIS_SCAN_LIMIT = 200;

// cm:guard report the truncation on the CANDIDATES read, not on `reaped` — a page full of rows the
// kill gate is still holding reaps nothing and is exactly the backlog worth naming, so keying this
// on the terminal writes would go quiet in the case it exists for.
/** Report a filled page, then hand the hop's result straight back to its caller. */
export function reportHopPage<T>(hop: string, examined: number, result: T): T {
  if (examined >= JOB_AXIS_SCAN_LIMIT) {
    logger.warn(
      { hop, limit: JOB_AXIS_SCAN_LIMIT, examined },
      'loop-monitor: hop filled its candidate page — the rest is read on the next tick',
    );
  }
  return result;
}
