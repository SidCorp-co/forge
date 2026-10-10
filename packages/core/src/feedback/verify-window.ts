import { FEEDBACK_VERIFY_WINDOW, type FeedbackPhase } from '@forge/contracts/feedback';
import { readProjectDocument } from '../project-config/index.js';
import type { Row } from './read.js';

const DAY_MS = 86_400_000;

/** The moment Forge verifies an item first read resolved at `seenAt`, for a window of `days`. */
export const autoVerifyAt = (seenAt: Date, days: number) =>
  new Date(seenAt.getTime() + days * DAY_MS);

/** Why the record could not verify an item past its window, as the sweep wrote it in this resolved spell; else null. */
export function verifyHeldOf(r: Row, phase: FeedbackPhase): { at: Date; why: string } | null {
  if (phase !== 'resolved' || !r.resolvedSeenAt || !r.verifyHeldAt || r.verifyHeldWhy === null)
    return null;
  if (r.verifyHeldAt.getTime() < r.resolvedSeenAt.getTime()) return null;
  return { at: r.verifyHeldAt, why: r.verifyHeldWhy };
}

/**
 * When the record is read to verify an item that reads resolved and has been dated by a sweep; null
 * where it names no violated criterion, since no record can then say the problem is gone
 * (`loop-close.ts:goneByRecord`), and null once a sweep found the record could not.
 */
export function autoVerifyOf(r: Row, phase: FeedbackPhase, windowDays: number): Date | null {
  if (phase !== 'resolved' || !r.resolvedSeenAt || !r.violatedCriterionId) return null;
  if (verifyHeldOf(r, phase)) return null;
  return autoVerifyAt(r.resolvedSeenAt, windowDays);
}

/** The project's verify window in days: its `feedback.verifyWindowDays`, else the default. */
export async function verifyWindowDays(projectId: string): Promise<number> {
  const held = await readProjectDocument(projectId);
  return held?.document.feedback?.verifyWindowDays ?? FEEDBACK_VERIFY_WINDOW.defaultDays;
}
