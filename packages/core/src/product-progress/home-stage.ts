// How far an item the person gave has got, as the home's Moving section and its search say it
// (ISS-919): read from the carrier issue's status and the run on it now, never from a date.

import type { FeedbackSummary } from '@forge/contracts/feedback';
import type { HomeStage } from '@forge/contracts/owner-home';
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
