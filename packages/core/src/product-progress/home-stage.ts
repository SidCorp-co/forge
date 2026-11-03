// How far an item the person gave has got, as the home's Moving section and its search say it
// (ISS-919): read from the carrier issue's status and the run on it now, never from a date; and when
// it last moved, which ranks Moving and folds what nothing moved for a week under Idle.

import type { FeedbackSummary } from '@forge/contracts/feedback';
import { HOME_IDLE_DAYS, type HomeMovingItem, type HomeStage } from '@forge/contracts/owner-home';
import type { ProductProgress } from '@forge/contracts/product-progress';

/** An issue's stage, or null where it is over (closed or dropped) and so not moving. */
export function issueStage(
  status: string,
  running: boolean,
  claimedByRelease: boolean,
): HomeStage | null {
  switch (status) {
    case 'closed':
    case 'dropped':
      return null;
    case 'in_progress':
      return 'building';
    case 'awaiting_release':
      return claimedByRelease ? 'releasing' : 'landed';
    default:
      return running ? 'building' : 'planned';
  }
}

/** How a feedback item ended where it is no longer moving; null while it is. */
export function feedbackEnded(
  s: Pick<FeedbackSummary, 'phase' | 'route'>,
  progress: Pick<ProductProgress, 'work'>,
): 'declined' | 'answered' | 'shipped' | null {
  if (s.phase === 'declined') return 'declined';
  if (s.route?.route === 'answer') return 'answered';
  if (s.phase === 'resolved' || s.phase === 'verified') return 'shipped';
  const w = progress.work;
  if (w && w.total > 0 && w.shipped === w.total) return 'shipped';
  return null;
}

/** A moving feedback item's stage, from its work's progress and the runs on it now. */
export function feedbackStage(
  s: Pick<FeedbackSummary, 'phase'>,
  progress: Pick<ProductProgress, 'work' | 'running' | 'runs'>,
): HomeStage {
  const w = progress.work;
  if (!w || w.total === 0) return s.phase === 'new' || s.phase === 'reopened' ? 'new' : 'planned';
  if (w.toDo > 0) return progress.running || progress.runs.length > 0 ? 'building' : 'planned';
  return 'landed';
}

const DAY_MS = 86_400_000;

/** The latest of the instants an item's reads served for its last movement. */
export function lastMoveOf(...at: readonly (string | null | undefined)[]): string {
  const known = at.filter((a): a is string => typeof a === 'string' && a !== '');
  if (known.length === 0) throw new Error('home: an item reached Moving with no instant it moved');
  return known.reduce((latest, a) => (Date.parse(a) > Date.parse(latest) ? a : latest));
}

/** Nothing has moved it for more than `HOME_IDLE_DAYS`, and no run works on it now. */
export function isIdle(lastMovedAt: string, running: boolean, now: Date): boolean {
  return !running && now.getTime() - Date.parse(lastMovedAt) > HOME_IDLE_DAYS * DAY_MS;
}

/** Moving's order: what moves first, the idle last; newest move first inside each. */
export const byLastMove = (
  one: Pick<HomeMovingItem, 'idle' | 'lastMovedAt'>,
  other: Pick<HomeMovingItem, 'idle' | 'lastMovedAt'>,
) =>
  Number(one.idle) - Number(other.idle) ||
  Date.parse(other.lastMovedAt) - Date.parse(one.lastMovedAt);
