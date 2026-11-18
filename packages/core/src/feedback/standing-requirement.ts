/**
 * A requirement route's phase and wait (workflow feedback-lifecycle, edge planned → resolved for a
 * requirement route, ISS-1332): the item reads resolved only once what delivers its requirement
 * shipped, its requirement standing delivered or accepted and the live issues linked to it each
 * closed and released, as an issue route's carriers are read (`standing-carrier.ts:issuePhaseOf`).
 * Accepted with an issue still unshipped, it stays planned and names the release or issues it waits
 * on. Accepted with no live issue linked, a decision waiving delivery included, nothing will ship: it
 * reads triaged, as an issue route whose carriers are all dropped does, and owes a triage again
 * (`owed-triage.ts:carrierGoneSql`), never a ship notice or 'Its fix shipped' (adminhub-api FB-78 read
 * done while REQ-25's issues sat unreleased in 0.28.0).
 */

import type { FeedbackWaitingKind } from '@forge/contracts/feedback';
import { type Said, say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import type { Owed, StandingFacts, StandingViewer } from './standing.js';
import {
  carriersPhrase,
  issuePhaseOf,
  issueWait,
  type RoutedIssueFacts,
} from './standing-carrier.js';

/** The requirement a `new_requirement` route names, as the item's phase reads it. */
export interface RoutedRequirementFacts {
  status: string;
  /** Every issue linked to it, by its own status and whether it waits for its release. */
  issues: readonly RoutedIssueFacts[];
}

/** The statuses past delivery: where shipped work resolves the item. */
const PAST_DELIVERY: ReadonlySet<string> = new Set(['delivered', 'accepted']);

/** Whether a requirement reads past delivery: the item waits on its shipping, not its agreement. */
export const isPastDelivery = (status: string | null | undefined) =>
  status != null && PAST_DELIVERY.has(status);

/**
 * The phase of a `new_requirement` route: triaged once its requirement is dropped, or stands past
 * delivery with no live issue linked to ship it; resolved once it stands past delivery and its live
 * issues are each closed and released; else planned.
 */
export function requirementPhaseOf(
  r: RoutedRequirementFacts | null,
): 'triaged' | 'planned' | 'resolved' {
  if (!r) return 'planned';
  if (r.status === 'dropped') return 'triaged';
  if (!isPastDelivery(r.status)) return 'planned';
  const live = r.issues.filter((i) => i.status !== 'dropped');
  if (live.length === 0) return 'triaged';
  return issuePhaseOf(live) === 'resolved' ? 'resolved' : 'planned';
}

/** A requirement past delivery, as its item's wait reads it (`StandingFacts.requirement`). */
export interface RequirementOwed {
  /** Its key, `REQ-25`. */
  key: string;
  status: string;
  /** It was accepted by a decision that waived what its acceptance checklist asks. */
  byDecision: boolean;
  /** The keys of its live issues not yet closed and released, oldest first. */
  owed: readonly string[];
}

/**
 * The wait of a planned item whose requirement stands delivered or accepted with issues still owed:
 * the release they wait at, as an issue route's item names it, once every one is there; else the
 * issues themselves, which ship it.
 */
export function requirementOwedWait(
  r: RequirementOwed,
  viewer: StandingViewer,
  facts: StandingFacts,
  clock: { since: Date; now: Date },
): Owed | null {
  const issues = carriersPhrase(r.owed);
  if (!issues) return null;
  if (facts.carrierRelease) {
    return issueWait(r.owed, viewer, { ...facts, carrierRelease: facts.carrierRelease }, clock);
  }
  const rule = say('feedback.rule.requirementShips', { req: r.key, status: r.status, issues });
  return {
    wait: waitingOn<FeedbackWaitingKind>(
      'issue',
      { who: issues, act: say('standing.act.ship'), rule },
      { ref: r.owed[0] ?? null },
    ),
    yours: false,
  };
}

/** Why a requirement-routed item reads triaged past delivery: nothing linked will ship it. */
export const requirementGoneRule = (r: RequirementOwed): Said =>
  r.byDecision
    ? say('feedback.rule.acceptedNothingShips', { req: r.key })
    : say('feedback.rule.requirementNothingShips', { req: r.key, status: r.status });
