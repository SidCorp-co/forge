/**
 * The waits of a feedback item whose work is carried by issues (feedback-lifecycle `planned`): the
 * release leg once every owed carrier waits at the gate, the reporter's relay once it shipped, and
 * the carrier's own standing before that, rolled up (REQ-48 BC-9).
 */

import type { FeedbackWaitingKind } from '@forge/contracts/feedback';
import { RELEASE_ACT_PERMISSION } from '@forge/contracts/forecast';
import type { IssueWaitingKind } from '@forge/contracts/issue-standing';
import { type Said, say } from '@forge/contracts/said';
import { holdersWho, nobodyHoldsAct, type WaitingOn, waitingOn } from '@forge/contracts/standing';
import type { StuckReading } from '@forge/contracts/steward';
import type { Owed, StandingFacts, StandingViewer } from './standing.js';

type FeedbackWaitingOn = WaitingOn<FeedbackWaitingKind>;

const wait = (
  kind: FeedbackWaitingKind,
  who: Said,
  act: Said,
  rule: Said,
  extra: { ref?: string | null; dueAt?: string | null } = {},
): FeedbackWaitingOn => waitingOn(kind, { who, act, rule }, extra);

const named = (name: string) => say('standing.who.named', { name });

/** An owed carrier issue's own standing (`issues/standing.ts`), as the item rolls it up. */
export interface CarrierStanding {
  key: string;
  waitingOn: WaitingOn<IssueWaitingKind>;
  since: Date;
  stuck: StuckReading | null;
}

/** An issue's party as a feedback item's: the runs, the master and the judge are all agents to it. */
const KIND_OF: Record<IssueWaitingKind, FeedbackWaitingKind> = {
  you: 'person',
  person: 'person',
  run: 'agent',
  master: 'agent',
  judge: 'agent',
  issue: 'issue',
  release: 'issue',
  none: 'none',
};

/** The carrier's own wait, said as the item's: who it names, its act on the carrier, its rule. */
export function carrierWait(c: CarrierStanding | null, carriers: readonly string[]): Owed {
  if (!c) {
    const key = carriers[0] ?? null;
    return {
      wait: wait(
        'none',
        say('standing.who.nobody'),
        say('standing.act.none'),
        say('feedback.rule.carrierUnread', { key: key ?? '' }),
        { ref: key },
      ),
      yours: false,
    };
  }
  const w = c.waitingOn;
  return {
    wait: wait(
      KIND_OF[w.kind],
      w.says.who,
      say('standing.act.onIssue', { act: w.says.act, key: c.key }),
      say('feedback.rule.carrierWaits', { key: c.key, rule: w.says.rule }),
      { ref: c.key, dueAt: w.dueAt },
    ),
    yours: false,
  };
}

/** A draft carrier: nothing takes a draft on by itself, so the item waits on someone to (draft_carrier). */
export const draftCarrierWait = (key: string): Owed => ({
  wait: wait(
    'person',
    say('standing.who.someone'),
    say('standing.act.takeOn', { key }),
    say('feedback.rule.draftCarrier', { key }),
    { ref: key },
  ),
  yours: false,
});

/** Several carriers named in one phrase: `ISS-1`, `ISS-1 and ISS-2`, `ISS-1, ISS-2 and ISS-3`. */
export function carriersPhrase(keys: readonly string[]): Said | null {
  const last = keys[keys.length - 1];
  if (last === undefined) return null;
  if (keys.length === 1) return named(last);
  return say('standing.keysAnd', { keys: keys.slice(0, -1).join(', '), last });
}

// no notice reached the reporter (an agent, a person off Forge's bell, a notice turned off, or work
// no release carried), so the holders of feedback.approve tell them, and it is on their Needs you
// until a message or a recorded relay does (Linear's customer requests reopen the support
// conversation for a person to answer in the same way: the requester is outside the tracker)
export function relayWait(reporter: string, viewer: StandingViewer, facts: StandingFacts): Owed {
  const act = facts.carrierVersion
    ? say('standing.act.tellShippedIn', { who: reporter, v: facts.carrierVersion })
    : say('standing.act.tellShipped', { who: reporter });
  const rule = say('feedback.rule.relay');
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
export function issueWait(
  carriers: readonly string[],
  viewer: StandingViewer,
  facts: StandingFacts & { carrierRelease: NonNullable<StandingFacts['carrierRelease']> },
): Owed {
  const carrier = carriersPhrase(carriers);
  const issue = carrier ?? say('feedback.who.theLinkedIssue');
  const ref = { ref: carriers[0] ?? null };
  const waits = carriers.length > 1 ? 'wait' : 'waits';
  const release = facts.carrierRelease;
  if (release === 'automatic') {
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
