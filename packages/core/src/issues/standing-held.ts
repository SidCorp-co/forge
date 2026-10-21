/**
 * The turns of an issue something else holds (`standing.ts:turnOf`): a live blocker first, worded as
 * waiting on its judge where its change landed or on a design where one holds it, and a takeable row
 * the dispatch door withholds, its refusal named. Both read `stuck`, and `withTimes` says `blocked`.
 */

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { ISSUE_RESOLVED_STATUSES } from '@forge/contracts/issue-machine';
import type { IssueWithheld, IssueWithheldCode } from '@forge/contracts/issue-standing';
import { type Said, say } from '@forge/contracts/said';
import { holdersWho, nobodyHoldsAct } from '@forge/contracts/standing';
import type { StandingEdge, Turn } from './standing.js';
import { wait } from './standing-wait.js';
import { landedWait } from './strand-rules.js';

const SETTLED: readonly string[] = ISSUE_RESOLVED_STATUSES;
const named = (name: string) => say('standing.who.named', { name });

export const awaitsJudge = (e: StandingEdge) => landedWait(e.status, e) !== null;

export function blockerAct(status: IssueStatus): Said {
  if (status === 'in_progress') return say('issues.standing.act.running');
  if (status === 'needs_info' || status === 'draft') return say('issues.standing.act.needsPerson');
  if (status === 'on_hold') return say('issues.standing.act.paused');
  if (status === 'reopen') return say('issues.standing.act.cameBack');
  return say('issues.standing.act.notStarted');
}

export function blockerTurn(blocker: StandingEdge): Turn {
  const design = SETTLED.includes(blocker.status) ? blocker.designHold : null;
  const judged = awaitsJudge(blocker);
  return {
    group: 'stuck',
    waitingOn: wait(
      'issue',
      named(blocker.key),
      design
        ? say('issues.standing.act.designApproval')
        : judged
          ? say('issues.standing.act.landedWaitsJudge')
          : blockerAct(blocker.status),
      design
        ? say('issues.rule.blockedDesign', { key: blocker.key, design })
        : judged
          ? say('issues.rule.blockedLanded', { key: blocker.key })
          : say('issues.rule.blocked', { key: blocker.key }),
      blocker.key,
    ),
  };
}

// the project document is declared by a holder of project.admin (`project-config/routes.ts`), so a
// policy refusal names them
const WITHHELD_ACT: Record<IssueWithheldCode, { who: Said | 'admins'; act: Said }> = {
  POLICY_UNDECLARED: { who: 'admins', act: say('issues.standing.act.declarePolicy') },
  POLICY_STATE_UNDECLARED: { who: 'admins', act: say('issues.standing.act.declarePolicyState') },
  WORKFLOW_DESIGN_NOT_APPROVED: {
    who: say('issues.standing.who.designApprover'),
    act: say('issues.standing.act.approveDesign'),
  },
  CONTRACT_WAIT_UNSETTLED: {
    who: say('issues.standing.who.contractProvider'),
    act: say('issues.standing.act.approveContract'),
  },
  PATTERN_REVIEW_PENDING: {
    who: say('issues.standing.who.patternReviewer'),
    act: say('issues.standing.act.decidePattern'),
  },
};

/** A takeable issue no master is handed: stuck, the dispatch door's refusal named as its rule. */
export function withheldTurn(withheld: IssueWithheld, admins: readonly string[]): Turn {
  const owed = WITHHELD_ACT[withheld.code];
  const nobody = owed.who === 'admins' && admins.length === 0;
  const who = owed.who === 'admins' ? holdersWho(admins) : owed.who;
  const act = nobody ? nobodyHoldsAct(owed.act, 'project.admin') : owed.act;
  return {
    group: 'stuck',
    waitingOn: wait(
      'person',
      who,
      act,
      say('issues.rule.withheld', { code: withheld.code, detail: withheld.detail }),
      withheld.code,
    ),
  };
}
