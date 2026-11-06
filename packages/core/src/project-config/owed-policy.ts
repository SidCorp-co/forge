// The project's policy as `@forge/contracts/who-owes:whoOwes` reads it (ISS-1058): the switches by which
// a project turns a person's gate on, read by the readers each switch already has, so no surface reads
// a second flag. Its gate profile (`strict`), its person gates as that profile resolves them
// (`approvals.ts:readApprovals`) and `release.approval.required` (`release-path.ts:approvalRequired`).

import type { OwedPolicy } from '@forge/contracts/who-owes';
import { readApprovals } from './approvals.js';
import { readGateProfile } from './gates.js';
import { approvalRequired } from './release-path.js';

export async function readOwedPolicy(projectId: string): Promise<OwedPolicy> {
  const [profile, gates, releaseApproval] = await Promise.all([
    readGateProfile(projectId),
    readApprovals(projectId),
    approvalRequired(projectId),
  ]);
  return { strict: profile === 'strict', gates, releaseApproval };
}
