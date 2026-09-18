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

// Wrapping when a page comes up short is enough only while the candidate set is not growing. If
// new rows keep arriving AHEAD of the cursor faster than a page drains them, every page is full,
// the traversal never reaches an end, and a row behind the cursor is never surfaced again — the
// same blind spot, one level up. A fixed ceiling on the number of pages is NOT the answer either:
// it wraps a stable 2,001-row set at row 2,000 and row 2,001 is never surfaced at all, which is
// the original defect with a different boundary.
//
// So a traversal freezes its far edge instead. Each of these passes already has an upper bound —
// `updated_at` older than the strand cutoff, `heldAt` older than the hold cutoff — and that bound
// is what moves forward with the clock and lets new candidates in. Captured once when a traversal
// begins and held for its whole length, it makes the traversal's candidate set FINITE: rows can
// leave it, nothing can join it, so a short page arrives within ceil(size / limit) passes and the
// wrap happens. Rows that became eligible meanwhile are the next traversal's, not this one's.

// cm:guard the position is per-process and deliberately NOT persisted. It is a traversal offset,
// not kernel state: losing it on a restart restarts the traversal at the oldest candidate, which
// is the same place a cold process starts anyway and costs at most one repeated page. Persisting
// it would make a crashed sweep able to skip a candidate forever, which is the failure this whole
// module exists to prevent.
const positions = new Map<string, Traversal>();

export interface SweepPosition {
  /** The sort column rendered by the DATABASE as text, never a JS `Date`. */
  ts: string;
  id: string;
}

/** One traversal in progress: where it resumes, and the far edge it froze when it began. */
interface Traversal {
  after: SweepPosition | null;
  until: string;
}

/** One traversal's two bounds: where to resume, and the far edge not to read past. */
export interface SweepWindow {
  after: SweepPosition | null;
  until: string;
}

/**
 * The window `cursorKey` should read next.
 *
 * A traversal already under way keeps the far edge it started with, whatever `freshUntil` says
 * now — that is the whole point, and passing the live cutoff every tick is what makes it work.
 * A traversal that has just wrapped (or has never run) takes `freshUntil` as its new edge and
 * resumes from the oldest candidate.
 *
 * `cursorKey` names the pass AND its scope, because the same detector is also called for one
 * project from a route: a shared position would let a scoped call drag the sweep's own traversal
 * forward past rows it never looked at.
 */
export function sweepWindow(cursorKey: string, freshUntil: string): SweepWindow {
  const open = positions.get(cursorKey);
  if (open) return { after: open.after, until: open.until };
  return { after: null, until: freshUntil };
}

/**
 * Record where this pass stopped, inside the window it was given.
 *
 * A FULL page parks the cursor on its last row AND keeps the window's far edge, so the next pass
 * takes the page after it out of the same frozen set. A short page means this traversal reached
 * its edge, so the whole traversal is cleared and the next pass starts a new one at the oldest
 * candidate — which is what makes an already-surfaced row get revisited rather than left behind a
 * cursor that never moves again.
 */
export function advanceSweep(
  cursorKey: string,
  window: SweepWindow,
  last: SweepPosition | null,
  filled: boolean,
): void {
  if (filled && last) positions.set(cursorKey, { after: last, until: window.until });
  else positions.delete(cursorKey);
}

/** Test helper — a cursor surviving between cases makes one case's page another's starting point. */
export function resetSweepCursorsForTest(): void {
  positions.clear();
}
