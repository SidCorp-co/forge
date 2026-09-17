// Where a bounded, notify-only sweep resumes.
//
// ISS-1021 — three passes here bound their candidate sets but write NOTHING on the rows they
// surface: `stranded-issues.ts`'s two detectors emit a notification, and `inv7-alarms.ts`'s
// `alarmAgedHolds` emits a wedge. A surfaced row is exactly as eligible on the next tick as it was
// on this one, so a plain `ORDER BY ... LIMIT n` is not a deferral — it is a permanent blind spot:
// the same first page is read every minute for as long as the condition lasts, and row n+1 is
// never surfaced at all. That is strictly worse than the unbounded scan it replaces, which at
// least reached everything.
//
// So the bound comes in two halves, and neither works alone: a `LIMIT` for the size of one tick's
// work, and this cursor for fairness across ticks. Each pass resumes after the last key it read
// and wraps back to the start when a page comes up short, so every candidate is reached within
// ceil(total / limit) passes and a row already surfaced is revisited once the rest has been.
//
// The three reapers in `jobs/loop-monitor.ts` deliberately do NOT use this. Each writes its row
// terminal, so its candidate set really does shrink and oldest-first plus a bound drains it — a
// cursor there would skip past rows that a failed reap left behind.

// cm:guard the position is per-process and deliberately NOT persisted. It is a traversal offset,
// not kernel state: losing it on a restart restarts the traversal at the oldest candidate, which
// is the same place a cold process starts anyway and costs at most one repeated page. Persisting
// it would make a crashed sweep able to skip a candidate forever, which is the failure this whole
// module exists to prevent.
const positions = new Map<string, SweepPosition>();

export interface SweepPosition {
  /** The sort column rendered by the DATABASE as text, never a JS `Date`. */
  ts: string;
  id: string;
}

/**
 * Where `cursorKey` should resume, or `null` to start from the oldest candidate.
 *
 * `cursorKey` names the pass AND its scope, because the same detector is also called for one
 * project from a route: a shared position would let a scoped call drag the sweep's own traversal
 * forward past rows it never looked at.
 */
export function sweepPosition(cursorKey: string): SweepPosition | null {
  return positions.get(cursorKey) ?? null;
}

/**
 * Record where this pass stopped.
 *
 * A FULL page parks the cursor on its last row, so the next pass takes the page after it. A short
 * page means the traversal reached the end, so the cursor is cleared and the next pass wraps to
 * the oldest candidate — which is what makes an already-surfaced row get revisited rather than
 * left behind a cursor that never moves again.
 */
export function advanceSweep(cursorKey: string, last: SweepPosition | null, filled: boolean): void {
  if (filled && last) positions.set(cursorKey, last);
  else positions.delete(cursorKey);
}

/** Test helper — a cursor surviving between cases makes one case's page another's starting point. */
export function resetSweepCursorsForTest(): void {
  positions.clear();
}
