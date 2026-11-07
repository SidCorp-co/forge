// Whose turn an issue at the release gate is: the project's judge while a criterion is no longer met,
// the master while its release note is unwritten, then the release itself, approved by a person where the project asks.

import type { IssueWaitingKind } from '@forge/contracts/issue-standing';
import { type Said, say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import type { IssueStandingInput, IssueWaitingOn, Turn } from './standing.js';

const wait = (kind: IssueWaitingKind, who: Said, act: Said, rule: Said): IssueWaitingOn =>
  waitingOn(kind, { who, act, rule });

const MASTER = say('standing.who.master');
const RELEASE = say('issues.standing.who.release');

/**
 * Who owes a criterion no longer met at the gate: the project's judge, as `strand-rules.ts:landedWait`
 * reads it. A judging run where the project judges independently, else the master, whose run records
 * its verdicts again at the landing. It is the judge's turn, queued, and the judge's clock says when
 * it is stuck (ISS-1072).
 */
function staleCriteriaTurn(input: Pick<IssueStandingInput, 'criteria' | 'judge'>): Turn {
  const { total, met } = input.criteria;
  const rule = say('issues.rule.criteriaStale', { n: total - met, total });
  return {
    group: 'queued',
    waitingOn:
      input.judge === 'independent'
        ? wait(
            'judge',
            say('issues.standing.who.nextRun'),
            say('issues.standing.act.judgeAgain'),
            rule,
          )
        : wait('master', MASTER, say('issues.standing.act.recordVerdictsAtLanding'), rule),
  };
}

export function releaseTurn(
  input: Pick<IssueStandingInput, 'criteria' | 'releaseApproval' | 'releaseNoted' | 'judge'>,
  running: boolean,
): Turn {
  const { total, met } = input.criteria;
  if (met < total) return staleCriteriaTurn(input);
  if (!input.releaseNoted) {
    return {
      group: 'queued',
      waitingOn: wait(
        'master',
        MASTER,
        say('standing.act.writeReleaseNote', { on: null }),
        say('issues.rule.noNote'),
      ),
    };
  }
  if (input.releaseApproval) {
    return {
      group: 'queued',
      waitingOn: wait(
        'release',
        RELEASE,
        say('issues.standing.act.approveOnReleases'),
        say('issues.rule.approval'),
      ),
    };
  }
  return running
    ? {
        group: 'moving',
        waitingOn: wait(
          'run',
          RELEASE,
          say('issues.standing.act.running'),
          say('issues.rule.releaseRunning'),
        ),
      }
    : {
        group: 'queued',
        waitingOn: wait(
          'release',
          RELEASE,
          say('issues.standing.act.nextRelease'),
          say('issues.rule.noApproval'),
        ),
      };
}
