/**
 * The waits of a feedback item whose work is carried by issues (feedback-lifecycle `planned`): the
 * release leg once every owed carrier waits at the gate, the reporter's relay once it shipped, and
 * the carrier's own standing before that, rolled up (REQ-48 BC-9).
 */

import type { FeedbackWaitingKind } from '@forge/contracts/feedback';
import { RELEASE_ACT_PERMISSION } from '@forge/contracts/forecast';
import type { IssueWaitingKind } from '@forge/contracts/issue-standing';
import type { ReleaseWaitingKind } from '@forge/contracts/releases';
import { type Said, say } from '@forge/contracts/said';
import { holdersWho, nobodyHoldsAct, type WaitingOn, waitingOn } from '@forge/contracts/standing';
import { STANDING_DUE_WORKING_DAYS, type StuckReading } from '@forge/contracts/steward';
import { issuesNamed } from '../lib/named-items.js';
import { addWorkingDays } from '../lib/working-days.js';
import type { CarryingRelease } from './dependents.js';
import type { Linked } from './list-read.js';
import type { Row } from './read.js';
import type { Owed, PhaseFacts, StandingFacts, StandingViewer } from './standing.js';

type FeedbackWaitingOn = WaitingOn<FeedbackWaitingKind>;

const wait = (
  kind: FeedbackWaitingKind,
  who: Said,
  act: Said,
  rule: Said,
  extra: { ref?: string | null; dueAt?: string | null } = {},
): FeedbackWaitingOn => waitingOn(kind, { who, act, rule }, extra);

const named = (name: string) => say('standing.who.named', { name });

/** A routed issue as an item's phase reads it (`standing.ts:PhaseFacts`). */
export interface RoutedIssueFacts {
  key?: string;
  status: string;
  unreleased: boolean;
  /** Its live criteria whose latest verdict is `fail`, by number (ISS-1159). */
  failing?: readonly number[];
  /** Its live criteria whose latest verdict is `skipped`, owed live, by number (ISS-1234). */
  owed?: readonly number[];
}

/** An owed carrier issue's own standing (`issues/standing.ts`), as the item rolls it up. */
export interface CarrierStanding {
  key: string;
  /** Its title, which the item's wait names it by (ISS-1184). */
  title: string;
  waitingOn: WaitingOn<IssueWaitingKind>;
  since: Date;
  stuck: StuckReading | null;
}

/**
 * An issue's party as a feedback item's: the runs, the master and the judge are all agents to it,
 * and so is a person the issue waits on. A person never works an issue (REQ-68 BC-4, BC-6): the
 * master moves the carrier on, and a decision only a person may take reaches them as the master's
 * question on the item, never as this wait.
 */
const KIND_OF: Record<IssueWaitingKind, FeedbackWaitingKind> = {
  person: 'agent',
  answer: 'agent',
  run: 'agent',
  master: 'agent',
  judge: 'agent',
  issue: 'issue',
  release: 'issue',
  none: 'none',
};

/** The carrier waits on a person, or on an answer a person owes, which the item reads as its master's to move on. */
const PERSON_KINDS: ReadonlySet<IssueWaitingKind> = new Set(['person', 'answer']);

/**
 * What the item says of a carrier parked on a person: on an answer, that it waits on the answer asked
 * in Needs you, naming nobody who owes it (REQ-68 BC-4); its own act and rule, so a note the steward
 * wrote while the carrier named the people owing it stands on another basis and is drawn nowhere
 * (ISS-687 round 4: FB-147's row read "ISS-582 is parked awaiting orchestrator and QA's answer").
 */
const parkedSays = (kind: IssueWaitingKind, key: string) =>
  kind === 'answer'
    ? {
        act: say('standing.act.moveOnAnswered', { key }),
        rule: say('feedback.rule.carrierAsked', { key }),
      }
    : {
        act: say('standing.act.moveOn', { key }),
        rule: say('feedback.rule.carrierParked', { key }),
      };

const MASTER = say('standing.who.projectMaster');

/** The carrier's own wait, said as the item's: who it names, its act on the carrier, its rule. */
export function carrierWait(
  c: CarrierStanding | null,
  carriers: readonly string[],
  shippedFailing: readonly string[] = [],
): Owed {
  if (shippedFailing.length > 0) return { wait: shippedFailingWait(shippedFailing), yours: false };
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
  if (PERSON_KINDS.has(w.kind)) {
    const parked = parkedSays(w.kind, c.key);
    return {
      wait: wait(KIND_OF[w.kind], MASTER, parked.act, parked.rule, {
        ref: c.key,
        dueAt: w.dueAt,
      }),
      yours: false,
    };
  }
  return {
    wait: wait(
      KIND_OF[w.kind],
      w.says.who,
      say('standing.act.onIssue', { act: w.says.act, issue: issuesNamed([c.title]) }),
      say('feedback.rule.carrierWaits', { key: c.key, rule: w.says.rule }),
      { ref: c.key, dueAt: w.dueAt },
    ),
    yours: false,
  };
}

/** A draft carrier: nothing takes a draft on by itself, so the item waits on the master to (draft_carrier). */
export const draftCarrierWait = (key: string): Owed => ({
  wait: wait(
    'agent',
    MASTER,
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
  clock: { since: Date; now: Date },
): Owed {
  const carrier = carriersPhrase(carriers);
  const issue = carrier ?? say('feedback.who.theLinkedIssue');
  if (facts.carrierRun) return releaseRunWait(issue, facts.carrierRun);
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
  if (release === 'manual') {
    const cut = manualCut(issue, waits, ref.ref, facts, clock);
    if ('master' in cut) return cut.master;
    return personRelease(release, facts, {
      act: say('standing.act.cutCarrierRelease', { what: issue }),
      rule: cut.rule,
      extra: ref,
      yours: viewer.canAdmin,
    });
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
  }[release];
  return personRelease(release, facts, owed);
}

/** A release's party as a feedback item's: the release run itself, moving or held by its gate, is the carrier's. */
const RELEASE_KIND_OF: Record<ReleaseWaitingKind, FeedbackWaitingKind> = {
  you: 'person',
  person: 'person',
  agent: 'agent',
  system: 'issue',
  none: 'none',
};

/**
 * Carriers a cut release carries wait on that release's act now, as its own page says it (its
 * approval, its promotion, its deploy), owed by whoever holds it there, never on the cut it already
 * had (ISS-1295: gwork FB-89 asked for the cut of 0.28.0 while it awaited approval). The act is the
 * release's, on the release's holders' Needs you, so it is on no one's here.
 */
function releaseRunWait(issue: Said, run: CarryingRelease): Owed {
  const w = run.waitingOn;
  return {
    wait: wait(
      RELEASE_KIND_OF[w.kind],
      w.says.who,
      say('standing.act.onRelease', { act: w.says.act, v: run.version }),
      say('feedback.rule.releaseCarries', { v: run.version, issue, rule: w.says.rule }),
      { ref: run.version, dueAt: w.dueAt },
    ),
    yours: false,
  };
}

/**
 * The `manual` model's cut (ISS-1244): the project's master's where the one rule gives it the cut
 * (`release.cut`: outside strict, nothing carried that cannot be undone), as the release page names
 * it (ISS-1232), on no person's Needs you, admins included, until its due passes; the release-cut
 * class's due (`STANDING_DUE_WORKING_DAYS.release_cut`) from when the wait began. Past that due, or
 * where the rule gives the cut to a person, it is a project.admin holder's, and the rule says which.
 */
function manualCut(
  issue: Said,
  waits: 'wait' | 'waits',
  ref: string | null,
  facts: StandingFacts,
  clock: { since: Date; now: Date },
): { master: Owed } | { rule: Said } {
  const cut = facts.releaseCut;
  if (!cut) {
    throw new Error(
      'feedback standing: a carrier waits at a manual release with no releaseCut read; the reader reads who owes the cut (`who-owes.ts:whoOwes`, release.cut) wherever carrierRelease is manual',
    );
  }
  if (cut.by === 'person')
    return { rule: say('feedback.rule.manualCut', { issue, waits, why: cut.why }) };
  const due = addWorkingDays(clock.since, STANDING_DUE_WORKING_DAYS.release_cut ?? 0);
  const date = due.toISOString().slice(0, 10);
  if (clock.now.getTime() > due.getTime()) {
    return { rule: say('feedback.rule.masterCutLate', { issue, waits, date }) };
  }
  return {
    master: {
      wait: wait(
        'agent',
        MASTER,
        say('standing.act.cutCarrierRelease', { what: issue }),
        say('feedback.rule.masterCuts', { issue, waits, date }),
        { ref, dueAt: due.toISOString() },
      ),
      yours: false,
    },
  };
}

/** A release act a person owes, by the holders of the permission it takes; nobody holding it says so. */
function personRelease(
  release: Exclude<NonNullable<StandingFacts['carrierRelease']>, 'automatic'>,
  facts: StandingFacts,
  owed: { act: Said; rule: Said; extra: { ref?: string | null }; yours: boolean },
): Owed {
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

/**
 * The criteria an issue route's carriers shipped failing, as `ISS-18 c2`: each carrier closed and
 * released whose latest verdict on a live criterion is `fail` (ISS-1159: sid-desk FB-9 read resolved,
 * and was verified by ship, on the release that shipped its carrier's failing c2). Empty on any other
 * route.
 */
export function shippedFailingOf(f: PhaseFacts): string[] {
  return f.status === 'triaged' && f.route === 'issue' ? failingOf(f.routedIssues) : [];
}

/**
 * The criteria an issue route's carriers shipped owed a live verdict, as `ISS-382 c3`: each carrier
 * closed and released whose latest verdict on a live criterion is `skipped` (ISS-1234). The item reads
 * resolved, and the ship sweep does not verify it until that verdict passes.
 */
export function shippedOwedOf(f: PhaseFacts): string[] {
  if (f.status !== 'triaged' || f.route !== 'issue') return [];
  return f.routedIssues.flatMap((i) =>
    i.status === 'closed' && !i.unreleased
      ? (i.owed ?? []).map((n) => `${i.key ?? 'its carrier'} c${n}`)
      : [],
  );
}

/** A resolved item whose carrier shipped a criterion owed live waits on that verdict, not on the sweep. */
export function shippedOwedWait(shippedOwed: readonly string[]): FeedbackWaitingOn {
  const owed = shippedOwed.join(', ');
  return wait(
    'issue',
    named(owed),
    say('standing.act.judgeShipped', { criteria: owed }),
    say('feedback.rule.shippedOwed', { owed }),
    { ref: shippedOwed[0]?.split(' ')[0] ?? null },
  );
}

const failingOf = (routed: readonly RoutedIssueFacts[]): string[] =>
  routed.flatMap((i) =>
    i.status === 'closed' && !i.unreleased
      ? (i.failing ?? []).map((n) => `${i.key ?? 'its carrier'} c${n}`)
      : [],
  );

/**
 * An issue route's phase (`standing.ts:phaseOf`): triaged while nothing carries it or a draft does,
 * resolved once every carrier is closed and released with no criterion failing, else planned.
 */
export function issuePhaseOf(
  routed: readonly RoutedIssueFacts[],
): 'triaged' | 'planned' | 'resolved' {
  const carrying = routed.filter((i) => i.status !== 'dropped');
  if (carrying.length === 0 || carrying.some((i) => i.status === 'draft')) return 'triaged';
  const shipped = carrying.every((i) => i.status === 'closed' && !i.unreleased);
  return shipped && failingOf(carrying).length === 0 ? 'resolved' : 'planned';
}

/** A planned item whose carrier shipped failing waits on a release that ships it passing. */
function shippedFailingWait(shippedFailing: readonly string[]): FeedbackWaitingOn {
  const failing = shippedFailing.join(', ');
  return wait(
    'issue',
    named(failing),
    say('standing.act.beResolved'),
    say('feedback.rule.shippedFailing', { failing }),
    { ref: shippedFailing[0]?.split(' ')[0] ?? null },
  );
}

/**
 * What a verified or declined item waits on: nothing, unless a carrier reopened since its verify
 * (ISS-1453), when it names the reopened carrier, the verdict standing (a person's verify is kept).
 */
export function settledWait(phase: string, reopened: readonly string[]): FeedbackWaitingOn {
  const keys = carriersPhrase(reopened);
  if (phase === 'verified' && keys) {
    return wait(
      'issue',
      keys,
      say('standing.act.beResolved'),
      say('feedback.rule.verifiedCarrierReopened', { carriers: reopened.join(', ') }),
      { ref: reopened[0] ?? null },
    );
  }
  return wait(
    'none',
    say('standing.who.nothing'),
    say('standing.act.none'),
    say('feedback.rule.nothingOwed', { phase }),
  );
}

/**
 * The carriers of a verified item that have reopened since (`ISS-372`, ISS-1453): the verdict was said
 * of work that is failing again, so the item may not read that nothing is owed. Only an issue route
 * has carriers to reopen; any other item, and any item not verified, reads none.
 */
export function reopenedCarriersIn(r: Row, l: Linked): string[] {
  if (r.status !== 'verified' || r.route !== 'issue') return [];
  return (l.routeIssues.get(r.id) ?? []).flatMap((id) => {
    const issue = l.issues.get(id);
    return issue?.status === 'reopen' ? [issue.key] : [];
  });
}
