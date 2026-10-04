/**
 * Where a feedback item stands for one viewer (workflows `feedback-lifecycle`, `feedback-triage` r3,
 * requirement-to-delivery r2 step `fb-case`): the group the list draws it under and whom it waits
 * on. Pure over what `read.ts` read.
 */

import {
  FEEDBACK_CASE_OWNER_LABELS,
  type FeedbackAttentionGroup,
  type FeedbackCaseView,
  type FeedbackPhase,
  type FeedbackRoute,
  type FeedbackTriageRoute,
  type FeedbackWaitingKind,
} from '@forge/contracts/feedback';
import type { Standing, WaitingOn } from '@forge/contracts/standing';

type FeedbackWaitingOn = WaitingOn<FeedbackWaitingKind>;

const ROUTE_ACTS: Record<FeedbackTriageRoute, string> = {
  issue: 'create or link the issue',
  revision: 'name the revision proposal',
  new_requirement: 'start the draft requirement',
  answer: 'write the answer',
  duplicate: 'name the root',
  decline: 'decline it',
};

const wait = (
  kind: FeedbackWaitingKind,
  who: string,
  act: string,
  rule: string,
  extra: { ref?: string | null; dueAt?: string | null } = {},
): FeedbackWaitingOn => ({
  kind,
  who,
  act,
  rule,
  ref: extra.ref ?? null,
  dueAt: extra.dueAt ?? null,
});

/** A member triages, the reporter verifies. */
function groupOf(phase: FeedbackPhase, viewerIsReporter: boolean): FeedbackAttentionGroup {
  if (phase === 'new' || phase === 'triaged' || phase === 'reopened') return 'needs_you';
  if (phase === 'planned') return 'moving';
  if (phase === 'resolved') return viewerIsReporter ? 'needs_you' : 'waiting';
  return 'done';
}

// step fb-case: a triaged item waits on its case's owner by name and due while the route is not
// written. A written route whose carrier died reads triaged again, and triage is the BA's
function caseWaiting(c: FeedbackCaseView | null): FeedbackWaitingOn {
  const ba = FEEDBACK_CASE_OWNER_LABELS.ba;
  if (!c) return wait('person', ba, 'triage it', 'triaged with no case: the BA triages it');
  if (c.routedAt !== null) {
    return wait(
      'person',
      ba,
      `triage it again: what carried its ${c.route} route is gone`,
      'the carrier of its written route is gone, so it reads triaged again',
    );
  }
  const due = `${c.overdue ? 'overdue since' : 'due'} ${c.dueAt.slice(0, 10)}`;
  return wait(
    c.owner === 'master' ? 'agent' : 'person',
    FEEDBACK_CASE_OWNER_LABELS[c.owner],
    `${ROUTE_ACTS[c.route]}, ${due}`,
    'step fb-case: the case owner writes the route by its due',
    { dueAt: c.dueAt },
  );
}

/** Who or what an item waits on, whoever reads it. */
function waitingOf(
  phase: FeedbackPhase,
  route: FeedbackRoute | null,
  carrier: string | null,
  reporter: string,
  kase: FeedbackCaseView | null,
): FeedbackWaitingOn {
  switch (phase) {
    case 'new':
    case 'reopened':
      return wait('person', 'A person', 'triage it', `${phase}: a member triages it`);
    case 'triaged':
      return caseWaiting(kase);
    case 'planned':
      if (route === 'issue')
        return wait('issue', carrier ?? 'The linked issue', 'ship', 'planned: its issue carries it', {
          ref: carrier,
        });
      if (route === 'revision')
        return wait(
          'person',
          'The revision proposal',
          'be accepted and delivered',
          'planned: a requirement revision carries it',
        );
      if (route === 'new_requirement')
        return wait(
          'issue',
          carrier ?? 'The new requirement',
          'be agreed and delivered',
          'planned: a new requirement carries it',
          { ref: carrier },
        );
      if (route === 'duplicate')
        return wait(
          'issue',
          `Its root ${carrier ?? ''}`.trim(),
          'be resolved',
          'planned: the root item it duplicates carries it',
          { ref: carrier },
        );
      return wait('issue', 'The linked work', '', 'planned: the linked work carries it');
    case 'resolved':
      return wait('person', reporter, 'verify the fix', 'resolved: the reporter verifies the fix');
    default:
      return wait('none', 'Nothing', '', `${phase}: nothing is owed`);
  }
}

export function feedbackStandingOf(
  phase: FeedbackPhase,
  route: FeedbackRoute | null,
  carrier: string | null,
  reporter: string,
  kase: FeedbackCaseView | null,
  viewerIsReporter: boolean,
): Standing<FeedbackAttentionGroup, FeedbackWaitingKind> {
  const attentionGroup = groupOf(phase, viewerIsReporter);
  const w = waitingOf(phase, route, carrier, reporter, kase);
  return {
    attentionGroup,
    waitingOn: attentionGroup === 'needs_you' ? { ...w, kind: 'you', who: 'You' } : w,
  };
}
