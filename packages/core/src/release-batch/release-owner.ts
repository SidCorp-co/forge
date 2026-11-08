// Who a release reads as owed to, and what they last did: its latest approval's decider, else who
// asked it, else who cut it. Forge's own cut acts for the project's owner, who pressed nothing, so a
// cut or an approval ask on an automatic run names no person (ISS-1153).

import type { ReleasePerson } from '@forge/contracts/releases';
import type { ApprovalView } from './approvals.js';
import type { ReleaseCutter } from './release-facts.js';

export interface ReleaseOwner {
  owner: ReleasePerson | null;
  act: string | null;
}

export function releaseOwnerOf(
  approvals: readonly ApprovalView[],
  runId: string | null,
  cutters: ReadonlyMap<string, ReleaseCutter>,
): ReleaseOwner {
  const latest = approvals[0];
  if (latest?.decision && latest.decidedBy) {
    return {
      owner: latest.decidedBy,
      act: latest.decision === 'approved' ? 'Approved' : 'Returned',
    };
  }
  if (latest) {
    return cutters.get(latest.runId)?.as === 'automatic'
      ? { owner: null, act: 'Asked for approval automatically' }
      : { owner: latest.requestedBy, act: 'Asked for approval' };
  }
  const cutter = runId ? cutters.get(runId) : undefined;
  if (cutter?.as === 'automatic') return { owner: null, act: 'Cut automatically' };
  return cutter ? { owner: cutter.person, act: 'Cut' } : { owner: null, act: null };
}
