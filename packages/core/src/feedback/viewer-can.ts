/**
 * What a viewer may do to a project's feedback, read once per list or detail: the permissions its
 * standing and `can` ask, with what the project's master holds outside strict (REQ-79 r6 BC-11) and
 * whom the project's `approvals.triage` asks to route an item (ISS-639).
 */

import type { ActorAgency, ProjectPermission } from '@forge/contracts/permissions';
import { holds, masterFactsOf } from '../permissions/index.js';
import { personGateOf } from '../project-config/index.js';
import type { StandingViewer } from './standing.js';

/** The viewer's acts on this project's feedback, by the same checks a detail's `can` reads. */
export type ViewerCan = Omit<StandingViewer, 'isReporter'>;

type PermissionFacts = Parameters<typeof holds>[0];

/** `routeAsks` is what the project's `approvals.triage` asks of a router (`personGateOf`, ISS-639). */
export function viewerCanOf(facts: PermissionFacts, routeAsks: ProjectPermission): ViewerCan {
  return {
    canTriage: holds(facts, 'feedback.approve'),
    routeAsks,
    canRoute: holds(facts, routeAsks),
    canApproveRelease: holds(facts, 'releases.approve'),
    canWrite: holds(facts, 'project.write'),
    canAdmin: holds(facts, 'project.admin'),
  };
}

/** The viewer's acts, with what the project's master holds outside strict (REQ-79 r6 BC-11). */
export async function viewerCanIn(
  viewer: { userId: string; agency: ActorAgency },
  projectId: string,
): Promise<ViewerCan> {
  const [facts, gate] = await Promise.all([
    masterFactsOf(viewer.userId, projectId, viewer.agency),
    personGateOf(projectId, 'triage'),
  ]);
  return viewerCanOf(facts, gate.permission);
}
