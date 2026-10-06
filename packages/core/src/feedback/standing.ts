/**
 * Where a feedback item stands for one viewer (workflows `feedback-lifecycle`, `feedback-triage` r4,
 * requirement-to-delivery step `fb-case`: the row and its group are the case): the group the list draws it under and whom it waits
 * on, and the phase a reader sees. Pure over what `read.ts` read.
 */

import type {
  FeedbackAttentionGroup,
  FeedbackPhase,
  FeedbackRoute,
  FeedbackStatus,
  FeedbackWaitingKind,
} from '@forge/contracts/feedback';
import type { Standing, WaitingOn } from '@forge/contracts/standing';
import type { SuggestionStatus } from '@forge/contracts/suggestions';

type FeedbackWaitingOn = WaitingOn<FeedbackWaitingKind>;

/** What the linked work reads, for the phase of a triaged item. */
export interface PhaseFacts {
  status: FeedbackStatus;
  route: FeedbackRoute | null;
  routedIssueStatus: string | null;
  suggestion: { status: SuggestionStatus; revisionLive: boolean; delivered: boolean } | null;
  routedRequirementStatus: string | null;
  /** The routed requirement reads delivered (`requirements/standing.ts:deliveryOf`) or was accepted. */
  routedRequirementDelivered: boolean;
  rootPhase: FeedbackPhase | null;
}

// planned and resolved are computed on read from the linked work (Q1); a route whose
// carrier died (issue dropped, suggestion rejected, requirement dropped) reads triaged, so a person
// routes it again. verified is only ever the stored decision of a person
export function phaseOf(f: PhaseFacts): FeedbackPhase {
  if (f.status !== 'triaged') return f.status;
  switch (f.route) {
    case 'issue':
      if (f.routedIssueStatus === 'closed') return 'resolved';
      return f.routedIssueStatus === 'dropped' ? 'triaged' : 'planned';
    case 'revision':
      if (!f.suggestion) return 'triaged';
      if (f.suggestion.status === 'accepted') {
        return f.suggestion.revisionLive && f.suggestion.delivered ? 'resolved' : 'planned';
      }
      return f.suggestion.status === 'proposed' ? 'planned' : 'triaged';
    // workflow feedback-lifecycle edge planned → resolved: the linked requirement reads
    // delivered; agreeing it only plans the work, so an agreed requirement keeps the item planned
    case 'new_requirement':
      if (f.routedRequirementDelivered) return 'resolved';
      return f.routedRequirementStatus === 'dropped' ? 'triaged' : 'planned';
    case 'answer':
      return 'resolved';
    case 'duplicate':
      if (f.rootPhase === 'resolved' || f.rootPhase === 'verified') return 'resolved';
      return f.rootPhase === 'declined' ? 'declined' : 'planned';
    default:
      return 'triaged';
  }
}

/**
 * Which act a revision-routed item's revision owes next: a person deciding the proposal, a signer
 * accepting the proposed revision the accept wrote, its author proposing a revision that is a draft
 * (a signer returned it), or the work that delivers the current revision.
 */
export type RevisionStage =
  | { stage: 'proposal' }
  | {
      stage: 'acceptance' | 'drafted' | 'delivery';
      revision: number | null;
      requirement: string | null;
    };

/** The stage read off the routed suggestion and its revision; null where none was read. */
export function revisionStageOf(
  s: {
    status: string;
    revisionState: string | null;
    delivered: boolean;
    requirement: string | null;
    revision: number | null;
  } | null,
): RevisionStage | null {
  if (!s) return null;
  if (s.status !== 'accepted') return { stage: 'proposal' };
  const live = s.revisionState === 'current' || s.revisionState === 'superseded';
  return {
    stage: live ? 'delivery' : s.revisionState === 'draft' ? 'drafted' : 'acceptance',
    revision: s.revision,
    requirement: s.requirement,
  };
}

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

/** Who or what an item waits on, whoever reads it. */
function waitingOf(
  phase: FeedbackPhase,
  route: FeedbackRoute | null,
  carrier: string | null,
  reporter: string,
  revision: RevisionStage | null,
): FeedbackWaitingOn {
  switch (phase) {
    case 'new':
    case 'reopened':
      return wait('person', 'A person', 'triage it', `${phase}: a member triages it`);
    case 'triaged':
      return wait(
        'person',
        'A person',
        'triage it again',
        "triaged: the route's carrier is gone, so a member routes it anew",
      );
    case 'planned':
      if (route === 'issue')
        return wait(
          'issue',
          carrier ?? 'The linked issue',
          'ship',
          'planned: its issue carries it',
          {
            ref: carrier,
          },
        );
      if (route === 'revision') return revisionWait(revision);
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

// a revision-routed item waits on a person only while a person owes its revision an act; an accepted
// revision_diff lands its revision proposed, so the act owed is the accept that re-baselines it, and a
// draft is one a signer returned to its author; once the revision is current, the work delivers it
function revisionWait(revision: RevisionStage | null): FeedbackWaitingOn {
  if (!revision || revision.stage === 'proposal') {
    return wait(
      'person',
      'The revision proposal',
      'be accepted',
      'planned: a requirement revision proposal carries it, and a person decides it',
    );
  }
  const n = revision.revision === null ? 'the revision' : `revision ${revision.revision}`;
  const of = revision.requirement ? ` of ${revision.requirement}` : '';
  if (revision.stage === 'acceptance') {
    return wait(
      'person',
      'BA or owner',
      `accept ${n}${of}`,
      'planned: the accepted suggestion proposed its revision, and a holder of requirements.approve accepts it',
      { ref: revision.requirement },
    );
  }
  if (revision.stage === 'drafted') {
    return wait(
      'person',
      'Its author',
      `propose ${n}${of}`,
      'planned: its revision is a draft, returned by a signer, and its author proposes it',
      { ref: revision.requirement },
    );
  }
  return wait(
    'issue',
    revision.requirement && revision.revision !== null
      ? `${revision.requirement} r${revision.revision}`
      : 'The current revision',
    'be delivered',
    'planned: its requirement revision is current, and the work delivering it carries it',
    { ref: revision.requirement },
  );
}

export function feedbackStandingOf(
  phase: FeedbackPhase,
  route: FeedbackRoute | null,
  carrier: string | null,
  reporter: string,
  viewerIsReporter: boolean,
  revision: RevisionStage | null,
): Standing<FeedbackAttentionGroup, FeedbackWaitingKind> {
  const attentionGroup = groupOf(phase, viewerIsReporter);
  const w = waitingOf(phase, route, carrier, reporter, revision);
  return {
    attentionGroup,
    waitingOn: attentionGroup === 'needs_you' ? { ...w, kind: 'you', who: 'You' } : w,
  };
}
