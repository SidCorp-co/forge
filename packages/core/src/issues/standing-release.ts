// Whose turn an issue at the release gate is: the master while a criterion no longer passes or its
// release note is unwritten, then the release itself, approved by a person where the project asks.

import type { IssueWaitingKind } from '@forge/contracts/issue-standing';
import type { IssueStandingInput, IssueWaitingOn, Turn } from './standing.js';

const wait = (kind: IssueWaitingKind, who: string, act: string, rule: string): IssueWaitingOn => ({
  kind,
  who,
  act,
  rule,
  ref: null,
  dueAt: null,
});

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
        'Master',
        'judge it again',
        `${total - passing} of ${total} criteria have no verdict that passes now, such as one judged on a storefront draft the source has moved past or cannot read back; the release hold keeps it until a run judges them again`,
      ),
    };
  }
  if (!input.releaseNoted) {
    return {
      group: 'queued',
      waitingOn: wait(
        'master',
        'Master',
        'write the release note',
        "no release note: a release refuses to carry an issue without one (RELEASE_RECORD_MISSING), and writing it is the master's act, which it is told on its next pass",
      ),
    };
  }
  if (input.releaseApproval) {
    return {
      group: 'queued',
      waitingOn: wait(
        'release',
        'Release',
        'Approve release on Releases',
        'every criterion passed; this project requires a person to approve each release, once per release on Releases (Cut the version, then Approve release), never once per issue',
      ),
    };
  }
  return running
    ? { group: 'moving', waitingOn: wait('run', 'Release', 'running', 'a release run holds it') }
    : {
        group: 'queued',
        waitingOn: wait(
          'release',
          'Release',
          'next release',
          'every criterion passed; the project releases without an approval',
        ),
      };
}
