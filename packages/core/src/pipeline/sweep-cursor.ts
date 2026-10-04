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
interface SweepWindow {
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
