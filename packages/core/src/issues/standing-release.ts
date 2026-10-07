// Whose turn an issue at the release gate is: the master while a criterion no longer passes or its
// release note is unwritten, then the release itself, approved by a person where the project asks.

import type { IssueWaitingKind } from '@forge/contracts/issue-standing';
import { type Said, say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import type { IssueStandingInput, IssueWaitingOn, Turn } from './standing.js';

const wait = (kind: IssueWaitingKind, who: Said, act: Said, rule: Said): IssueWaitingOn =>
  waitingOn(kind, { who, act, rule });

const MASTER = say('standing.who.master');
const RELEASE = say('issues.standing.who.release');

export function releaseTurn(
  input: Pick<IssueStandingInput, 'criteria' | 'releaseApproval' | 'releaseNoted'>,
  running: boolean,
): Turn {
  const { total, passing } = input.criteria;
  if (passing < total) {
    return {
      group: 'stuck',
      waitingOn: wait(
        'master',
        MASTER,
        say('issues.standing.act.judgeAgain'),
        say('issues.rule.criteriaStale', { n: total - passing, total }),
      ),
    };
  }
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
