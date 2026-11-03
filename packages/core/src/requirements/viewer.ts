// What the viewer of a requirement may do, read once per read and handed to its standing and its acts.

import { masterFactsOf, permissionRefusal } from '../permissions/index.js';
import { personGateOf } from '../project-config/index.js';
import type { RequirementActor } from './read.js';
import { signoffRefusal } from './rules.js';

/**
 * Write (project.write, what the owner's own move and a draft revision's author ask, ISS-926), sign off
 * (requirements.approve), accept a breakdown where its
 * switch asks a person (suggestions.approve), and move or accept the delivery: what the project's
 * `approvals.accept` asks, which is requirements.approve where it is on and project.write where off.
 */
export async function standingViewer(viewer: RequirementActor | null, projectId: string) {
  if (!viewer) return null;
  const [facts, accept] = await Promise.all([
    masterFactsOf(viewer.userId, projectId, viewer.agency),
    personGateOf(projectId, 'accept'),
  ]);
  return {
    userId: viewer.userId,
    canWrite: permissionRefusal(facts, 'project.write') === null,
    canSignOff: signoffRefusal(facts, 'a sign-off') === null,
    canAccept: signoffRefusal(facts, accept.act, accept.permission) === null,
    canApproveBreakdown: permissionRefusal(facts, 'suggestions.approve') === null,
  };
}
