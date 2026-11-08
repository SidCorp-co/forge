/**
 * Whom a new or reopened feedback item's triage waits on (ISS-1132): placed by the one rule of who
 * owes an act (`@forge/contracts/who-owes:whoOwes`, `feedback.triage`) under the project's policy,
 * never by who holds feedback.approve or whether a master is live. The master's outside strict: on no
 * holder's Needs you, and with no master serving it reads stuck until the box's sweep, which counts it
 * as owed work (`owed-triage.ts:owedTriages`, `masters/verdict.ts`), places one. With no runner bound
 * no master ever comes, so a holder of the triage permission takes it, named (FB-77, FB-434). Strict
 * keeps it that holder's.
 */

import type { FeedbackPhase, FeedbackWaitingKind } from '@forge/contracts/feedback';
import { type Said, say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import type { Owed, StandingFacts, StandingViewer } from './standing.js';

const wait = (
  kind: FeedbackWaitingKind,
  who: Said,
  rule: Said,
  act: Said = say('standing.act.triageIt'),
  extra: { dueAt?: string | null } = {},
) => waitingOn(kind, { who, act, rule }, extra);

export const MASTER = say('standing.who.projectMaster');

/** Whether the project's master takes its triage now: the one rule gives it, and a runner is bound to serve it. */
export const masterTakesTriage = (facts: Pick<StandingFacts, 'masterTriages' | 'runnerBound'>) =>
  facts.masterTriages && facts.runnerBound !== false;

export function triageWait(
  phase: FeedbackPhase,
  viewer: StandingViewer,
  facts: StandingFacts,
): Owed {
  const router = say('standing.who.holderOf', { perm: viewer.routeAsks });
  const master = masterTakesTriage(facts);
  if (facts.snoozedUntil) {
    const act = say('feedback.act.triageAfterSnooze', { date: facts.snoozedUntil.slice(0, 10) });
    const rule = say('feedback.rule.snoozed', { phase, until: facts.snoozedUntil });
    return {
      wait: wait(master ? 'agent' : 'person', master ? MASTER : router, rule, act, {
        dueAt: facts.snoozedUntil,
      }),
      yours: false,
    };
  }
  if (master) {
    return {
      wait: wait('agent', MASTER, say('feedback.rule.masterOwes', { phase })),
      yours: false,
    };
  }
  const rule = facts.masterTriages
    ? say('feedback.rule.noRunner', { phase })
    : say('feedback.rule.triagerTriages', { phase });
  return { wait: wait('person', router, rule), yours: viewer.canRoute };
}
