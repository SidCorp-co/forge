// Who may cut a release, and the cut as that person (REQ-79 r6 BC-17): the cut takes project.admin,
// and outside strict the project's master holds it too, so an agent alone takes a landed issue
// through the release that closes it. The REST route and a chat acting on the person's word
// (REQ-69 BC-3) both meet this one rule before `create.ts:createReleaseBatch`.

import { loadProjectAccess } from '../lib/authz.js';
import { requireMasterAct } from '../permissions/index.js';
import { readGateProfile } from '../project-config/index.js';
import { createReleaseBatch } from './create.js';

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
