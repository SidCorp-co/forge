// ISS-1415: a job whose box reported that its pane ended without an outcome, or that it lost the
// pane, failed for the box, never for its work. Core placed the same work again at once, so while a
// runner misread live panes as gone (forge-runner 0.18.0, before ISS-1351) one item went out every
// 1 to 3 minutes: gwork's ISS-109 steward work about 31 times in 95 minutes, forge's release attempts
// 7 times in 12. Each automatic re-placement of one item now waits a growing interval after such a
// failure, and after `PANE_LOSS_CAP` in a row core places it no more until a job for it succeeds or a
// person asks for it again. The pool's retries (`retry.ts`) and the steward's runner acts
// (`steward/pane-loss.ts`) both read these rules, so the bound is one rule for every kind.

/** What a box says when it ends a job for its pane (runner `pool_jobs/mod.rs:supervise`, `panes.rs:adopt`). */
const PANE_LOSS_PATTERNS: readonly RegExp[] = [
  /pane\b.{0,120}\bended without reporting an outcome/i,
  /pane\b.{0,120}\bdid not survive a restart of the runner daemon/i,
  /\blost its pane\b/i,
];

/** Whether a job's failure text is its box reporting its pane ended without an outcome, or lost. */
export function endedOnPaneLoss(text: string | null | undefined): boolean {
  if (!text) return false;
  return PANE_LOSS_PATTERNS.some((p) => p.test(text));
}

/** How many such failures in a row one item takes before core stops placing it on its own. */
export const PANE_LOSS_CAP = 4;

/** The wait after the first such failure; each one after doubles it (2, 4, 8 minutes). */
const FIRST_WAIT_MS = 2 * 60_000;

/** The reason a chain stops for, and the hold a job waits in for a person's ask. */
export const PANE_LOST_REPEATEDLY = 'pane_lost_repeatedly';

/** The wait before the next placement after `losses` such failures in a row. */
export function paneLossWaitMs(losses: number): number {
  return losses <= 0 ? 0 : FIRST_WAIT_MS * 2 ** (losses - 1);
}

export type PaneLossPlacement =
  | { kind: 'place' }
  | { kind: 'wait'; losses: number; at: Date }
  | { kind: 'stop'; losses: number };

/**
 * Whether one item's next job may be placed now: at once where its last job did not end on a pane
 * loss, after the growing wait where it did, and never past the cap.
 */
export function paneLossPlacement(
  losses: number,
  lastLossAt: Date | null,
  now: Date,
): PaneLossPlacement {
  if (losses <= 0) return { kind: 'place' };
  if (losses >= PANE_LOSS_CAP) return { kind: 'stop', losses };
  const at = new Date((lastLossAt ?? now).getTime() + paneLossWaitMs(losses));
  return at.getTime() > now.getTime() ? { kind: 'wait', losses, at } : { kind: 'place' };
}

/** One ended job of an item, newest first, as the streak reads it. */
export interface ItemJobEnd {
  status: string;
  error: string | null;
  endedAt: Date | null;
  /** The job was held and a person resumed it: their ask, so no loss before it is counted. */
  askedByPerson: boolean;
}

export interface PaneLossStreak {
  /** Consecutive jobs of the item that ended on a pane loss, newest first. */
  losses: number;
  /** When the newest of them ended, and what its box said. */
  lastAt: Date | null;
  lastFailure: string | null;
}

/**
 * The item's run of pane losses: its newest ended jobs that failed so, up to the first that ended
 * any other way (a success, another failure, a cancel). A job a person resumed from its hold counts
 * and ends the run, since that resume was their ask for it again.
 */
export function paneLossStreak(ends: readonly ItemJobEnd[]): PaneLossStreak {
  let losses = 0;
  let lastAt: Date | null = null;
  let lastFailure: string | null = null;
  for (const end of ends) {
    if (end.status !== 'failed' || !endedOnPaneLoss(end.error)) break;
    if (losses === 0) {
      lastAt = end.endedAt;
      lastFailure = end.error;
    }
    losses += 1;
    if (end.askedByPerson) break;
  }
  return { losses, lastAt, lastFailure };
}

/** The record's sentence for an item core stopped placing: the item, the failure and the count. */
export function paneLossStopSentence(args: {
  what: string;
  item: string;
  losses: number;
  failure: string | null;
}): string {
  const last = args.failure ? ` (the last: ${args.failure})` : '';
  return (
    `${args.what} on ${args.item} ended on its box losing the job's pane ${args.losses} times in a row${last}; ` +
    'Forge places it no more until a job for it succeeds or a person asks for it again'
  );
}
