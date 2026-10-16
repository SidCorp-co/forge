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

export function sweepWindow(cursorKey: string, freshUntil: string): SweepWindow {
  const open = positions.get(cursorKey);
  if (open) return { after: open.after, until: open.until };
  return { after: null, until: freshUntil };
}

export function advanceSweep(
  cursorKey: string,
  window: SweepWindow,
  last: SweepPosition | null,
  filled: boolean,
): void {
  if (filled && last) positions.set(cursorKey, { after: last, until: window.until });
  else positions.delete(cursorKey);
}

const arrivals = new Map<string, SweepPosition>();

/** Before every row: a mark at a time resumes with the rows due at it, which a read at that time
 *  could not take — a row is due only once its grace lies strictly behind `now`. */
const FIRST_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Where a read in arrival order resumes: past the last row it read, or, with no mark or one ahead of
 * `now` (a clock that moved back), `since` — what came before that is the traversals' to reach.
 */
export function arrivalMark(key: string, now: Date, since: Date): SweepPosition {
  const mark = arrivals.get(key);
  if (mark && Date.parse(mark.ts) <= now.getTime()) return mark;
  return { ts: since.toISOString(), id: FIRST_ID };
}

/** A full read stops at its last row; a short one has read everything that arrived before `now`. */
export function advanceArrivals(
  key: string,
  now: Date,
  last: SweepPosition | null,
  filled: boolean,
): void {
  arrivals.set(key, filled && last ? last : { ts: now.toISOString(), id: FIRST_ID });
}

/** Test helper — a cursor surviving between cases makes one case's page another's starting point. */
export function resetSweepCursorsForTest(): void {
  positions.clear();
  arrivals.clear();
}
