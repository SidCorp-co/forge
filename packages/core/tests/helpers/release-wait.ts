// An issue's standing at the release gate, as the steward's tests feed it to the sweep and the doors.

import type { Said } from '@forge/contracts/said';
import type { ItemStanding } from '@forge/contracts/steward';

/** A sentence the fake read carries, by its registry key; nothing here renders it. */
const said = (key: string) => ({ key }) as unknown as Said;

/** An issue at the release gate, its release waiting on an approval, overdue. */
export function releaseWait(issue: { id: string; key: string }, basis: string): ItemStanding {
  const says = {
    who: said('issues.standing.who.release'),
    act: said('issues.standing.act.approveOnReleases'),
    rule: said('issues.rule.approval'),
  };
  return {
    subject: { kind: 'issue', id: issue.id, key: issue.key },
    title: 'issue',
    group: 'stuck',
    waitingOn: {
      kind: 'release',
      who: 'Release',
      act: 'Approve release on Releases',
      rule: 'the project asks a person to approve a release',
      ref: null,
      dueAt: '2026-10-19T00:00:00.000Z',
      says,
    },
    note: null,
    actClass: 'release_cut',
    since: '2026-10-15T00:00:00.000Z',
    dueAt: '2026-10-19T00:00:00.000Z',
    stuck: {
      code: 'overdue',
      since: '2026-10-19T00:00:00.000Z',
      reason: `${issue.key}'s release approval is overdue`,
      via: null,
      says: { reason: said('overdue') },
    },
    carriedBy: null,
    basis,
  };
}
