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
import { type Said, say } from '@forge/contracts/said';
import {
  holdersWho,
  nobodyHoldsAct,
  type Standing,
  type WaitingOn,
  waitingOn,
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
  who: Said,
  act: Said,
  rule: Said,
  extra: { ref?: string | null; dueAt?: string | null } = {},
): FeedbackWaitingOn => waitingOn(kind, { who, act, rule }, extra);

const named = (name: string) => say('standing.who.named', { name });

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
}

const NO_FACTS: StandingFacts = { masterOwesTriage: false, carrierRelease: null };

type Owed = { wait: FeedbackWaitingOn; yours: boolean };

const TRIAGER = say('standing.who.holderOf', { perm: 'feedback.approve' });

/** Several carriers named in one phrase: `ISS-1`, `ISS-1 and ISS-2`, `ISS-1, ISS-2 and ISS-3`. */
export function carriersPhrase(keys: readonly string[]): Said | null {
  const last = keys[keys.length - 1];
  if (last === undefined) return null;
  if (keys.length === 1) return named(last);
  return say('standing.keysAnd', { keys: keys.slice(0, -1).join(', '), last });
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
            say('feedback.act.triageAfterSnooze', { date: facts.snoozedUntil.slice(0, 10) }),
            say('feedback.rule.snoozed', { phase, until: facts.snoozedUntil }),
            { dueAt: facts.snoozedUntil },
          ),
        );
      }
      if (facts.masterOwesTriage)
        return theirs(
          wait(
            'agent',
            say('standing.who.projectMaster'),
            say('standing.act.triageIt'),
            say('feedback.rule.masterOwes', { phase }),
          ),
        );
      return {
        wait: wait(
          'person',
          TRIAGER,
          say('standing.act.triageIt'),
          say('feedback.rule.triagerTriages', { phase }),
        ),
        yours: viewer.canTriage,
      };
    case 'triaged':
      if (route === null) {
        return {
          wait: wait(
            'person',
            TRIAGER,
            say('feedback.act.route'),
            say('feedback.rule.noRoute'),
          ),
          yours: viewer.canTriage,
        };
      }
      return {
        wait: wait(
          'person',
          TRIAGER,
          say('standing.act.triageAgain'),
          say('feedback.rule.carrierGone'),
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
            named(reporter),
            say('standing.act.confirmAnswer'),
            say('feedback.rule.answered'),
          ),
          yours: viewer.isReporter,
        };
      }
      return {
        wait: wait(
          'person',
          named(reporter),
          facts.carrierVersion
            ? say('standing.act.verifyFixIn', { v: facts.carrierVersion })
            : say('standing.act.verifyFix'),
          say('feedback.rule.verify'),
          { ref: facts.carrierVersion ?? null, dueAt: facts.autoVerifyAt ?? null },
        ),
        // owner, 2026-10-07: nobody is owed this act, so it is on no one's Needs you; any member may take it
        yours: false,
      };
    default:
      return theirs(
        wait(
          'none',
          say('standing.who.nothing'),
          say('standing.act.none'),
          say('feedback.rule.nothingOwed', { phase }),
        ),
      );
  }
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
  const issue = carrier ?? say('feedback.who.theLinkedIssue');
  const ref = { ref: carriers[0] ?? null };
  const waits = carriers.length > 1 ? 'wait' : 'waits';
  const release = facts.carrierRelease;
  if (release === null || release === 'automatic') {
    return {
      wait: wait(
        'issue',
        carrier ?? say('standing.who.linkedIssue'),
        say('standing.act.ship'),
        say(carriers.length > 1 ? 'feedback.rule.issuesCarry' : 'feedback.rule.issueCarries'),
        ref,
      ),
      yours: false,
    };
  }
  const version = facts.carrierVersion ?? null;
  const owed = {
    none: {
      act: say('standing.act.releaseByHand', { what: issue }),
      rule: say('feedback.rule.noReleaseModel', { issue, waits }),
      extra: ref,
      yours: viewer.canWrite,
    },
    approval: {
      act: version
        ? say('standing.act.approveReleaseV', { v: version })
        : say('standing.act.approveCarrierRelease'),
      rule: say('feedback.rule.approvalRequired', { issue, waits }),
      extra: { ref: version },
      yours: viewer.canApproveRelease,
    },
    manual: {
      act: say('standing.act.cutCarrierRelease', { what: issue }),
      rule: say('feedback.rule.manualCut', { issue, waits }),
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
        carrier ? named(carrier) : say('standing.who.newRequirement'),
        say('standing.act.beAgreedDelivered'),
        say('feedback.rule.newRequirement'),
        { ref: carrier },
      );
    case 'duplicate':
      return wait(
        'issue',
        carrier ? say('standing.who.itsRoot', { root: carrier }) : say('standing.who.itsRootUnnamed'),
        say('standing.act.beResolved'),
        say('feedback.rule.duplicate'),
        { ref: carrier },
      );
    default:
      return wait(
        'issue',
        say('standing.who.linkedWork'),
        say('standing.act.none'),
        say('feedback.rule.linkedWork'),
      );
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
      say('standing.who.revisionProposal'),
      say('standing.act.beAccepted'),
      say('feedback.rule.proposal'),
    );
  }
  if (revision.stage === 'acceptance') {
    return wait(
      'person',
      say('standing.who.baOrOwner'),
      revisionAct('accept', revision),
      say('feedback.rule.acceptance'),
      { ref: revision.requirement },
    );
  }
  if (revision.stage === 'drafted') {
    return wait(
      'person',
      say('standing.who.itsAuthor'),
      revisionAct('propose', revision),
      say('feedback.rule.drafted'),
      { ref: revision.requirement },
    );
  }
  return wait(
    'issue',
    revision.requirement && revision.revision !== null
      ? say('feedback.who.revision', { req: revision.requirement, r: revision.revision })
      : say('standing.who.currentRevision'),
    say('standing.act.beDelivered'),
    say('feedback.rule.delivery'),
    { ref: revision.requirement },
  );
}

/** `accept revision 2 of REQ-4`, `propose the revision`: the act on a revision, by what is known of it. */
function revisionAct(
  verb: 'accept' | 'propose',
  revision: { revision: number | null; requirement: string | null },
): Said {
  const { revision: r, requirement: req } = revision;
  if (verb === 'accept') {
    if (r === null) {
      return req
        ? say('standing.act.acceptRevisionOf', { req })
        : say('standing.act.acceptRevision');
    }
    return req
      ? say('standing.act.acceptRevisionN', { r, req })
      : say('standing.act.acceptRevisionNum', { r });
  }
  if (r === null) {
    return req
      ? say('standing.act.proposeRevisionOf', { req })
      : say('standing.act.proposeRevision');
  }
  return req
    ? say('standing.act.proposeRevisionN', { r, req })
    : say('standing.act.proposeRevisionNum', { r });
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
    waitingOn: owed.yours
      ? waitingOn(
          'you',
          { ...owed.wait.says, who: say('standing.who.you') },
          { ref: owed.wait.ref, dueAt: owed.wait.dueAt },
        )
      : owed.wait,
  };
}
