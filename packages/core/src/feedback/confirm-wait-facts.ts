/**
 * What a confirm wait reads as (ISS-902), pure over the item's columns: whether a wait may be set, the
 * wait still holding, and how one ended. The writes are `confirm-wait.ts`'s.
 */

import {
  FEEDBACK_CONFIRM_WAIT_SHAPE,
  FEEDBACK_LIMITS,
  type FeedbackConfirmWaitOn,
  type FeedbackConfirmWaitView,
  type FeedbackPhase,
} from '@forge/contracts/feedback';
import type { Row } from './read.js';
import { type FeedbackRefusal, refusal } from './rules.js';

export interface ConfirmWaitRequest {
  until: Date;
  on: FeedbackConfirmWaitOn | undefined;
  reason: string | undefined;
}

type WaitFacts = Pick<
  Row,
  | 'confirmWaitUntil'
  | 'confirmWaitOn'
  | 'confirmWaitReason'
  | 'confirmWaitSetAt'
  | 'confirmWaitSetBy'
  | 'confirmWaitMetAt'
>;

const DAY_MS = 86_400_000;

/** A wait is a reason and a date to come within the limit, on an item that owes an agent's confirm. */
export function confirmWaitRefusal(
  item: { key: string; phase: FeedbackPhase; agentReported: boolean },
  wait: ConfirmWaitRequest,
  now: Date,
  maxDays: number = FEEDBACK_LIMITS.confirmWaitDays,
): FeedbackRefusal | null {
  if (!wait.reason?.trim()) {
    return refusal(
      'FEEDBACK_CONFIRM_WAIT_REASON_REQUIRED',
      '/reason',
      `a confirm wait says why ${item.key} waits, which whoever reads the item is shown; send ${FEEDBACK_CONFIRM_WAIT_SHAPE}.`,
    );
  }
  if (!item.agentReported || item.phase !== 'resolved') {
    return refusal(
      'FEEDBACK_CONFIRM_WAIT_NOT_OWED',
      '/feedback',
      `${item.key} reads ${item.phase}${item.agentReported ? '' : ' and a person reported it'}; only a shipped item an agent reported owes a confirm, so only one may wait on it.`,
    );
  }
  if (Number.isNaN(wait.until.getTime()) || wait.until.getTime() <= now.getTime()) {
    return refusal(
      'FEEDBACK_CONFIRM_WAIT_PAST',
      '/until',
      `${Number.isNaN(wait.until.getTime()) ? 'that' : wait.until.toISOString()} is not a date after now (${now.toISOString()}); a wait ends on a date still to come.`,
    );
  }
  if (wait.until.getTime() > now.getTime() + maxDays * DAY_MS) {
    return refusal(
      'FEEDBACK_CONFIRM_WAIT_TOO_FAR',
      '/until',
      `${wait.until.toISOString()} is more than ${maxDays} days away; a confirm waiting that long is forgotten, so name a nearer date and set the wait again then.`,
    );
  }
  return null;
}

/** How a wait ended: its event happened, the fix it stood on was reopened, or its date passed. */
export type ConfirmWaitEnd = 'met' | 'withdrawn' | 'lapsed';

/**
 * The wait still holding: set, its date not passed, its event not happened, and the fix it stands on
 * not reopened since it was set (`withdrawn`, `confirm-wait-read.ts:withdrawnSql`); null otherwise.
 */
export function confirmWaitOf(
  r: WaitFacts,
  now: Date,
  withhold: boolean,
  withdrawn: boolean,
): FeedbackConfirmWaitView | null {
  if (!r.confirmWaitUntil || !r.confirmWaitSetAt || r.confirmWaitMetAt || withdrawn) return null;
  if (r.confirmWaitUntil.getTime() <= now.getTime()) return null;
  return {
    until: r.confirmWaitUntil.toISOString(),
    on: r.confirmWaitOn,
    reason: withhold ? null : r.confirmWaitReason,
    setAt: r.confirmWaitSetAt.toISOString(),
    setBy: r.confirmWaitSetBy,
  };
}

/** How a wait set on the item ended, which the owed line names it again with; null while it holds or none was set. */
export function confirmWaitEnded(
  r: WaitFacts,
  now: Date,
  withdrawn: boolean,
): ConfirmWaitEnd | null {
  if (!r.confirmWaitUntil) return null;
  if (r.confirmWaitMetAt) return 'met';
  if (withdrawn) return 'withdrawn';
  return r.confirmWaitUntil.getTime() <= now.getTime() ? 'lapsed' : null;
}
