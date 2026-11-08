/**
 * The verify door's guards (workflow `feedback-lifecycle` `verify`, `feedback-triage` `verify-ask`),
 * pure over the phase the read model reads (`standing.ts:phaseOf`) and the criteria the item's
 * carriers shipped failing (`list-read.ts:shippedFailingIn`, ISS-1159).
 */

import type { FeedbackPhase, FeedbackRefusal } from '@forge/contracts/feedback';
import { refusal } from './rules.js';

// verify follows resolved and nothing else: never before its fix shipped (FEEDBACK_NOT_RESOLVED)
// a carrier that shipped with a criterion whose latest verdict is `fail` verifies nothing, whoever
// asks (ISS-1159): the item reads planned until a release ships it with that criterion passing
export function verifyRefusal(
  phase: FeedbackPhase,
  shippedFailing: readonly string[] = [],
): FeedbackRefusal | null {
  if (shippedFailing.length > 0) {
    return refusal(
      'FEEDBACK_CARRIER_FAILED',
      '/status',
      `its carrier shipped with a failing criterion (${shippedFailing.join(', ')}); it is verified only once a release ships it with that criterion passing.`,
    );
  }
  if (phase === 'resolved') return null;
  return refusal(
    'FEEDBACK_NOT_RESOLVED',
    '/status',
    `the item reads ${phase}; it is verified only once its linked work shipped (resolved), by its reporter or a person on their behalf.`,
  );
}

// the reporter is asked only about a resolved item (FEEDBACK_NOT_RESOLVED), and never by themselves
// (FEEDBACK_VERIFY_ASK_SELF): the reporter verifies their own item directly
export function verifyAskRefusal(
  phase: FeedbackPhase,
  askerIsReporter: boolean,
): FeedbackRefusal | null {
  if (phase !== 'resolved') {
    return refusal(
      'FEEDBACK_NOT_RESOLVED',
      '/status',
      `the item reads ${phase}; the reporter is asked to verify it only once its linked work shipped (resolved).`,
    );
  }
  if (askerIsReporter) {
    return refusal(
      'FEEDBACK_VERIFY_ASK_SELF',
      '',
      'you reported this item; verify it (POST .../verify) or reopen it (POST .../reopen) instead of asking yourself.',
    );
  }
  return null;
}
