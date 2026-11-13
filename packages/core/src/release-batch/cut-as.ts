// Who may cut a release, and the cut as that person (REQ-79 r6 BC-17): the cut takes project.admin,
// and outside strict the project's master holds it too, so an agent alone takes a landed issue
// through the release that closes it. The REST route and a chat acting on the person's word
// (REQ-69 BC-3) both meet this one rule before `create.ts:createReleaseBatch`.

import { loadProjectAccess, type ProjectAccess } from '../lib/authz.js';
import { holds, masterActRefusal, requireMasterAct } from '../permissions/index.js';
import { readGateProfile } from '../project-config/index.js';
import { createReleaseBatch } from './create.js';
import type { ViewerFacts } from './release-view.js';

/** Throws the refusal naming why `userId` may not take release act `act` on the project. */
export async function requireReleaseActAs(
  projectId: string,
  userId: string,
  agency: 'human' | 'agent',
  act: string,
): Promise<void> {
  const access = await loadProjectAccess(projectId, userId);
  const ask = { agency, profile: await readGateProfile(projectId) };
  requireMasterAct(access, 'project.admin', ask, act);
}

/**
 * A release's reader as the cut door reads them (ISS-1232): `isAdmin` holds wherever
 * `requireReleaseActAs` lets them cut, the master's project.admin outside strict included, so a
 * release never tells the master it owes the cut and reads `can.cut: false` to it. An approval stays
 * the bare grant's: the master holds none (`release-view.ts:viewerDecides`).
 */
export async function releaseViewerOf(
  access: ProjectAccess,
  projectId: string,
  userId: string,
  agency: 'human' | 'agent',
): Promise<ViewerFacts> {
  const ask = { agency, profile: await readGateProfile(projectId) };
  return {
    userId,
    agency,
    isAdmin: masterActRefusal(access, 'project.admin', ask) === null,
    mayApprove: holds(access, 'releases.approve'),
  };
}

/** A person's cut of `issueIds`, as the release page's Cut button makes it. */
export async function cutReleaseAs(input: {
  projectId: string;
  userId: string;
  agency: 'human' | 'agent';
  issueIds: string[];
}): ReturnType<typeof createReleaseBatch> {
  await requireReleaseActAs(input.projectId, input.userId, input.agency, 'cutting a release');
  return createReleaseBatch({
    projectId: input.projectId,
    issueIds: input.issueIds,
    userId: input.userId,
  });
}
