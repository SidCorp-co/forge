/**
 * Which class of act a wait names (REQ-48 BC-5, `contracts/steward.ts:STANDING_ACT_CLASSES`): its kind
 * gives the class, and the few acts whose due differs from their kind's are named by key. The class
 * picks the default due of a wait that carries none of its own.
 */

import type { Said } from '@forge/contracts/said';
import type { WaitingKind, WaitingOn } from '@forge/contracts/standing';
import type { StandingActClass } from '@forge/contracts/steward';

const BY_KIND: Record<WaitingKind, StandingActClass> = {
  you: 'person_decide',
  person: 'person_decide',
  admins: 'person_decide',
  writers: 'person_decide',
  answer: 'person_decide',
  agent: 'master_take',
  master: 'master_take',
  run: 'run',
  judge: 'judge',
  issue: 'run',
  feedback: 'run',
  release: 'run',
  project: 'other',
  gate: 'other',
  machine: 'other',
  system: 'other',
  none: 'other',
};

const BY_KEY: Readonly<Record<string, StandingActClass>> = {
  'standing.act.breakDown': 'master_plan',
  'standing.act.breakDownBy': 'master_plan',
  'standing.act.replan': 'master_plan',
  'standing.act.reviseForDesign': 'master_plan',
  'standing.act.trace': 'master_plan',
  'standing.act.fileOrRevise': 'master_plan',
  'standing.act.retie': 'master_plan',
  'standing.act.fixFailing': 'master_plan',
  'standing.act.proposeDesign': 'master_plan',
  'standing.act.check': 'ba_check',
  // a draft parks work that never started: overdue only once it has sat as long as any other wait
  'issues.standing.act.takeOnOrDrop': 'other',
  // an issue waiting its turn in the master's queue: the queue has no clock (ISS-1072)
  'issues.standing.act.dispatch': 'queue',
  'issues.standing.act.buildNext': 'queue',
  'issues.standing.act.rerun': 'queue',
  'standing.act.takeNext': 'queue',
  'standing.act.cut': 'release_cut',
  'standing.act.cutCarrierRelease': 'release_cut',
  'standing.act.cutThenApprove': 'release_cut',
  'standing.act.cutWaiting': 'release_cut',
  'standing.act.approveReleaseV': 'release_cut',
  'standing.act.approveCarrierRelease': 'release_cut',
  'standing.act.releaseByHand': 'release_cut',
  'standing.act.releaseItByHand': 'release_cut',
  'issues.standing.act.approveOnReleases': 'release_cut',
  'standing.act.verifyFix': 'reporter',
  'standing.act.verifyFixIn': 'reporter',
  'standing.act.confirmAnswer': 'reporter',
  'standing.act.judgeCriteria': 'judge',
  'standing.act.judgeOn': 'judge',
  'standing.act.judgeOnRelease': 'judge',
  'standing.act.judgeOnReleaseOn': 'judge',
  'standing.act.uncounted': 'judge',
  'standing.act.recordRelease': 'release_cut',
  'standing.act.judgeReleaseOn': 'judge',
  'issues.standing.act.judgeAgain': 'judge',
  'issues.standing.act.recordVerdictsAtLanding': 'judge',
  'issues.standing.act.landedWaitsJudge': 'judge',
};

/** A requirement's wait on one of its issues names that issue's act inside its own. */
function innerAct(act: Said): Said {
  const inner = act.key === 'standing.act.onIssue' ? act.vars?.act : undefined;
  return inner && typeof inner === 'object' && 'key' in inner ? innerAct(inner) : act;
}

/**
 * An agent's draft waiting on its master to propose or drop it is in the master's queue, as a
 * dispatch is: never a fault (ISS-1072). The same act owed by a person (no runner bound, so a person
 * acts) keeps their decision's clock.
 */
const MASTER_QUEUE: ReadonlySet<string> = new Set([
  'standing.act.proposeOrDrop',
  'standing.act.reviseThenProposeOrDrop',
]);

export function actClassOf(w: Pick<WaitingOn, 'kind' | 'says'>): StandingActClass {
  const key = innerActKey(w);
  if (MASTER_QUEUE.has(key) && (w.kind === 'master' || w.kind === 'agent')) return 'queue';
  return BY_KEY[key] ?? BY_KIND[w.kind];
}

/** The key of the act a wait names, read through a requirement's wait on one of its issues. */
export function innerActKey(w: Pick<WaitingOn, 'says'>): string {
  return innerAct(w.says.act).key;
}
