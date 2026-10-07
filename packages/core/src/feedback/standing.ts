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
import { RELEASE_ACT_PERMISSION, type ReleaseMode } from '@forge/contracts/forecast';
import {
  holdersWho,
  nobodyHoldsAct,
  type Standing,
  type WaitingOn,
} from '@forge/contracts/standing';
import type { SuggestionStatus } from '@forge/contracts/suggestions';

type FeedbackWaitingOn = WaitingOn<FeedbackWaitingKind>;

/** What the linked work reads, for the phase of a triaged item. */
export interface PhaseFacts {
  status: FeedbackStatus;
  route: FeedbackRoute | null;
  /** The own status of every issue an issue route names (ISS-265); empty on any other route. */
  routedIssueStatuses: readonly string[];
  suggestion: { status: SuggestionStatus; revisionLive: boolean; delivered: boolean } | null;
  routedRequirementStatus: string | null;
  /** The routed requirement reads delivered (`requirements/standing.ts:deliveryOf`) or was accepted. */
  routedRequirementDelivered: boolean;
  rootPhase: FeedbackPhase | null;
}

// planned and resolved are computed on read from the linked work (Q1); a route whose
// carrier died (issue dropped, suggestion rejected, requirement dropped) reads triaged, so a person
// routes it again. An issue route reads every carrier: a dropped one carries nothing, and the item is
// resolved once each that still carries it is closed. verified is only ever the stored decision of a person
export function phaseOf(f: PhaseFacts): FeedbackPhase {
  if (f.status !== 'triaged') return f.status;
  switch (f.route) {
    case 'issue': {
      const carrying = f.routedIssueStatuses.filter((s) => s !== 'dropped');
      if (carrying.length === 0) return 'triaged';
      return carrying.every((s) => s === 'closed') ? 'resolved' : 'planned';
    }
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

/** What the viewer's own permissions let them do to an item, by the checks its `can` reads. */
export interface StandingViewer {
  isReporter: boolean;
  /** `feedback.approve`. */
  canTriage: boolean;
  /** `releases.approve`. */
  canApproveRelease: boolean;
  /** `project.write`. */
  canWrite: boolean;
  /** `project.admin`. */
  canAdmin: boolean;
}

/** How the release a planned item's carrier issue waits at is made (`project-config/release-path.ts:releaseModeOf`). */
export type CarrierRelease = ReleaseMode;

export interface StandingFacts {
  /** An item the project's live master owes a triage (`owed-triage.ts:owedTriages`). */
  masterOwesTriage: boolean;
  /** Set only where the item is planned on issues every one still owed of which stands at `awaiting_release`. */
  carrierRelease: CarrierRelease | null;
  /** The version of the release a carrier issue is already cut into, when one is; else null. */
  carrierVersion?: string | null;
  /** Who holds the permission the carrier's release act takes (`RELEASE_ACT_PERMISSION`), by name. */
  releaseHolders?: readonly string[];
  /** Set while a snooze has not run out: the item is parked out of New until then. */
  snoozedUntil?: string | null;
  /** While it reads resolved and a sweep has dated it: when Forge verifies it if nobody has. */
  autoVerifyAt?: string | null;
  /** It reads resolved and nothing told its reporter the work shipped (`ship-notice.ts`): a person relays it. */
  relayOwed?: boolean;
  /** Who holds feedback.approve, by name: those who owe the relay. */
  relayHolders?: readonly string[];
}

const NO_FACTS: StandingFacts = { masterOwesTriage: false, carrierRelease: null };

type Owed = { wait: FeedbackWaitingOn; yours: boolean };

const TRIAGER = 'A holder of feedback.approve';

/** Several carriers named in one phrase: `ISS-1`, `ISS-1 and ISS-2`, `ISS-1, ISS-2 and ISS-3`. */
export function carriersPhrase(keys: readonly string[]): string | null {
  if (keys.length <= 1) return keys[0] ?? null;
  return `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`;
}

/** Who or what an item waits on, and whether that act is one the viewer holds. */
function waitingOf(
  phase: FeedbackPhase,
  route: FeedbackRoute | null,
  carriers: readonly string[],
  reporter: string,
  revision: RevisionStage | null,
  viewer: StandingViewer,
  facts: StandingFacts,
): Owed {
  const theirs = (w: FeedbackWaitingOn): Owed => ({ wait: w, yours: false });
  switch (phase) {
    case 'new':
    case 'reopened':
      if (facts.snoozedUntil) {
        return theirs(
          wait(
            'person',
            TRIAGER,
            `triage it once the snooze ends, ${facts.snoozedUntil.slice(0, 10)}`,
            `${phase}: snoozed until ${facts.snoozedUntil}, when it returns to New for a holder of feedback.approve`,
            { dueAt: facts.snoozedUntil },
          ),
        );
      }
      if (facts.masterOwesTriage)
        return theirs(
          wait(
            'agent',
            "The project's master",
            'triage it',
            `${phase}: untriaged feedback owes the project's master a triage; a holder of feedback.approve may triage it first`,
          ),
        );
      return {
        wait: wait(
          'person',
          TRIAGER,
          'triage it',
          `${phase}: a holder of feedback.approve triages it`,
        ),
        yours: viewer.canTriage,
      };
    case 'triaged':
      if (route === null) {
        return {
          wait: wait(
            'person',
            TRIAGER,
            'route it to work',
            'triaged: it was accepted with no route yet, so a holder of feedback.approve routes it',
          ),
          yours: viewer.canTriage,
        };
      }
      return {
        wait: wait(
          'person',
          TRIAGER,
          'triage it again',
          "triaged: the route's carrier is gone, so a holder of feedback.approve routes it anew",
        ),
        yours: viewer.canTriage,
      };
    case 'planned':
      if (route === 'issue') return issueWait(carriers, viewer, facts);
      return theirs(plannedWait(route, carriers[0] ?? null, revision));
    case 'resolved':
      if (route === 'answer') {
        return {
          wait: wait(
            'person',
            reporter,
            'Confirm the answer',
            'resolved: the question was answered, and the reporter confirms the answer settled it',
          ),
          yours: viewer.isReporter,
        };
      }
      if (facts.relayOwed) return relayWait(reporter, viewer, facts);
      return {
        wait: wait(
          'person',
          reporter,
          facts.carrierVersion
            ? `verify the fix shipped in ${facts.carrierVersion}`
            : 'verify the fix',
          'resolved: anyone on the project, or the reporter, may confirm the fix, and Forge verifies it when nobody has within the project’s verify window',
          { ref: facts.carrierVersion ?? null, dueAt: facts.autoVerifyAt ?? null },
        ),
        // owner, 2026-10-07: nobody is owed this act, so it is on no one's Needs you; any member may take it
        yours: false,
      };
    default:
      return theirs(wait('none', 'Nothing', '', `${phase}: nothing is owed`));
  }
}

// no notice reached the reporter (an agent, a person off Forge's bell, a notice turned off, or work
// no release carried), so the holders of feedback.approve tell them, and it is on their Needs you
// until a message or a recorded relay does (Linear's customer requests reopen the support
// conversation for a person to answer in the same way: the requester is outside the tracker)
function relayWait(reporter: string, viewer: StandingViewer, facts: StandingFacts): Owed {
  const act = facts.carrierVersion
    ? `tell ${reporter} that it shipped in ${facts.carrierVersion}`
    : `tell ${reporter} that it shipped`;
  const rule =
    'resolved: no notice told the reporter the work shipped, so a holder of feedback.approve tells them, by a message to reporters or by recording what they told them outside Forge';
  const extra = { ref: facts.carrierVersion ?? null };
  const holders = facts.relayHolders ?? [];
  const yours = viewer.canTriage && !viewer.isReporter;
  if (holders.length === 0 && !yours) {
    return {
      wait: wait('none', holdersWho(holders), nobodyHoldsAct(act, 'feedback.approve'), rule, extra),
      yours: false,
    };
  }
  return { wait: wait('person', holdersWho(holders), act, rule, extra), yours };
}

// a carrier at the release gate waits on whoever makes that release, by name: never a bare "ship"
// in a project where nothing ships it (eco round 4, #45), never a role naming nobody. `carriers` are
// the issues still owed, every one named; `ref` is the first of them
function issueWait(
  carriers: readonly string[],
  viewer: StandingViewer,
  facts: StandingFacts,
): Owed {
  const carrier = carriersPhrase(carriers);
  const issue = carrier ?? 'the linked issue';
  const ref = { ref: carriers[0] ?? null };
  const waits = carriers.length > 1 ? 'wait' : 'waits';
  const release = facts.carrierRelease;
  if (release === null || release === 'automatic') {
    return {
      wait: wait(
        'issue',
        carrier ?? 'The linked issue',
        'ship',
        carriers.length > 1 ? 'planned: its issues carry it' : 'planned: its issue carries it',
        ref,
      ),
      yours: false,
    };
  }
  const version = facts.carrierVersion ?? null;
  const owed = {
    none: {
      act: `release ${issue} by hand and close it`,
      rule: `planned: ${issue} ${waits} at awaiting_release and this project declares no release model (no production environment), so no release carries it and a person releases it`,
      extra: ref,
      yours: viewer.canWrite,
    },
    approval: {
      act: version ? `Approve release ${version}` : 'Approve the release that carries it',
      rule: `planned: ${issue} ${waits} at awaiting_release and this project requires a holder of releases.approve to approve its release`,
      extra: { ref: version },
      yours: viewer.canApproveRelease,
    },
    manual: {
      act: `cut the release that carries ${issue}`,
      rule: `planned: ${issue} ${waits} at awaiting_release and this project's production does not deploy on land, so a holder of project.admin cuts its release`,
      extra: ref,
      yours: viewer.canAdmin,
    },
  }[release];
  const holders = facts.releaseHolders ?? [];
  if (holders.length === 0 && !owed.yours) {
    return {
      wait: wait(
        'none',
        holdersWho(holders),
        nobodyHoldsAct(owed.act, RELEASE_ACT_PERMISSION[release]),
        owed.rule,
        owed.extra,
      ),
      yours: false,
    };
  }
  return {
    wait: wait('person', holdersWho(holders), owed.act, owed.rule, owed.extra),
    yours: owed.yours,
  };
}

function plannedWait(
  route: FeedbackRoute | null,
  carrier: string | null,
  revision: RevisionStage | null,
): FeedbackWaitingOn {
  switch (route) {
    case 'revision':
      return revisionWait(revision);
    case 'new_requirement':
      return wait(
        'issue',
        carrier ?? 'The new requirement',
        'be agreed and delivered',
        'planned: a new requirement carries it',
        { ref: carrier },
      );
    case 'duplicate':
      return wait(
        'issue',
        `Its root ${carrier ?? ''}`.trim(),
        'be resolved',
        'planned: the root item it duplicates carries it',
        { ref: carrier },
      );
    default:
      return wait('issue', 'The linked work', '', 'planned: the linked work carries it');
  }
}

/** The list's group for an item, from whether the act it waits on is the viewer's own. */
function groupOf(phase: FeedbackPhase, owed: Owed): FeedbackAttentionGroup {
  if (owed.yours) return 'needs_you';
  if (phase === 'planned' || owed.wait.kind === 'agent') return 'moving';
  if (phase === 'verified' || phase === 'declined') return 'done';
  return 'waiting';
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
  carriers: readonly string[],
  reporter: string,
  viewer: StandingViewer,
  revision: RevisionStage | null,
  facts: StandingFacts = NO_FACTS,
): Standing<FeedbackAttentionGroup, FeedbackWaitingKind> {
  const owed = waitingOf(phase, route, carriers, reporter, revision, viewer, facts);
  const attentionGroup = groupOf(phase, owed);
  return {
    attentionGroup,
    waitingOn: owed.yours ? { ...owed.wait, kind: 'you', who: 'You' } : owed.wait,
  };
}
