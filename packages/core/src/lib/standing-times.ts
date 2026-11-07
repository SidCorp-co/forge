/**
 * The times every slice's standing carries (REQ-48 BC-5, BC-8, BC-9; requirement-to-delivery r18
 * `expect-next` and `stuck`): since when its wait stands, when it falls due, whether it is stuck and
 * why, and the issue it was rolled up from. Pure over the slice's own turn and the facts given, so
 * the requirement, feedback and issue reads apply one rule and no screen computes its own.
 */

import { actTakenElsewhere, isDecisionAct } from '@forge/contracts/needs-you-decisions';
import { type Said, say, sayEn } from '@forge/contracts/said';
import type { StandingGroup, WaitingOn } from '@forge/contracts/standing';
import {
  basisFieldsOf,
  type MasterServing,
  STANDING_DUE_WORKING_DAYS,
  type StandingTimes,
  type StuckReading,
  standingBasisOf,
} from '@forge/contracts/steward';
import { actClassOf } from './standing-act-class.js';
import { addWorkingDays } from './working-days.js';

/** Groups the stuck rule leaves alone: work that ended, was put aside, or a person was told of. */
const RESTING: readonly StandingGroup[] = ['done', 'deferred', 'paused', 'closed'];
/** The `who` keys that name the project's master. */
const MASTER_WHO: ReadonlySet<string> = new Set([
  'standing.who.master',
  'standing.who.projectMaster',
]);

/** A live issue's stuck reading, rolled up into the item it carries. */
export interface Carried {
  key: string;
  stuck: StuckReading;
}

export interface TimesFacts {
  /** When the wait began, read from the records: a status move, a proposal, the carrier's own since. */
  since: Date;
  master: MasterServing;
  /** A requirement with no owner (requirement-to-delivery r18 `stuck`, no_owner). */
  ownerless?: boolean;
  /** The draft issue carrying the item, keyed, where one is (draft_carrier). */
  draftCarrier?: string | null;
  /** The live issue whose own stuck reading the item rolls up (BC-9). */
  carried?: Carried | null;
  /**
   * The wait is cleanup the audit reads in its window, not delivery (REQ-79 r6): a criterion's verdict
   * on a project whose release asks none. It falls due by no clock, so it never reads overdue.
   */
  cleanupOnly?: boolean;
  /**
   * The work it waits on is settled though its own group is not (ISS-1072): a feedback item that reads
   * resolved owes only its confirm, and one reported only from archived projects has nobody delivering.
   * It keeps its group and its wait, falls due by no clock and never reads stuck.
   */
  settled?: boolean;
  now: Date;
}

interface Turn<G extends StandingGroup> {
  group: G;
  waitingOn: WaitingOn;
}

const reading = (code: StuckReading['code'], since: Date, said: Said, via: string | null) => ({
  code,
  since: since.toISOString(),
  reason: sayEn(said),
  via,
  says: { reason: said },
});

function overdueOf(w: WaitingOn, f: TimesFacts, due: Date | null): StuckReading | null {
  if (!due || f.now.getTime() <= due.getTime()) return null;
  const date = due.toISOString().slice(0, 10);
  // an answer a wait names is owed by nobody it names: it was due, never "someone owed it"
  const said =
    w.kind === 'answer'
      ? say('standing.stuck.answerOverdue', { what: w.says.who, date })
      : say('standing.stuck.overdue', { who: w.says.who, date, act: w.says.act });
  return reading('overdue', due, said, null);
}

// first that holds wins (docs/proposals/steward-agent.md, "Stuck rule"); a person's decision is told
// to them, so it can only fall overdue
function stuckOf(turn: Turn<StandingGroup>, f: TimesFacts, due: Date | null): StuckReading | null {
  const w = turn.waitingOn;
  if (turn.group === 'needs_you') return overdueOf(w, f, due);
  if (f.ownerless) return reading('no_owner', f.since, say('standing.stuck.noOwner'), null);
  // a wait carried up from an issue reads as that issue's own reading, which already said who serves it
  if (f.carried) {
    const via = say('standing.stuck.via', {
      key: f.carried.key,
      reason: f.carried.stuck.says.reason,
    });
    return { ...f.carried.stuck, reason: sayEn(via), says: { reason: via }, via: f.carried.key };
  }
  if (w.kind === 'none') {
    return reading(
      'nobody_serves',
      f.since,
      say('standing.stuck.nobodyActs', { rule: w.says.rule }),
      null,
    );
  }
  if (
    (w.kind === 'master' || w.kind === 'agent') &&
    MASTER_WHO.has(w.says.who.key) &&
    f.master !== 'serves'
  ) {
    const said = say(
      f.master === 'none' ? 'standing.stuck.noMaster' : 'standing.stuck.masterSilent',
    );
    return reading('nobody_serves', f.since, said, null);
  }
  if (f.draftCarrier) {
    return reading(
      'draft_carrier',
      f.since,
      say('standing.stuck.draftCarrier', { key: f.draftCarrier }),
      f.draftCarrier,
    );
  }
  // the slice's own rule grouped it stuck: a live blocker or a dispatch refusal holds it
  if (turn.group === 'stuck') {
    return reading(
      'blocked',
      f.since,
      say('standing.stuck.blocked', { who: w.says.who, rule: w.says.rule }),
      null,
    );
  }
  return overdueOf(w, f, due);
}

/**
 * The turn with its times: grouped `stuck` where the stuck rule holds (a `needs_you` row keeps its
 * group, the person is told; a resting one is never stuck), and the basis a steward note is vetted
 * against. A `needs_you` row that names the viewer (`waitingOn.kind: you`) stays theirs whatever its
 * act, so a triage the list says they owe is on their Needs you, which lists it beside the decisions
 * by why it is no one-click decision (ISS-924). One that asks no person's decision and names someone
 * else, or an act another record lists (`actTakenElsewhere`: an issue's act, a release's cut), moves
 * to `notDecision`, and the stuck rule reads it like any other wait (BC-11).
 */
export function withTimes<G extends StandingGroup>(
  given: Turn<G>,
  f: TimesFacts,
  notDecision: G,
): { group: G | 'stuck'; times: StandingTimes } {
  const act = given.waitingOn.says.act;
  const elsewhere = given.waitingOn.kind !== 'you' || actTakenElsewhere(act);
  const turn =
    given.group === 'needs_you' && elsewhere && !isDecisionAct(act)
      ? { ...given, group: notDecision }
      : given;
  const resting = RESTING.includes(turn.group) || f.settled === true;
  const actClass = actClassOf(turn.waitingOn);
  const own = turn.waitingOn.dueAt ? new Date(turn.waitingOn.dueAt) : null;
  const days = STANDING_DUE_WORKING_DAYS[actClass];
  const due =
    resting || f.cleanupOnly
      ? null
      : (own ?? (days === null ? null : addWorkingDays(f.since, days)));
  const stuck = resting ? null : stuckOf(turn, f, due);
  const group = stuck && turn.group !== 'needs_you' ? 'stuck' : turn.group;
  const times = {
    actClass,
    since: f.since.toISOString(),
    dueAt: due?.toISOString() ?? null,
    stuck,
    carriedBy: f.carried?.key ?? null,
  };
  const basis = standingBasisOf(basisFieldsOf({ ...times, group, waitingOn: turn.waitingOn }));
  return { group, times: { ...times, basis } };
}
