// What the viewer of a requirement may do, read once per read and handed to its standing and its acts.

import { ISSUE_ADMIT_PERMISSION } from '@forge/contracts/issue-machine';
import { permissionFactsOf, permissionRefusal } from '../permissions/index.js';
import { personGateOf } from '../project-config/index.js';
import type { RequirementActor } from './read.js';
import { signoffRefusal } from './rules.js';

/**
 * Sign off (requirements.approve), admit a draft issue (issues.admit), accept a breakdown where its
 * switch asks a person (suggestions.approve), and move or accept the delivery: what the project's
 * `approvals.accept` asks, which is requirements.approve where it is on and project.write where off.
 */
export async function standingViewer(viewer: RequirementActor | null, projectId: string) {
  if (!viewer) return null;
  const [facts, accept] = await Promise.all([
    permissionFactsOf(viewer.userId, projectId),
    personGateOf(projectId, 'accept'),
  ]);
  return {
    userId: viewer.userId,
    canSignOff: signoffRefusal(facts, 'a sign-off') === null,
    canAccept: signoffRefusal(facts, accept.act, accept.permission) === null,
    canAdmit: permissionRefusal(facts, ISSUE_ADMIT_PERMISSION) === null,
    canApproveBreakdown: permissionRefusal(facts, 'suggestions.approve') === null,
  };
}
